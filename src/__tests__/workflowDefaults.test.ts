import { describe, expect, it } from 'vitest';
import { applyWorkflowDefaults, mergeWorkflowDefaults } from '../infra/config/loaders/workflowDefaults.js';

describe('workflow subworkflow defaults', () => {
  it('merges project values over global values', () => {
    expect(mergeWorkflowDefaults(
      { callable: false },
      { callable: true, visibility: 'internal' },
    )).toEqual({ callable: false, visibility: 'internal' });
  });

  it('applies callable and internal visibility to omitted metadata', () => {
    expect(applyWorkflowDefaults(
      { name: 'child', steps: [] },
      { callable: true, visibility: 'internal' },
    )).toEqual({
      name: 'child',
      steps: [],
      subworkflow: { callable: true, visibility: 'internal' },
    });
  });

  it('does not apply visibility to an explicit non-callable root', () => {
    expect(applyWorkflowDefaults(
      { name: 'root', subworkflow: { callable: false }, steps: [] },
      { callable: true, visibility: 'internal' },
    )).toEqual({
      name: 'root',
      subworkflow: { callable: false },
      steps: [],
    });
  });

  it('preserves explicit null metadata for schema validation', () => {
    expect(applyWorkflowDefaults(
      { name: 'broken', subworkflow: { callable: null } },
      { callable: true, visibility: 'internal' },
    )).toEqual({
      name: 'broken',
      subworkflow: { callable: null },
    });
  });
});
