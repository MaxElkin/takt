import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import { parseWorkflowRaw } from '../infra/config/loaders/workflowRawParser.js';

function workflow(steps: unknown[]) {
  return normalizeWorkflowConfig({ name: 'implicit-transitions', steps }, '/tmp');
}

describe('implicit sequential workflow transitions', () => {
  it('routes plain agent steps to the following YAML step', () => {
    const config = workflow([
      { name: 'start' },
      { name: 'work' },
      { name: 'finish' },
    ]);

    expect(config.steps.map((step) => step.rules?.map((rule) => rule.next))).toEqual([
      ['work'],
      ['finish'],
      ['COMPLETE'],
    ]);
  });

  it('preserves explicit empty rules and routes special top-level steps', () => {
    const config = workflow([
      { name: 'manual', rules: [] },
      { name: 'call', kind: 'workflow_call', call: 'child' },
      { name: 'system', kind: 'system' },
      { name: 'parallel', parallel: [{ name: 'part' }] },
    ]);

    expect(config.steps[0]?.rules).toEqual([]);
    expect(config.steps[1]?.rules?.map((rule) => rule.next)).toEqual(['system']);
    expect(config.steps[2]?.rules?.map((rule) => rule.next)).toEqual(['parallel']);
    expect(config.steps[3]?.rules?.map((rule) => rule.next)).toEqual(['COMPLETE']);
  });

  it('does not invent a route when an explicit rules value is malformed', () => {
    expect(() => workflow([{ name: 'step', rules: null }])).toThrow();
  });

  it('routes to a fragment-generated name after fragment expansion', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-implicit-fragment-'));
    try {
      const stepsDir = join(projectDir, '.takt', 'steps');
      mkdirSync(stepsDir, { recursive: true });
      writeFileSync(join(stepsDir, 'gather.yaml'), 'description: Gather\n');

      const parsed = parseWorkflowRaw({
        name: 'fragment-route',
        steps: [
          { name: 'start' },
          {
            uses: 'gather',
            rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
          },
        ],
      }, {
        workflowPath: join(projectDir, 'workflow.yaml'),
        context: {
          lang: 'en',
          projectDir,
          workflowDir: projectDir,
          repertoireDir: projectDir,
        },
      });

      expect(parsed.steps[0]?.rules?.[0]?.next).toBe('gather');
      expect(parsed.steps[1]?.name).toBe('gather');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
