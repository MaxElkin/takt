import type { WorkflowDefaultsConfig } from '../../../core/models/config-types.js';

interface RawRecord {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Merge project workflow defaults over global workflow defaults. */
export function mergeWorkflowDefaults(
  projectDefaults: WorkflowDefaultsConfig | undefined,
  globalDefaults: WorkflowDefaultsConfig | undefined,
): WorkflowDefaultsConfig | undefined {
  const callable = projectDefaults?.callable ?? globalDefaults?.callable;
  const visibility = projectDefaults?.visibility ?? globalDefaults?.visibility;
  if (callable === undefined && visibility === undefined) return undefined;
  return {
    ...(callable === undefined ? {} : { callable }),
    ...(visibility === undefined ? {} : { visibility }),
  };
}

/** Apply configured defaults without overriding explicit workflow metadata. */
export function applyWorkflowDefaults(
  raw: unknown,
  defaults: WorkflowDefaultsConfig | undefined,
): unknown {
  if (!defaults || !isRecord(raw)) return raw;

  const rawSubworkflow = raw.subworkflow;
  // Preserve malformed explicit values so the workflow schema reports them.
  if (rawSubworkflow !== undefined && !isRecord(rawSubworkflow)) return raw;
  const explicit = rawSubworkflow ?? {};
  const callable = explicit.callable !== undefined ? explicit.callable : defaults.callable;
  // An internal visibility default is meaningful only for callable workflows.
  // This also keeps an explicit callable: false root workflow valid.
  const visibility = explicit.visibility !== undefined
    ? explicit.visibility
    : (callable === true ? defaults.visibility : undefined);
  if (callable === undefined && visibility === undefined) return raw;

  return {
    ...raw,
    subworkflow: {
      ...explicit,
      ...(callable === undefined ? {} : { callable }),
      ...(visibility === undefined ? {} : { visibility }),
    },
  };
}
