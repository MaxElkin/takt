import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  getBuiltinWorkflowsDir,
  getGlobalWorkflowsDir,
  getProjectRulesDir,
  getProjectWorkflowsDir,
  isPathSafe,
} from '../paths.js';
import type { Language, WorkflowWideRule } from '../../../core/models/index.js';
import { extractReportReferences } from '../../../core/workflow/instruction/report-reference.js';
import { withWorkflowConfigErrorPath } from '../../../core/workflow/workflow-config-error.js';
import { readRegularFileNoFollow } from '../../../shared/utils/private-file.js';
import { assertPathSegmentsAreSafe, isPathInside, lstatIfExists } from '../../../shared/utils/pathBoundary.js';

type RawWorkflowWideRule = string | {
  readonly ref: string;
  readonly position?: 'before_instruction';
};

const REQUIRED_OUTPUT_HEADING = /(?:必須出力（見出しを含める）|Required Output \(include (?:the )?headings\))/i;
const MARKDOWN_HEADING_LINE = /^\s*#{1,6}\s*(.+)$/;
const REQUIRED_OUTPUT_SECTION_TITLE = /^(?:必須出力|Required Outputs?)(?:\s|$|[（(：:])/i;

function containsRequiredOutputSection(content: string): boolean {
  return content.split(/\r?\n/).some((line) => {
    const heading = MARKDOWN_HEADING_LINE.exec(line);
    if (heading === null) {
      return false;
    }
    const title = heading[1];
    if (title === undefined) {
      return false;
    }
    const undecoratedTitle = title
      .replace(/\[([^\]]+)](?:\([^)]*\)|\[[^\]]*])?/g, '$1')
      .replace(/<[^>]*>/g, '')
      .replace(/[*_~`]/g, '')
      .trim();
    return REQUIRED_OUTPUT_SECTION_TITLE.test(undecoratedTitle);
  });
}

function assertSafeRuleReference(ref: string, index: number): void {
  const segments = ref.split('/');
  if (
    ref.length === 0
    || isAbsolute(ref)
    || ref.includes('\\')
    || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error(`Invalid workflow-wide rule reference at all_steps.rules[${index}]: "${ref}"`);
  }
}

function ruleFilePath(root: string, ref: string): string {
  const filePath = join(root, `${ref}.md`);
  const rootPath = resolve(root);
  const relativePath = relative(rootPath, resolve(filePath));
  if (relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`Workflow-wide rule reference escapes the rules directory: "${ref}"`);
  }
  return filePath;
}

function readRuleFile(
  root: string,
  filePath: string,
  options?: { projectRoot?: string },
): string | undefined {
  const rootStats = lstatIfExists(root);
  if (rootStats !== null && (rootStats.isSymbolicLink() || !rootStats.isDirectory())) {
    throw new Error(`Workflow-wide rule root must be a directory and must not be a symlink: ${root}`);
  }

  const resolvedRoot = resolve(root);
  if (!isPathInside(resolvedRoot, filePath)) {
    throw new Error(`Workflow-wide rule must stay inside its candidate root: ${filePath}`);
  }

  // Project-owned rule categories may be symlinked to another directory in
  // the same project. The lexical candidate-root boundary above still
  // applies; this check only widens the real-path boundary for that case.
  if (options?.projectRoot !== undefined) {
    if (!isPathSafe(options.projectRoot, resolvedRoot)) {
      throw new Error(`Workflow-wide rule root must stay inside the project: ${root}`);
    }
    if (!isPathSafe(options.projectRoot, filePath)) {
      throw new Error(`Workflow-wide rule must stay inside the project: ${filePath}`);
    }
    const stats = lstatIfExists(filePath);
    if (stats === null) return undefined;
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`Workflow-wide rule must be a regular file and must not be a symlink: ${filePath}`);
    }
    return readRegularFileNoFollow(filePath, stats).toString('utf-8');
  }

  const stats = assertPathSegmentsAreSafe(
    root,
    filePath,
    (_violation, segmentPath) => new Error(
      `Workflow-wide rule must stay inside its candidate root and must not use symlinks: ${segmentPath}`,
    ),
  );
  if (stats === null) return undefined;
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Workflow-wide rule must be a regular file and must not be a symlink: ${filePath}`);
  }

  return readRegularFileNoFollow(filePath, stats).toString('utf-8');
}

function assertAllowedRuleContent(content: string, filePath: string, index: number): void {
  if (REQUIRED_OUTPUT_HEADING.test(content) || containsRequiredOutputSection(content)) {
    throw withWorkflowConfigErrorPath(
      new Error(
        `Invalid workflow-wide rule file "${filePath}" referenced by all_steps.rules[${index}]: `
        + 'rule files must not contain required output headings',
      ),
      ['all_steps', 'rules', index],
    );
  }

  if (extractReportReferences(content).length > 0) {
    throw withWorkflowConfigErrorPath(
      new Error(
        `Invalid workflow-wide rule file "${filePath}" referenced by all_steps.rules[${index}]: `
        + 'rule files must not contain {report:...} references',
      ),
      ['all_steps', 'rules', index],
    );
  }
}

interface RuleLookupRoot {
  readonly path: string;
  readonly allowProjectSymlinks: boolean;
}

function resolveRuleFile(
  ref: string,
  roots: readonly RuleLookupRoot[],
  searchedLocations: string,
  index: number,
  projectRoot?: string,
): { filePath: string; content: string } {
  assertSafeRuleReference(ref, index);
  for (const lookupRoot of roots) {
    const filePath = ruleFilePath(lookupRoot.path, ref);
    const projectRuleRoot = lookupRoot.allowProjectSymlinks ? projectRoot : undefined;
    const content = readRuleFile(lookupRoot.path, filePath, { projectRoot: projectRuleRoot });
    if (content !== undefined) {
      return { filePath, content };
    }
  }

  throw new Error(
    `Workflow-wide rule "${ref}" referenced by all_steps.rules[${index}] was not found ${searchedLocations}`,
  );
}

function normalizeRuleEntry(entry: RawWorkflowWideRule): { ref: string; position: WorkflowWideRule['position'] } {
  if (typeof entry === 'string') {
    return { ref: entry, position: 'after_execution_rules' };
  }
  return {
    ref: entry.ref,
    position: entry.position ?? 'after_execution_rules',
  };
}

export function resolveWorkflowWideRules(
  entries: readonly RawWorkflowWideRule[] | undefined,
  projectCwd: string,
  language: Language,
  workflowDir?: string,
  resourceRoot?: string,
): readonly WorkflowWideRule[] | undefined {
  if (entries === undefined) {
    return undefined;
  }

  const roots = resourceRoot === undefined
    ? [
      ...(workflowDir === undefined ? [] : [{
        path: join(workflowDir, 'rules'),
        allowProjectSymlinks: isPathSafe(projectCwd, workflowDir),
      }]),
      { path: join(getProjectWorkflowsDir(projectCwd), 'rules'), allowProjectSymlinks: true },
      { path: getProjectRulesDir(projectCwd), allowProjectSymlinks: true },
      { path: join(getGlobalWorkflowsDir(), 'rules'), allowProjectSymlinks: false },
      { path: join(getBuiltinWorkflowsDir(language), 'rules'), allowProjectSymlinks: false },
    ]
    : [{ path: join(resourceRoot, 'workflows', 'rules'), allowProjectSymlinks: false }];
  const uniqueRoots = roots.filter((root, index, all) => (
    all.findIndex((candidate) => candidate.path === root.path) === index
  ));
  const searchedLocations = resourceRoot === undefined
    ? 'in project, global, or builtin workflow rules'
    : `in the isolated workflow rules under "${join(resourceRoot, 'workflows', 'rules')}"`;

  return entries.map((entry, index) => {
    const normalized = normalizeRuleEntry(entry);
    const resolved = resolveRuleFile(
      normalized.ref,
      uniqueRoots,
      searchedLocations,
      index,
      resourceRoot === undefined ? projectCwd : undefined,
    );
    assertAllowedRuleContent(resolved.content, resolved.filePath, index);
    return {
      ref: normalized.ref,
      position: normalized.position,
      content: resolved.content,
    };
  });
}
