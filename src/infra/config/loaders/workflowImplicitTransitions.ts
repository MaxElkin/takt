interface RawRecord {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: RawRecord, key: string): boolean {
  return Object.hasOwn(value, key);
}

/**
 * Give top-level sequential steps an implicit COMPLETE transition.
 *
 * `rules: []` is left untouched so authors can intentionally disable routing.
 * Step fragments remain explicit because their resolver requires the concrete
 * caller to own its routing tree.
 */
export function applyImplicitSequentialTransitions(raw: unknown): unknown {
  if (!isRecord(raw) || !Array.isArray(raw.steps)) {
    return raw;
  }

  const rawSteps = raw.steps;
  let changed = false;
  const steps = rawSteps.map((candidate, index) => {
    if (
      !isRecord(candidate)
      || hasOwn(candidate, 'rules')
      || hasOwn(candidate, 'uses')
      || !isImplicitlyRoutableStep(candidate)
    ) {
      return candidate;
    }

    const following = rawSteps[index + 1];
    const next = isRecord(following) && typeof following.name === 'string'
      ? following.name
      : 'COMPLETE';
    changed = true;
    return {
      ...candidate,
      rules: [{ condition: 'COMPLETE', next }],
    };
  });

  return changed ? { ...raw, steps } : raw;
}

function isImplicitlyRoutableStep(step: RawRecord): boolean {
  // This shorthand is valid for agent, system, workflow_call, and composite
  // steps. Keep kind validation in the normal workflow schema.
  void step;
  return true;
}
