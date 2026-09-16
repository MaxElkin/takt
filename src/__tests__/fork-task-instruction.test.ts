import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  mockResolveWorkflowCallTarget,
  mockLoadProjectConfig,
  mockResolveWorkflowConfigValue,
  mockResolveAuxiliaryRuntimeEnvironment,
  mockBuildCompanionInstructionContext,
  mockCollectTaskReviewScope,
  mockResolveReviewScopeBaseRange,
  mockInstructionBuild,
  mockInstructionBuilder,
  mockLocateTask,
  mockError,
  mockSuccess,
  mockRequeueTask,
} = vi.hoisted(() => ({
  mockResolveWorkflowCallTarget: vi.fn(),
  mockLoadProjectConfig: vi.fn(() => ({})),
  mockResolveWorkflowConfigValue: vi.fn(() => 'en'),
  mockResolveAuxiliaryRuntimeEnvironment: vi.fn(() => ({
    companionEnabled: false,
    companionReviewMode: 'inline',
  })),
  mockBuildCompanionInstructionContext: vi.fn(() => undefined),
  mockCollectTaskReviewScope: vi.fn(() => ({ files: [] })),
  mockResolveReviewScopeBaseRange: vi.fn(() => undefined),
  mockInstructionBuild: vi.fn(() => 'PHASE 1 TEXT'),
  mockInstructionBuilder: vi.fn(),
  mockLocateTask: vi.fn(),
  mockError: vi.fn(),
  mockSuccess: vi.fn(),
  mockRequeueTask: vi.fn(),
}));

vi.mock('../infra/config/index.js', () => ({
  resolveWorkflowCallTarget: (...args: unknown[]) => mockResolveWorkflowCallTarget(...args),
  loadProjectConfig: mockLoadProjectConfig,
  resolveWorkflowConfigValue: mockResolveWorkflowConfigValue,
}));

vi.mock('../infra/config/runtime-provider/provider-environment.js', () => ({
  resolveAuxiliaryRuntimeEnvironment: mockResolveAuxiliaryRuntimeEnvironment,
}));

vi.mock('../core/workflow/companion/instruction-context.js', () => ({
  buildCompanionInstructionContext: mockBuildCompanionInstructionContext,
}));

vi.mock('../core/workflow/review-scope.js', () => ({
  collectTaskReviewScope: mockCollectTaskReviewScope,
  resolveReviewScopeBaseRange: mockResolveReviewScopeBaseRange,
}));

vi.mock('../core/workflow/instruction/InstructionBuilder.js', () => ({
  InstructionBuilder: class {
    constructor(step: unknown, context: unknown) {
      mockInstructionBuilder(step, context);
    }
    build(): string {
      return mockInstructionBuild();
    }
  },
}));

vi.mock('../features/tasks/fork/taskPointer.js', () => ({
  locateTask: mockLocateTask,
}));

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  success: mockSuccess,
  error: mockError,
  blankLine: vi.fn(),
}));

// Real, apart from the runner: moving a pointer is the one thing these tests
// must not actually do to a task record.
vi.mock('../infra/task/index.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../infra/task/index.js')>(),
  TaskRunner: class {
    requeueTask(...args: unknown[]): void {
      mockRequeueTask(...args);
    }
  },
}));

import type { WorkflowConfig, WorkflowStep } from '../core/models/index.js';
import type { InstructionContext } from '../core/workflow/instruction/instruction-context.js';
import {
  buildStepInstruction,
  extractExecutionContext,
  resolveStepOwner,
} from '../features/tasks/fork/stepInstruction.js';
import { printTaskInstruction } from '../features/tasks/fork/printTaskInstruction.js';
import { readCompletionResult } from '../app/cli/fork/completionResult.js';
import { makeStep } from './engine-test-helpers.js';

const context = { projectCwd: '/project', lookupCwd: '/project' };

const gates: WorkflowConfig = {
  name: 'gates',
  description: 'Deepest child',
  initialStep: 'lint',
  maxSteps: 4,
  subworkflow: { callable: true },
  allStepsRules: [{ ref: 'gates.md', position: 'after_execution_rules', content: 'gate rule' }],
  steps: [makeStep('lint'), makeStep('test'), makeStep('build')],
};

const codeChange: WorkflowConfig = {
  name: 'code-change',
  description: 'Middle child',
  initialStep: 'draft',
  maxSteps: 8,
  subworkflow: { callable: true },
  steps: [
    makeStep('draft'),
    makeStep('verify', { kind: 'workflow_call', call: 'qa/gates' } as Partial<WorkflowStep>),
  ],
};

const root: WorkflowConfig = {
  name: 'full',
  description: 'Root',
  initialStep: 'plan',
  maxSteps: 20,
  allStepsRules: [{ ref: 'root.md', position: 'before_instruction', content: 'root rule' }],
  steps: [
    makeStep('plan'),
    makeStep('implement', { kind: 'workflow_call', call: 'impl/code-change' } as Partial<WorkflowStep>),
  ],
};

function resolveCall(_parent: WorkflowConfig, step: { call: string }): WorkflowConfig | null {
  if (step.call === 'impl/code-change') return codeChange;
  if (step.call === 'qa/gates') return gates;
  return null;
}

/** The stack of a step nested two calls deep. */
const NESTED_STACK = [
  { workflow: 'full', step: 'implement', kind: 'workflow_call' },
  { workflow: 'code-change', step: 'verify', kind: 'workflow_call' },
  { workflow: 'gates', step: 'test', kind: 'agent' },
] as never;

function lastContext(): InstructionContext {
  return mockInstructionBuilder.mock.calls.at(-1)?.[1] as InstructionContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveWorkflowCallTarget.mockImplementation(resolveCall);
  mockResolveWorkflowConfigValue.mockReturnValue('en');
  mockInstructionBuild.mockReturnValue('PHASE 1 TEXT');
  mockResolveAuxiliaryRuntimeEnvironment.mockReturnValue({
    companionEnabled: false,
    companionReviewMode: 'inline',
  });
  mockCollectTaskReviewScope.mockReturnValue({ files: [] });
  mockLoadProjectConfig.mockReturnValue({});
});

afterEach(() => {
  process.exitCode = undefined;
});

describe('resolveStepOwner', () => {
  it('should answer the root workflow for a root step', () => {
    const owner = resolveStepOwner(root, [{ workflow: 'full', step: 'plan' }] as never, context);

    expect(owner.workflow.name).toBe('full');
    expect(owner.rules.map((rule) => rule.content)).toEqual(['root rule']);
  });

  // The engine inherits a parent's workflow-wide rules into every child it
  // calls, so a nested step sees more than its own workflow declares.
  it('should answer the authoring workflow and every inherited rule for a nested step', () => {
    const owner = resolveStepOwner(root, NESTED_STACK, context);

    expect(owner.workflow.name).toBe('gates');
    expect(owner.rules.map((rule) => rule.content)).toEqual(['root rule', 'gate rule']);
  });

  it('should refuse a stack whose frame is not a workflow call', () => {
    expect(() => resolveStepOwner(
      root,
      [{ workflow: 'full', step: 'plan' }, { workflow: 'x', step: 'y' }] as never,
      context,
    )).toThrow('is not a workflow call');
  });

  it('should refuse a call it cannot resolve', () => {
    mockResolveWorkflowCallTarget.mockReturnValue(null);

    expect(() => resolveStepOwner(root, NESTED_STACK, context))
      .toThrow('references unknown workflow');
  });
});

describe('buildStepInstruction', () => {
  const owner = { workflow: gates, rules: gates.allStepsRules ?? [] };

  it('should place the step in its own workflow, not the root', () => {
    buildStepInstruction({
      step: gates.steps[1]!,
      owner,
      context,
      language: 'en',
      task: 'do the thing',
    });

    const built = lastContext();
    expect(built.workflowName).toBe('gates');
    expect(built.currentStepIndex).toBe(1);
    expect(built.workflowSteps?.map((step) => step.name)).toEqual(['lint', 'test', 'build']);
    expect(built.maxSteps).toBe(4);
  });

  it('should pass the task, report directory and artifacts directory through', () => {
    buildStepInstruction({
      step: gates.steps[0]!,
      owner,
      context,
      language: 'en',
      task: 'do the thing',
      reportDir: '.takt/runs/r1/reports',
      taskArtifactsDir: 'docs/tasks/kek',
    });

    const built = lastContext();
    expect(built.task).toBe('do the thing');
    expect(built.reportDir).toBe('.takt/runs/r1/reports');
    expect(built.taskArtifactsDir).toBe('docs/tasks/kek');
  });

  // Nothing outside a run can supply these, and a fabricated value would be
  // read as fact by the agent the prompt is handed to.
  it('should leave the run-scoped fields empty', () => {
    buildStepInstruction({
      step: gates.steps[0]!,
      owner,
      context,
      language: 'en',
      task: 'do the thing',
    });

    const built = lastContext();
    expect(built.previousOutput).toBeUndefined();
    expect(built.retryNote).toBeUndefined();
    expect(built.userInputs).toEqual([]);
    expect(built.iteration).toBe(1);
    expect(built.stepIteration).toBe(1);
    expect(built.validateReportReferences).toBe(false);
  });

  // The prompt is the point of the command; a repository git cannot read must
  // not cost the caller the whole output.
  it('should degrade an unresolvable review scope instead of failing', () => {
    mockCollectTaskReviewScope.mockImplementation(() => {
      throw new Error('not a git repository');
    });

    expect(buildStepInstruction({
      step: gates.steps[0]!,
      owner,
      context,
      language: 'en',
      task: 'do the thing',
    })).toBe('PHASE 1 TEXT');
    expect(lastContext().reviewScope).toBeUndefined();
  });

  it('should withhold workflow-wide rules from an engine-synthesized step', () => {
    buildStepInstruction({
      step: makeStep('synth', { engineSynthesized: true } as Partial<WorkflowStep>),
      owner,
      context,
      language: 'en',
      task: 'do the thing',
    });

    expect(lastContext().workflowRules).toBeUndefined();
  });
});

describe('printTaskInstruction', () => {
  let tmpDir: string;

  function locate(orderContent: string | undefined): void {
    const taskDir = '.takt/tasks/kek';
    if (orderContent !== undefined) {
      fs.mkdirSync(path.join(tmpDir, taskDir), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, taskDir, 'order.md'), orderContent, 'utf-8');
    }
    mockLocateTask.mockReturnValue({
      task: {
        name: 'kek',
        content: 'record text',
        ...(orderContent === undefined ? {} : { taskDir }),
      },
      workflowIdentifier: 'pipeline/full',
      workflow: root,
      lookupCwd: tmpDir,
      pointer: [{ workflow: 'full', step: 'plan' }],
    });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-fork-instruction-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should print the prompt and nothing else', () => {
    locate('Rewrite the parser.\n');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    printTaskInstruction(tmpDir, 'kek');

    expect(log).toHaveBeenCalledExactlyOnceWith('PHASE 1 TEXT');
    expect(process.exitCode).toBeUndefined();
    log.mockRestore();
  });

  // A real order is a file the agent must read, and outside a run the task's
  // own directory is where that file actually is.
  it('should point a real order at the task directory rather than a run context', () => {
    locate('Rewrite the parser.\n');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    printTaskInstruction(tmpDir, 'kek');

    expect(lastContext().task).toContain('.takt/tasks/kek/order.md');
    log.mockRestore();
  });

  it('should open a blank order with the blank-order prompt instead of a spec pointer', () => {
    locate('   \n');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    printTaskInstruction(tmpDir, 'kek');

    expect(lastContext().task).toContain('No task specification was supplied');
    expect(lastContext().task).not.toContain('Primary spec');
    log.mockRestore();
  });

  it('should report a task it cannot place on a step', () => {
    locate('Rewrite the parser.\n');
    mockLocateTask.mockReturnValue({
      task: { name: 'kek', content: 'record text', taskDir: '.takt/tasks/kek' },
      workflowIdentifier: 'pipeline/full',
      workflow: root,
      lookupCwd: tmpDir,
      pointer: [{ workflow: 'full', step: 'vanished' }],
    });

    printTaskInstruction(tmpDir, 'kek');

    expect(mockError).toHaveBeenCalledWith(
      'Task "kek" does not stand on a step of its workflow.',
    );
    expect(process.exitCode).toBe(1);
  });

  it('should say nothing more when the task itself could not be found', () => {
    mockLocateTask.mockReturnValue(undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    printTaskInstruction(tmpDir, 'missing');

    expect(log).not.toHaveBeenCalled();
    expect(mockError).not.toHaveBeenCalled();
    log.mockRestore();
  });
});

/** The shape of a built Phase 1 prompt: two sections share the context heading. */
const PHASE1 = [
  '## Execution Context',
  '- Working Directory: /project',
  '',
  '## Execution Rules',
  '- Do NOT use `cd` in Bash commands.',
  '',
  '## Execution Context',
  '- Workflow: routed',
  '- Iteration: 1/8',
  '- Step Iteration: 1',
  '- Step: ask',
  '',
  '## Work',
  'THE WORK ITSELF',
].join('\n');

describe('extractExecutionContext', () => {
  // The first section carries only the working directory; the one worth
  // printing is the one that says which step the task stands on.
  it('should take the context section naming the step, not the first one', () => {
    expect(extractExecutionContext(PHASE1, 'ask')).toBe([
      '## Execution Context',
      '- Workflow: routed',
      '- Iteration: 1/8',
      '- Step Iteration: 1',
      '- Step: ask',
    ].join('\n'));
  });

  // Silence here would mean printing the wrong block as if it were right.
  it('should refuse a prompt with no context section for the step', () => {
    expect(() => extractExecutionContext(PHASE1, 'review')).toThrow('no execution context');
  });
});

describe('printTaskInstruction --complete', () => {
  let tmpDir: string;

  /** A workflow whose current step routes onward, so a result has somewhere to go. */
  const routed: WorkflowConfig = {
    name: 'routed',
    description: 'Routing root',
    initialStep: 'ask',
    maxSteps: 8,
    steps: [
      makeStep('ask', {
        rules: [{ condition: { kind: 'semantic', label: 'ready to review' }, next: 'review' }],
      } as Partial<WorkflowStep>),
      makeStep('review'),
    ],
  };

  function locateRouted(kind = 'failed'): void {
    mockLocateTask.mockReturnValue({
      task: { name: 'kek', content: 'Rewrite the parser.', kind },
      workflowIdentifier: 'pipeline/routed',
      workflow: routed,
      lookupCwd: tmpDir,
      pointer: [{ workflow: 'routed', step: 'ask' }],
    });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-fork-complete-'));
    mockInstructionBuild.mockReturnValue(PHASE1);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // An agent that has already done the work needs to know where it stands and
  // what it owes - not the persona, the policy and the work all over again.
  it('should print the execution context and the contract, and nothing else', () => {
    locateRouted();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    printTaskInstruction(tmpDir, 'kek', { complete: true });

    const printed = log.mock.calls.at(0)?.[0] as string;
    expect(printed).toContain('- Step: ask');
    expect(printed).toContain('## Completion');
    expect(printed).toContain('### Rules');
    expect(printed).toContain('`[ASK:1]`');
    expect(printed).not.toContain('THE WORK ITSELF');
    expect(printed).not.toContain('## Execution Rules');
    expect(mockRequeueTask).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('should move the pointer to a step the result names outright', () => {
    locateRouted();

    printTaskInstruction(tmpDir, 'kek', { complete: true, result: 'review' });

    expect(mockSuccess).toHaveBeenCalledWith(expect.stringContaining('Moved to'));
    expect(mockRequeueTask).toHaveBeenCalledTimes(1);
  });

  it('should move the pointer to the step the result routes to', () => {
    locateRouted();

    printTaskInstruction(tmpDir, 'kek', { complete: true, result: 'Done.\n\n[ASK:1]' });

    expect(mockRequeueTask).toHaveBeenCalledTimes(1);
    const [name, statuses, options] = mockRequeueTask.mock.calls[0] as [
      string,
      readonly string[],
      { readonly restartPoint: { readonly stack: readonly { readonly step: string }[] } },
    ];
    expect(name).toBe('kek');
    expect(statuses).toContain('failed');
    expect(options.restartPoint.stack.at(-1)?.step).toBe('review');
    expect(mockSuccess).toHaveBeenCalledWith(expect.stringContaining('Moved to'));
    expect(process.exitCode).toBeUndefined();
  });

  it('should refuse a result the step cannot be routed by, leaving the pointer alone', () => {
    locateRouted();

    printTaskInstruction(tmpDir, 'kek', { complete: true, result: 'Done, with no tag.' });

    expect(mockRequeueTask).not.toHaveBeenCalled();
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('[ASK:N]'));
    expect(process.exitCode).toBe(1);
  });

  // A running task's pointer belongs to the engine that is moving it.
  it('should refuse to move a task that is running', () => {
    locateRouted('running');

    printTaskInstruction(tmpDir, 'kek', { complete: true, result: '[ASK:1]' });

    expect(mockRequeueTask).not.toHaveBeenCalled();
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('is running'));
    expect(process.exitCode).toBe(1);
  });
});

describe('readCompletionResult', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-fork-result-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should take an inline result as itself', () => {
    expect(readCompletionResult('{"outcome":"onward"}')).toBe('{"outcome":"onward"}');
  });

  it('should read an @-prefixed result out of the file it names', () => {
    const file = path.join(tmpDir, 'result.json');
    fs.writeFileSync(file, '{"outcome":"onward"}', 'utf-8');

    expect(readCompletionResult(`@${file}`)).toBe('{"outcome":"onward"}');
  });

  it('should report a file it cannot read rather than passing the path on as the result', () => {
    expect(readCompletionResult(`@${path.join(tmpDir, 'absent.json')}`)).toBeUndefined();
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('Could not read the result'));
    expect(process.exitCode).toBe(1);
  });
});
