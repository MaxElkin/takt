import { describe, it, expect, vi } from 'vitest';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/workflow/evaluation/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/evaluation/index.js')>();
  const { MockRuleEvaluator } = await import('./rule-evaluator-test-double.js');
  return {
    ...actual,
    RuleEvaluator: MockRuleEvaluator,
  };
});

vi.mock('../core/workflow/phase-runner.js', () => ({
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ label: '', method: 'auto_select' }),
}));

import type { WorkflowConfig, WorkflowState, WorkflowStep } from '../core/models/index.js';
import { createInitialState } from '../core/workflow/engine/state-manager.js';
import { runSingleWorkflowIteration, runWorkflowToCompletion } from '../core/workflow/engine/WorkflowRunLoop.js';
import type { QualityGateRunResult, RunQualityGatesOptions } from '../core/workflow/quality-gates/types.js';
import { makeResponse, makeRule, makeStep } from './engine-test-helpers.js';
import { createWorkflowRunLoopTestContract } from './test-helpers.js';

type RunQualityGatesFn = (options: RunQualityGatesOptions) => Promise<QualityGateRunResult>;

function makeConfig(step: WorkflowStep): WorkflowConfig {
  return {
    name: 'approval-workflow',
    description: 'Approval workflow',
    maxSteps: 5,
    initialStep: step.name,
    steps: [step],
  };
}

function makeDeps(
  state: WorkflowState,
  step: WorkflowStep,
  runStep: ReturnType<typeof vi.fn>,
  runQualityGates: RunQualityGatesFn,
) {
  const config = makeConfig(step);
  return {
    state,
    options: { projectCwd: '/worktree' },
    getWorkflowName: () => 'approval-workflow',
    getCwd: () => '/worktree',
    getMaxSteps: () => 5,
    getReportDir: () => '/worktree/.takt/runs/test/reports',
    abortRequested: () => false,
    getStep: () => step,
    applyRuntimeEnvironment: vi.fn(),
    loopDetectorCheck: () => ({ count: 1, isLoop: false }),
    cycleDetectorRecordAndCheck: () => ({ triggered: false, cycleCount: 0 }),
    resolveDoneTransition: vi.fn(() => ({ nextStep: 'COMPLETE', commandGates: 'required' as const })),
    runLoopMonitorJudge: vi.fn(),
    runStep,
    runQualityGates,
    buildInstruction: vi.fn((_step: WorkflowStep, stepIteration: number) => `instruction ${stepIteration}`),
    buildPhase1Instruction: vi.fn((_step: WorkflowStep, instruction: string) => instruction),
    prepareNormalStepExecution: vi.fn(async () => undefined),
    resolveStepProviderModel: vi.fn(() => ({
      provider: undefined,
      model: undefined,
    })),
    resolveStepProviderModelBeforeAutoRouting: vi.fn(() => ({
      provider: undefined,
      model: undefined,
    })),
    resolveRuntimeForStep: vi.fn(),
    addUserInput: vi.fn(),
    emit: vi.fn(),
    updateMaxSteps: vi.fn(),
    checkCompletionGate: vi.fn(() => ({ ok: true as const })),
    checkReturnValueGate: vi.fn(() => ({ ok: true as const })),
    persistPreviousResponseSnapshot: vi.fn((targetState: WorkflowState, stepName: string, stepIteration: number, content: string) => {
      targetState.previousResponseSourcePath = `.takt/runs/test/context/previous_responses/${stepName}.${stepIteration}.snapshot.md`;
      targetState.lastOutput = {
        persona: stepName,
        status: 'done',
        content,
        timestamp: new Date(),
      };
    }),
    ...createWorkflowRunLoopTestContract(config, state, 'test task'),
  };
}

describe('WorkflowRunLoop approval gate (fork)', () => {
  it.each([
    ['full workflow', runWorkflowToCompletion],
    ['single iteration', runSingleWorkflowIteration],
  ] as const)('does not require interactive runtime for an interactive-only approval in %s', async (
    _label,
    run,
  ) => {
    const step = makeStep('review', {
      rules: [makeRule('approved', 'COMPLETE', {
        requiresApproval: true,
        interactiveOnly: true,
      })],
    });
    const state = createInitialState(makeConfig(step), { projectCwd: '/worktree' });
    const runStep = vi.fn(async () => ({
      response: makeResponse({ persona: 'review', content: 'approved' }),
      instruction: 'review',
    }));
    const deps = makeDeps(
      state,
      step,
      runStep,
      vi.fn(async () => ({ ok: true as const })),
    );

    await run(deps);

    expect(runStep).toHaveBeenCalledOnce();
  });
});
