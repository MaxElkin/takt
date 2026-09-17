import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { WorkflowStep } from '../../../core/models/index.js';
import { getResourcesDir } from '../../resources/index.js';
import {
  getGlobalSchemasDir,
  getProjectSchemasDir,
  isPathSafe,
} from '../paths.js';
import { readRegularFileNoFollow } from '../../../shared/utils/private-file.js';
import { isPathInside, lstatIfExists } from '../../../shared/utils/pathBoundary.js';

const SAFE_SCHEMA_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function validateSchemaName(schemaName: string, field: string): string {
  const segments = schemaName.split('/');
  if (
    schemaName.length === 0
    || segments.some((segment) => !SAFE_SCHEMA_NAME_PATTERN.test(segment))
  ) {
    throw new Error(`Invalid ${field} "${schemaName}": expected schema identifier or namespaced schema reference`);
  }
  return schemaName;
}

interface SchemaLookupDir {
  readonly path: string;
  readonly allowProjectSymlinks: boolean;
}

function readSchemaFile(
  root: string,
  schemaPath: string,
  projectRoot?: string,
): string | undefined {
  const rootStats = lstatIfExists(root);
  if (
    projectRoot !== undefined
    && rootStats !== null
    && (rootStats.isSymbolicLink() || !rootStats.isDirectory())
  ) {
    throw new Error(`Schema root must be a directory and must not be a symlink: ${root}`);
  }

  const resolvedRoot = resolve(root);
  if (!isPathInside(resolvedRoot, schemaPath)) {
    throw new Error(`Invalid schema path: ${schemaPath}`);
  }

  if (projectRoot !== undefined) {
    if (!isPathSafe(projectRoot, resolvedRoot)) {
      throw new Error(`Schema root must stay inside the project: ${root}`);
    }
    if (!isPathSafe(projectRoot, schemaPath)) {
      throw new Error(`Schema must stay inside the project: ${schemaPath}`);
    }
    const stats = lstatIfExists(schemaPath);
    if (stats === null) return undefined;
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`Schema must be a regular file and must not be a symlink: ${schemaPath}`);
    }
    return readRegularFileNoFollow(schemaPath, stats).toString('utf-8');
  }

  if (!existsSync(schemaPath)) return undefined;
  if (!isPathSafe(resolvedRoot, schemaPath)) {
    throw new Error(`Invalid schema path: ${schemaPath}`);
  }
  return readFileSync(schemaPath, 'utf-8');
}

function resolveSchemaFile(
  schemaName: string,
  lookupDirs: readonly SchemaLookupDir[],
  projectRoot: string,
): { schemaPath: string; content: string } | undefined {
  for (const lookupDir of lookupDirs) {
    const schemaPath = resolve(lookupDir.path, `${schemaName}.json`);
    const projectSchemaRoot = lookupDir.allowProjectSymlinks ? projectRoot : undefined;
    const content = readSchemaFile(lookupDir.path, schemaPath, projectSchemaRoot);
    if (content !== undefined) {
      return { schemaPath, content };
    }
  }
  return undefined;
}

interface StructuredOutputResolutionOptions {
  readonly projectDir: string;
  readonly resourceRoot?: string;
}

export function resolveStructuredOutput(
  step: { structured_output?: { schema_ref: string } },
  workflowSchemas: Record<string, string> | undefined,
  options: StructuredOutputResolutionOptions,
): WorkflowStep['structuredOutput'] {
  const schemaRef = step.structured_output?.schema_ref;
  if (!schemaRef) {
    return undefined;
  }

  const schemaName = validateSchemaName(workflowSchemas?.[schemaRef] ?? schemaRef, 'schema_ref');
  const candidateDirs: readonly SchemaLookupDir[] = options.resourceRoot === undefined
    ? [
      { path: getProjectSchemasDir(options.projectDir), allowProjectSymlinks: true },
      { path: getGlobalSchemasDir(), allowProjectSymlinks: false },
      { path: join(getResourcesDir(), 'schemas'), allowProjectSymlinks: false },
    ]
    : [{ path: join(options.resourceRoot, 'schemas'), allowProjectSymlinks: false }];
  const resolvedSchema = resolveSchemaFile(schemaName, candidateDirs, options.projectDir);

  if (!resolvedSchema) {
    throw new Error(`Structured output schema not found for ref "${schemaRef}"`);
  }

  return {
    schemaRef,
    schema: JSON.parse(resolvedSchema.content) as Record<string, unknown>,
  };
}
