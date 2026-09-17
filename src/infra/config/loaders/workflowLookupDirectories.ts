import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveWorkflowConfigValues } from '../resolveWorkflowConfigValue.js';
import {
  getBuiltinWorkflowsDir,
  getGlobalWorkflowsDir,
  getProjectWorkflowsDir,
  isPathSafe,
} from '../paths.js';
import { isPathInside, lstatIfExists } from '../../../shared/utils/pathBoundary.js';
import { listBuiltinWorkflowNamesForDir, type WorkflowSource } from './workflowDiscovery.js';
import type { WorkflowTrustSource } from './workflowTrustSource.js';

interface WorkflowLookupDir {
  dir: string;
  source: WorkflowSource;
  disabled?: string[];
}

export interface NamedWorkflowLookupDir {
  dir: string;
  source: WorkflowTrustSource;
  disabled?: string[];
}

export interface ResolveWorkflowFileOptions {
  /**
   * Project root whose in-project symlinks are trusted for named lookup.
   * The lexical workflow-root boundary is still enforced first, so only
   * symlink traversal can use this wider boundary.
   */
  projectRoot?: string;
}

export function resolveWorkflowFile(
  workflowsDir: string,
  name: string,
  options?: ResolveWorkflowFileOptions,
): string | null {
  const resolvedWorkflowsDir = resolve(workflowsDir);
  const rootStats = lstatIfExists(resolvedWorkflowsDir);
  if (
    options?.projectRoot !== undefined
    && (
      rootStats === null
      || rootStats.isSymbolicLink()
      || !rootStats.isDirectory()
      || !isPathSafe(options.projectRoot, resolvedWorkflowsDir)
    )
  ) {
    return null;
  }

  for (const ext of ['.yaml', '.yml']) {
    const filePath = resolve(workflowsDir, `${name}${ext}`);
    // Reject traversal lexically before considering a symlink target. This
    // keeps `..` from becoming an escape hatch when project-root symlinks are
    // allowed below.
    if (!isPathInside(resolvedWorkflowsDir, filePath)) {
      continue;
    }

    const staysInsideWorkflowRoot = isPathSafe(resolvedWorkflowsDir, filePath);
    const staysInsideTrustedProject = options?.projectRoot !== undefined
      && isPathSafe(options.projectRoot, filePath);
    if (!staysInsideWorkflowRoot && !staysInsideTrustedProject) {
      continue;
    }
    if (options?.projectRoot === undefined && existsSync(filePath)) {
      return filePath;
    }
    const fileStats = lstatIfExists(filePath);
    if (fileStats !== null && !fileStats.isSymbolicLink() && fileStats.isFile()) return filePath;
  }
  return null;
}

export function findWorkflowInLookupDirs(
  name: string,
  lookupDirs: NamedWorkflowLookupDir[],
  projectRoot?: string,
): { filePath: string; source: WorkflowTrustSource } | null {
  for (const { dir, source, disabled } of lookupDirs) {
    if (source === 'builtin' && disabled?.includes(name)) {
      continue;
    }

    const filePath = resolveWorkflowFile(dir, name, {
      projectRoot: source === 'project' ? projectRoot : undefined,
    });
    if (!filePath) {
      continue;
    }

    return { filePath, source };
  }

  return null;
}

export function getWorkflowDirs(cwd: string): WorkflowLookupDir[] {
  const config = resolveWorkflowConfigValues(cwd, ['enableBuiltinWorkflows', 'language', 'disabledBuiltins']);
  const dirs: WorkflowLookupDir[] = [];

  if (config.enableBuiltinWorkflows !== false) {
    dirs.push({
      dir: getBuiltinWorkflowsDir(config.language),
      disabled: config.disabledBuiltins ?? [],
      source: 'builtin',
    });
  }

  dirs.push({ dir: getGlobalWorkflowsDir(), source: 'user' });
  dirs.push({ dir: getProjectWorkflowsDir(cwd), source: 'project' });
  return dirs;
}

export function getNamedWorkflowLookupDirs(projectCwd: string): NamedWorkflowLookupDir[] {
  const config = resolveWorkflowConfigValues(projectCwd, ['enableBuiltinWorkflows', 'language', 'disabledBuiltins']);
  const dirs: NamedWorkflowLookupDir[] = [
    {
      dir: resolve(getProjectWorkflowsDir(projectCwd)),
      source: 'project',
    },
    { dir: getGlobalWorkflowsDir(), source: 'user' },
  ];

  if (config.enableBuiltinWorkflows !== false) {
    dirs.push({
      dir: getBuiltinWorkflowsDir(config.language),
      disabled: config.disabledBuiltins ?? [],
      source: 'builtin',
    });
  }

  return dirs;
}

export function getBuiltinWorkflowPath(name: string, projectCwd: string): string | null {
  const config = resolveWorkflowConfigValues(projectCwd, ['enableBuiltinWorkflows', 'language', 'disabledBuiltins']);
  if (config.enableBuiltinWorkflows === false || (config.disabledBuiltins ?? []).includes(name)) {
    return null;
  }
  return resolveWorkflowFile(getBuiltinWorkflowsDir(config.language), name);
}

export function listBuiltinWorkflowNames(
  cwd: string,
  options?: { includeDisabled?: boolean },
): string[] {
  const config = resolveWorkflowConfigValues(cwd, ['language', 'disabledBuiltins']);
  const disabled = options?.includeDisabled ? undefined : (config.disabledBuiltins ?? []);
  return listBuiltinWorkflowNamesForDir(getBuiltinWorkflowsDir(config.language), disabled);
}
