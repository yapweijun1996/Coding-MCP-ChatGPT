import path from "node:path";
import { listProjects } from "../projects/store.js";
import {
  getAllProjectRoots,
  getProjectRootForUser,
  getUserByProjectRoot,
  getWorkspaceRootForUser
} from "../user-store.js";
import type { StorageScope } from "./manager.js";

export interface StorageScopeConfig {
  projectRoot: string;
  workspaceRoot: string;
}

export interface StorageScopeSelection {
  userId?: string;
}

/**
 * Resolve the physical roots used by storage reporting and maintenance.
 * The returned objects intentionally keep paths internal; callers should expose
 * only the report produced by storage/manager.ts.
 */
export async function collectStorageScopes(
  config: StorageScopeConfig,
  selection: StorageScopeSelection = {}
): Promise<StorageScope[]> {
  const roots = selection.userId
    ? [await getProjectRootForUser(selection.userId)]
    : await getAllProjectRoots();
  const seen = new Set<string>();
  const scopes: StorageScope[] = [];

  for (const root of roots) {
    const normalizedRoot = path.resolve(root);
    if (seen.has(normalizedRoot)) continue;
    seen.add(normalizedRoot);

    const owner = await getUserByProjectRoot(root);
    const isConfiguredGlobalRoot = normalizedRoot === path.resolve(config.projectRoot);
    const workspaceRoot = owner
      ? await getWorkspaceRootForUser(owner.id)
      : isConfiguredGlobalRoot
        ? config.workspaceRoot
        : path.join(path.dirname(normalizedRoot), "workspace");
    const projects = await listProjects(root, true).catch(() => []);

    scopes.push({
      id: owner ? `user:${owner.id}` : isConfiguredGlobalRoot ? "global" : `unowned:${scopes.length + 1}`,
      label: owner ? `User ${owner.id}` : isConfiguredGlobalRoot ? "Global" : "Unowned project root",
      projectRoot: root,
      workspaceRoot,
      projects: projects.map((project) => ({
        id: project.id,
        title: project.title,
        status: project.status,
        workspacePath: project.workspaceBinding?.path
      }))
    });
  }

  return scopes;
}
