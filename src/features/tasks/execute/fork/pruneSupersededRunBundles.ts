import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { readRunMeta } from '../../../../core/workflow/run/run-meta.js';
import type { RunPaths } from '../../../../core/workflow/run/run-paths.js';
import { createLogger } from '../../../../shared/utils/index.js';

const log = createLogger('run-bundle-prune');

/** A chain longer than this means a cycle or a corrupt meta; stop walking. */
const MAX_CHAIN_LENGTH = 64;

/**
 * Every attempt at a task gets its own run directory, and `workflow-bundle/`
 * inside it is a verbatim copy of the project's workflows and facets - ~3.5 MB
 * for this project, rebuilt from scratch on every run. Nothing ever reads a
 * *superseded* run's bundle: every bundle path is derived from the current
 * run's `RunPaths`, and a resume touches its predecessor only through
 * `report-inheritance`, which copies out of `reports/`. So once a new run
 * exists, its ancestors' bundles are dead weight.
 *
 * Walking `source_run_slug` backwards from the new run's source covers resume,
 * restart and auto-requeue alike, without needing to know which task a run
 * belongs to.
 *
 * Only the bundle goes. `meta.json`, `reports/`, `context/`, `logs/` and
 * `trace.md` are the record of what happened - that is what a person reads
 * after a failure, and `meta.json` is also what keeps the chain walkable.
 *
 * Pruning is best-effort: a failure here must never take a run down with it.
 */
export function pruneSupersededRunBundles(
  runPaths: RunPaths,
  sourceRunSlug: string | undefined,
): void {
  if (sourceRunSlug === undefined) {
    return;
  }
  const runsDirectory = dirname(runPaths.runRootAbs);
  const seen = new Set<string>([runPaths.slug]);
  let slug: string | undefined = sourceRunSlug;
  while (slug !== undefined && !seen.has(slug) && seen.size <= MAX_CHAIN_LENGTH) {
    seen.add(slug);
    const runRoot = join(runsDirectory, slug);
    let next: string | undefined;
    try {
      next = readRunMeta(join(runRoot, 'meta.json'))?.sourceRunSlug;
      rmSync(join(runRoot, 'workflow-bundle'), { recursive: true, force: true });
    } catch (error) {
      log.debug('Superseded run bundle could not be pruned', {
        runSlug: slug,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    slug = next;
  }
}
