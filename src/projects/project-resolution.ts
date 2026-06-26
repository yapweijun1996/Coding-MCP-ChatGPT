import type { ProjectMetadata, ProjectSummary } from "./store.js";
import { getProject, listProjects } from "./store.js";
import {
  getAllProjectRoots,
  getProjectRootForUser,
  getUserByProjectRoot,
  type PublicUser
} from "../user-store.js";

export interface ProjectResolution {
  root: string;
  project: ProjectMetadata;
  owner?: PublicUser;
}

export async function listVisibleProjectsForUser(user: PublicUser, includeDeleted: boolean): Promise<ProjectSummary[]> {
  if (user.role !== "admin") return listProjects(await getProjectRootForUser(user.id), includeDeleted);
  const roots = await getAllProjectRoots();
  const projects = await Promise.all(roots.map((root) => listProjects(root, includeDeleted).catch(() => [] as ProjectSummary[])));
  return projects.flat();
}

export async function requestedProjectRootForUser(user: PublicUser, requestedUserId?: string): Promise<string> {
  if (user.role === "admin" && requestedUserId) return getProjectRootForUser(requestedUserId);
  return getProjectRootForUser(user.id);
}

export async function resolveProjectRootForUser(user: PublicUser, projectId: string, requestedUserId?: string): Promise<string> {
  const firstRoot = await requestedProjectRootForUser(user, requestedUserId);
  try {
    await getProject(firstRoot, projectId);
    return firstRoot;
  } catch {
    if (user.role !== "admin") throw new Error("Project not found.");
  }

  for (const root of await getAllProjectRoots()) {
    try {
      await getProject(root, projectId);
      return root;
    } catch {
      continue;
    }
  }
  throw new Error("Project not found.");
}

export async function resolveProjectForUser(user: PublicUser, projectId: string, requestedUserId?: string): Promise<ProjectResolution> {
  const root = await resolveProjectRootForUser(user, projectId, requestedUserId);
  const [project, owner] = await Promise.all([
    getProject(root, projectId),
    getUserByProjectRoot(root)
  ]);
  return { root, project, owner };
}

export async function resolveProjectAcrossRoots(
  projectId: string,
  options: { preferredProjectRoot?: string } = {}
): Promise<ProjectResolution> {
  const roots = [
    ...(options.preferredProjectRoot ? [options.preferredProjectRoot] : []),
    ...(await getAllProjectRoots())
  ];
  const seen = new Set<string>();

  for (const root of roots) {
    if (seen.has(root)) continue;
    seen.add(root);
    try {
      const project = await getProject(root, projectId);
      const owner = await getUserByProjectRoot(root);
      return { root, project, owner };
    } catch {
      continue;
    }
  }

  throw new Error("Project not found.");
}
