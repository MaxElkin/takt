import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * agy binds a headless run to a project, and a run started without `--project`
 * lands on an empty default one: no trusted workspace and none of the user's
 * permission grants, so the agent is denied even reading the files it was
 * pointed at. Interactive sessions never show this because they are always in
 * a real project.
 *
 * The provider therefore resolves the project from the working directory the
 * same way a person would, by looking for the project whose folder contains it.
 */
const PROJECTS_DIR = join(homedir(), '.gemini', 'config', 'projects');

interface ProjectResource {
  gitFolder?: { folderUri?: string };
}

function folderPathsOf(project: Record<string, unknown>): string[] {
  const resources = (project.projectResources as { resources?: ProjectResource[] } | undefined)
    ?.resources;
  if (!Array.isArray(resources)) return [];
  return resources.flatMap((resource) => {
    const uri = resource.gitFolder?.folderUri;
    if (typeof uri !== 'string' || !uri.startsWith('file://')) return [];
    try {
      return [resolve(fileURLToPath(uri))];
    } catch {
      return [];
    }
  });
}

function contains(folder: string, target: string): boolean {
  return target === folder || target.startsWith(folder.endsWith(sep) ? folder : folder + sep);
}

/**
 * The name of the agy project whose folder contains `cwd`, or undefined when
 * none does. The most specific folder wins, so a project registered on a
 * subdirectory beats one registered on its parent.
 */
export function resolveAntigravityProject(cwd: string): string | undefined {
  const target = resolve(cwd);
  let best: { name: string; length: number } | undefined;

  let entries: string[];
  try {
    entries = readdirSync(PROJECTS_DIR).filter((entry) => entry.endsWith('.json'));
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    let project: Record<string, unknown>;
    try {
      project = JSON.parse(readFileSync(join(PROJECTS_DIR, entry), 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    const name = project.name;
    if (typeof name !== 'string' || name.length === 0) continue;

    for (const folder of folderPathsOf(project)) {
      if (contains(folder, target) && (best === undefined || folder.length > best.length)) {
        best = { name, length: folder.length };
      }
    }
  }

  return best?.name;
}
