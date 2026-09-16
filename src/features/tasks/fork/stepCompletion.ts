/**
 * Fork: what finishing a step outside TAKT means.
 *
 * `takt task instruction --complete` has two halves, and both are built from
 * the engine's own pieces rather than from a second description of them:
 *
 * - The contract, printed when no result is supplied: the step's `rules:` as
 *   authored, the same tag list Phase 3 puts in front of the judge, and the
 *   step's structured output schema when it declares one.
 * - The resolution, when a result is supplied: the tag is read by
 *   `detectCandidateIndex`, matched by `RuleEvaluator`, and turned into a next
 *   step by `determineRuleTransition` - the three the engine itself uses.
 *
 * A result that names one of the rules' own `next` steps is honoured as given,
 * ahead of all of that: naming a step is a decision already taken, so there is
 * no schema to satisfy and no rule to match. It is how a step that really
 * completes by structured output gets moved past by hand. Nothing else moves a
 * task: with neither a named step nor a result the rules can route, the pointer
 * stays put, even where only one rule could ever have matched. Routing a task
 * somewhere it was never judged to go is worse than refusing to route it.
 *
 * A `when(...)` rule is evaluated for real, not refused: the state it reads is
 * seeded with the submitted result under this step's own name, which is the
 * key `StepExecutor` files a structured output under. That is what makes the
 * command useful for the workflows that actually route this way -
 * `when(structured.<step>.outcome == "...")` is the common shape. A rule
 * reaching for anything else - another step's output, a system context, an
 * aggregate over parallel children - has nothing to read outside a run and is
 * refused by name rather than evaluated against an invented state.
 */

import type {
  Language,
  WorkflowRule,
  WorkflowState,
  WorkflowStep,
} from '../../../core/models/index.js';
import {
  formatWorkflowRuleCondition,
  hasAggregateCondition,
  semanticRuleCandidatesOf,
} from '../../../core/models/workflow-rule-condition.js';
import { RuleEvaluator, type SemanticSelection } from '../../../core/workflow/evaluation/index.js';
import { ABORT_STEP, COMPLETE_STEP } from '../../../core/workflow/constants.js';
import { determineRuleTransition } from '../../../core/workflow/engine/transitions.js';
import { validateStructuredOutputAgainstSchema } from '../../../core/workflow/engine/structured-output-schema-validator.js';
import { generateStatusRulesComponents } from '../../../core/workflow/instruction/status-rules.js';
import { detectCandidateIndex } from '../../../shared/utils/ruleIndex.js';
import { getErrorMessage } from '../../../shared/utils/error.js';

/** A step is completed non-interactively, so interactive-only rules are out. */
const INTERACTIVE = false;

/**
 * The state the rules are evaluated against: the submitted structured output,
 * filed under this step's name exactly as `StepExecutor` files it. Everything
 * else is empty, so a rule reaching further throws and is reported instead of
 * quietly resolving to nothing.
 */
function submittedState(
  step: WorkflowStep,
  structured: Record<string, unknown> | undefined,
): WorkflowState {
  const structuredOutputs = new Map<string, Record<string, unknown>>();
  if (structured !== undefined) {
    structuredOutputs.set(step.name, structured);
  }
  return {
    workflowName: '',
    currentStep: step.name,
    iteration: 1,
    stepOutputs: new Map(),
    structuredOutputs,
    systemContexts: new Map(),
    effectResults: new Map(),
    userInputs: [],
    personaSessions: new Map(),
    stepIterations: new Map(),
    restoredStepIterationNames: new Set(),
    dynamicParallelSelections: new Map(),
    dynamicFacetSelections: new Map(),
    status: 'running',
  };
}

/** Quote a YAML scalar only where leaving it bare would change its meaning. */
function yamlScalar(value: string): string {
  return /^\s|\s$|[:#'"[\]{}|>&*!%@`,]/.test(value) || value.length === 0
    ? JSON.stringify(value)
    : value;
}

/** The step's `rules:` as authored, so the contract and the YAML cannot disagree. */
function renderRulesYaml(rules: readonly WorkflowRule[]): string {
  const lines = ['rules:'];
  for (const rule of rules) {
    lines.push(`  - condition: ${yamlScalar(formatWorkflowRuleCondition(rule.condition))}`);
    if (rule.next !== undefined) lines.push(`    next: ${yamlScalar(rule.next)}`);
    if (rule.returnValue !== undefined) lines.push(`    return: ${yamlScalar(rule.returnValue)}`);
    if (rule.requiresUserInput === true) lines.push('    requires_user_input: true');
    if (rule.requiresApproval === true) lines.push('    requires_approval: true');
    if (rule.interactiveOnly === true) lines.push('    interactive_only: true');
  }
  return lines.join('\n');
}

/**
 * What the step owes when it finishes: the rules it will be routed by, the tag
 * to emit where one is needed, and the shape of the response when the step
 * declares a structured output.
 */
export function renderCompletionContract(step: WorkflowStep, language: Language): string {
  const rules = step.rules ?? [];
  const candidates = semanticRuleCandidatesOf(rules, INTERACTIVE);
  const sections: string[] = ['## Completion', '', '### Rules', ''];

  if (rules.length === 0) {
    sections.push('This step declares no transition rules.');
  } else {
    sections.push('```yaml', renderRulesYaml(rules), '```');
  }

  if (candidates.length > 0) {
    const components = generateStatusRulesComponents(step.name, candidates, language);
    sections.push('', components.criteriaTable, '', components.outputList);
    if (components.hasAppendix) {
      sections.push('', components.appendixContent);
    }
  } else if (rules.length > 0) {
    // Nothing is judged by label here: the rules read the step's own output, so
    // a tag would be noise and emitting one would not route anything.
    sections.push('', 'These rules are deterministic; there is no tag to emit.');
  }

  if (step.structuredOutput !== undefined) {
    sections.push(
      '',
      '### Structured Output',
      '',
      'Your response must be JSON validating against this schema:',
      '',
      '```json',
      JSON.stringify(step.structuredOutput.schema, null, 2),
      '```',
    );
  }

  return sections.join('\n');
}

/**
 * The steps a result may name to move the task there. The terminal sentinels
 * are left out: naming one is understood, but it ends the workflow rather than
 * moving anywhere, so it is not offered as a way to move.
 */
export function ruleTargetsOf(step: WorkflowStep): readonly string[] {
  const targets = (step.rules ?? [])
    .map((rule) => rule.next)
    .filter((next): next is string =>
      next !== undefined && next !== COMPLETE_STEP && next !== ABORT_STEP);
  return [...new Set(targets)];
}

export type CompletionResolution =
  /** The result was accepted and names the step to move to. */
  | {
      readonly kind: 'next';
      readonly nextStep: string;
      /** The engine would have stopped for a human on this transition. */
      readonly pauses?: boolean;
    }
  /** The result was accepted but ends the step's workflow rather than continuing. */
  | { readonly kind: 'terminal'; readonly reason: string }
  /** The result was not accepted, or cannot be resolved outside a run. */
  | { readonly kind: 'refused'; readonly reason: string };

/** Every refusal ends by naming the way past it, since one always exists. */
function namingHint(step: WorkflowStep): string {
  const targets = ruleTargetsOf(step);
  return targets.length === 0
    ? ''
    : ` Name a step outright to move there anyway: ${targets.join(', ')}.`;
}

/** COMPLETE and ABORT end a workflow; neither is a step a pointer can rest on. */
function terminalSentinel(nextStep: string): CompletionResolution | undefined {
  return nextStep === COMPLETE_STEP || nextStep === ABORT_STEP
    ? {
        kind: 'terminal',
        reason: `The result routes to ${nextStep}, which ends the workflow rather than moving to a step.`,
      }
    : undefined;
}

type StructuredResult =
  | { readonly ok: true; readonly value?: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string };

function readStructuredResult(step: WorkflowStep, output: string): StructuredResult {
  if (step.structuredOutput === undefined) {
    return { ok: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    return {
      ok: false,
      reason: `The step declares a structured output, so the result must be JSON: ${getErrorMessage(error)}`,
    };
  }
  try {
    validateStructuredOutputAgainstSchema(
      parsed,
      step.structuredOutput.validationSchema ?? step.structuredOutput.schema,
    );
  } catch (error) {
    return {
      ok: false,
      reason: `The result does not satisfy the step's structured output schema: ${getErrorMessage(error)}`,
    };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/**
 * Read a submitted result the way the engine reads a finished step's response,
 * and answer where the task goes next.
 */
export function resolveSubmittedCompletion(
  step: WorkflowStep,
  output: string,
): CompletionResolution {
  // A step named outright is a decision already taken, so it is honoured as
  // given: no schema to satisfy, no rule to match, no tag to read. This is how
  // a step whose real completion is a structured output is moved past by hand.
  const named = (step.rules ?? []).find((rule) => rule.next === output.trim());
  if (named?.next !== undefined) {
    return terminalSentinel(named.next) ?? {
      kind: 'next',
      nextStep: named.next,
      ...(named.requiresUserInput === true || named.requiresApproval === true
        ? { pauses: true }
        : {}),
    };
  }

  const structured = readStructuredResult(step, output);
  if (!structured.ok) {
    // A result that is neither a step this step routes to nor the JSON it owes
    // most often means a step name was misspelled, so say which ones exist.
    return { kind: 'refused', reason: `${structured.reason}${namingHint(step)}` };
  }

  const rules = step.rules;
  if (rules === undefined || rules.length === 0) {
    return {
      kind: 'refused',
      reason: `Step "${step.name}" declares no transition rules, so no next step can be computed.`,
    };
  }
  // An aggregate reads how a parallel step's children finished. A step
  // completed by hand has no children, and the evaluator answers false rather
  // than failing, which would silently skip the rule.
  if (rules.some((rule) => hasAggregateCondition(rule.condition))) {
    return {
      kind: 'refused',
      reason: `Step "${step.name}" routes on how its parallel children finished, which exists `
        + `only inside a run.${namingHint(step)}`,
    };
  }

  // A step whose rules are all deterministic emits no tag: its own output is
  // the decision. Only a labelled rule needs one.
  const candidates = semanticRuleCandidatesOf(rules, INTERACTIVE);
  let selection: SemanticSelection | undefined;
  if (candidates.length > 0) {
    const label = candidates[detectCandidateIndex(output, step.name)]?.label;
    if (label === undefined) {
      return {
        kind: 'refused',
        reason: `The result carries no \`[${step.name.toUpperCase()}:N]\` tag naming one of the `
          + `${candidates.length} labelled rules of step "${step.name}".${namingHint(step)}`,
      };
    }
    // The tag was read out of a response rather than judged, which is what
    // `phase3_tag` records everywhere else in the engine.
    selection = { label, method: 'phase3_tag' };
  }

  let match;
  try {
    match = new RuleEvaluator(step, {
      state: submittedState(step, structured.value),
      interactive: INTERACTIVE,
    }).evaluate(selection);
  } catch (err) {
    return {
      kind: 'refused',
      reason: `Step "${step.name}" could not be routed from the result alone: ${getErrorMessage(err)}`,
    };
  }
  if (match === undefined) {
    return { kind: 'refused', reason: `No rule of step "${step.name}" matched the result.` };
  }

  const transition = determineRuleTransition(step, match.index);
  const nextStep = transition?.nextStep;
  if (nextStep === undefined) {
    return {
      kind: 'terminal',
      reason: transition?.returnValue === undefined
        ? `Step "${step.name}" ends its workflow here; there is no next step to move to.`
        : `Step "${step.name}" returns "${transition.returnValue}" to the calling workflow, `
          + 'a transition only the engine can take.',
    };
  }
  const sentinel = terminalSentinel(nextStep);
  if (sentinel !== undefined) {
    return sentinel;
  }
  return {
    kind: 'next',
    nextStep,
    ...(transition?.requiresUserInput === true || transition?.requiresApproval === true
      ? { pauses: true }
      : {}),
  };
}
