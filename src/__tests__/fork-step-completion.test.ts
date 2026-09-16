import { describe, it, expect } from 'vitest';
import type { WorkflowStep } from '../core/models/index.js';
import {
  renderCompletionContract,
  resolveSubmittedCompletion,
} from '../features/tasks/fork/stepCompletion.js';
import { makeStep } from './engine-test-helpers.js';

const SCHEMA = {
  type: 'object',
  properties: { outcome: { type: 'string', enum: ['again', 'onward'] } },
  required: ['outcome'],
  additionalProperties: false,
} as const;

/** A step routing on labels, the shape a conductor judges. */
function taggedStep(): WorkflowStep {
  return makeStep('ask', {
    rules: [
      { condition: { kind: 'semantic', label: 'needs another pass' }, next: 'ask' },
      { condition: { kind: 'semantic', label: 'ready to review' }, next: 'review' },
    ],
  } as Partial<WorkflowStep>);
}

/** A step routing on its own validated output, the shape `consult` uses. */
function structuredStep(): WorkflowStep {
  return makeStep('ask', {
    structuredOutput: { schemaRef: 'ask', schema: SCHEMA as unknown as Record<string, unknown> },
    rules: [
      { condition: { kind: 'when', expression: 'structured.ask.outcome == "again"' }, next: 'ask' },
      { condition: { kind: 'when', expression: 'structured.ask.outcome == "onward"' }, next: 'review' },
    ],
  } as Partial<WorkflowStep>);
}

describe('renderCompletionContract', () => {
  // The rules are what the result will actually be routed by, so the contract
  // shows them as authored rather than paraphrasing them.
  it('should mirror the step\'s rules as YAML', () => {
    const contract = renderCompletionContract(taggedStep(), 'en');

    expect(contract).toContain([
      '```yaml',
      'rules:',
      '  - condition: needs another pass',
      '    next: ask',
      '  - condition: ready to review',
      '    next: review',
      '```',
    ].join('\n'));
  });

  it('should mirror a when() condition and a pausing transition too', () => {
    const step = makeStep('ask', {
      rules: [{
        condition: { kind: 'when', expression: 'structured.ask.outcome == "again"' },
        next: 'ask',
        requiresUserInput: true,
      }],
    } as Partial<WorkflowStep>);

    expect(renderCompletionContract(step, 'en')).toContain([
      '  - condition: "when(structured.ask.outcome == \\"again\\")"',
      '    next: ask',
      '    requires_user_input: true',
    ].join('\n'));
  });

  it('should name every tag a labelled step can end with', () => {
    const contract = renderCompletionContract(taggedStep(), 'en');

    expect(contract).toContain('| 1 | needs another pass | `[ASK:1]` |');
    expect(contract).toContain('| 2 | ready to review | `[ASK:2]` |');
    expect(contract).toContain('- `[ASK:2]` — ready to review');
  });

  // A step that routes on its own output has no tag to emit, and an empty
  // criteria table would read as a contract with nothing in it.
  it('should give a structured step its schema under its own heading, with no tag', () => {
    const contract = renderCompletionContract(structuredStep(), 'en');

    expect(contract).toContain('### Structured Output');
    expect(contract).toContain('"outcome"');
    expect(contract).toContain('there is no tag to emit');
    expect(contract).not.toContain('| # | Condition | Tag |');
  });

  it('should say so when a step has no rules at all', () => {
    const contract = renderCompletionContract(makeStep('lone'), 'en');

    expect(contract).toContain('declares no transition rules');
    expect(contract).not.toContain('```yaml');
  });
});

describe('resolveSubmittedCompletion, given a named step', () => {
  it('should move to a step the rules list, without a tag', () => {
    expect(resolveSubmittedCompletion(taggedStep(), 'review'))
      .toEqual({ kind: 'next', nextStep: 'review' });
  });

  // Naming a step is a decision already taken; there is nothing left for the
  // schema to check. This is the way past a step that really completes by
  // structured output when you have no output to give it.
  it('should move a structured step without asking for its structured output', () => {
    expect(resolveSubmittedCompletion(structuredStep(), 'review'))
      .toEqual({ kind: 'next', nextStep: 'review' });
  });

  it('should carry the pause of the rule that names the step', () => {
    const step = makeStep('ask', {
      rules: [{
        condition: { kind: 'semantic', label: 'ask the human' },
        next: 'review',
        requiresApproval: true,
      }],
    } as Partial<WorkflowStep>);

    expect(resolveSubmittedCompletion(step, 'review'))
      .toEqual({ kind: 'next', nextStep: 'review', pauses: true });
  });

  it('should refuse a step the rules do not list', () => {
    const resolution = resolveSubmittedCompletion(taggedStep(), 'deploy');

    expect(resolution.kind).toBe('refused');
    expect(resolution.kind === 'refused' && resolution.reason).toContain('ask, review');
  });

  // The whole point of the escape hatch is that it is deliberate. A step with a
  // single rule must not be walked into by submitting anything at all.
  it('should not move a single-rule step on a result that routes nothing', () => {
    const step = makeStep('ask', {
      rules: [{ condition: { kind: 'semantic', label: 'done' }, next: 'review' }],
    } as Partial<WorkflowStep>);

    expect(resolveSubmittedCompletion(step, 'Finished the work.').kind).toBe('refused');
  });
});

describe('resolveSubmittedCompletion', () => {
  it('should follow the tag a labelled step was completed with', () => {
    expect(resolveSubmittedCompletion(taggedStep(), 'Done here.\n\n[ASK:2]'))
      .toEqual({ kind: 'next', nextStep: 'review' });
  });

  it('should refuse a result carrying no tag the step knows', () => {
    const resolution = resolveSubmittedCompletion(taggedStep(), 'Done here.');

    expect(resolution.kind).toBe('refused');
    expect(resolution.kind === 'refused' && resolution.reason).toContain('[ASK:N]');
  });

  // The submitted output is filed under the step's own name, which is the key
  // the engine files a structured output under - so the workflow's own
  // `when(structured.ask...)` rules evaluate for real rather than being refused.
  it('should route a structured step on the result it was given', () => {
    expect(resolveSubmittedCompletion(structuredStep(), '{"outcome":"onward"}'))
      .toEqual({ kind: 'next', nextStep: 'review' });
    expect(resolveSubmittedCompletion(structuredStep(), '{"outcome":"again"}'))
      .toEqual({ kind: 'next', nextStep: 'ask' });
  });

  it('should refuse a result that is not the JSON the step promised', () => {
    const resolution = resolveSubmittedCompletion(structuredStep(), 'plain prose');

    expect(resolution.kind).toBe('refused');
    expect(resolution.kind === 'refused' && resolution.reason).toContain('must be JSON');
  });

  it('should refuse JSON the step\'s schema rejects', () => {
    const resolution = resolveSubmittedCompletion(structuredStep(), '{"outcome":"sideways"}');

    expect(resolution.kind).toBe('refused');
    expect(resolution.kind === 'refused' && resolution.reason)
      .toContain('structured output schema');
  });

  // COMPLETE is a terminal sentinel, not a step a pointer can rest on.
  it('should treat a route to COMPLETE as an ending, not a move', () => {
    const step = makeStep('ask', {
      rules: [{ condition: { kind: 'semantic', label: 'finished' }, next: 'COMPLETE' }],
    } as Partial<WorkflowStep>);

    expect(resolveSubmittedCompletion(step, '[ASK:1]')).toEqual({
      kind: 'terminal',
      reason: 'The result routes to COMPLETE, which ends the workflow rather than moving to a step.',
    });
  });

  it('should report a transition the engine would pause on', () => {
    const step = makeStep('ask', {
      rules: [{
        condition: { kind: 'semantic', label: 'ask the human' },
        next: 'ask',
        requiresUserInput: true,
      }],
    } as Partial<WorkflowStep>);

    expect(resolveSubmittedCompletion(step, '[ASK:1]'))
      .toEqual({ kind: 'next', nextStep: 'ask', pauses: true });
  });

  it('should refuse a step with no rules to route by', () => {
    const resolution = resolveSubmittedCompletion(makeStep('lone'), 'anything');

    expect(resolution.kind).toBe('refused');
    expect(resolution.kind === 'refused' && resolution.reason).toContain('no transition rules');
  });

  // These read how a parallel step's children finished. There are no children
  // outside a run, and the evaluator answers false rather than failing, which
  // would silently skip the rule.
  it('should refuse a step routing on an aggregate', () => {
    const step = makeStep('fan', {
      rules: [{
        condition: {
          kind: 'aggregate',
          aggregate: 'all',
          targetConditions: [{ kind: 'semantic', label: 'approved' }],
        },
        next: 'next',
      }],
    } as Partial<WorkflowStep>);

    const resolution = resolveSubmittedCompletion(step, '[FAN:1]');

    expect(resolution.kind).toBe('refused');
    expect(resolution.kind === 'refused' && resolution.reason).toContain('parallel children');
  });

  // A rule may read state this command genuinely does not have. Reporting the
  // reference beats resolving it to nothing and taking the wrong branch.
  it('should refuse a rule reaching for state the result cannot supply', () => {
    const step = makeStep('ask', {
      rules: [{ condition: { kind: 'when', expression: 'structured.other.flag == true' }, next: 'x' }],
    } as Partial<WorkflowStep>);

    const resolution = resolveSubmittedCompletion(step, 'anything');

    expect(resolution.kind).toBe('refused');
    expect(resolution.kind === 'refused' && resolution.reason).toContain('could not be routed');
  });
});
