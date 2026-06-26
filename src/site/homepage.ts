import type { ProjectMetadata } from "../projects/store.js";
import { getProject } from "../projects/store.js";
import { getAllProjectRoots, getUserByProjectRoot, type PublicUser } from "../user-store.js";

export interface HomepageProjectResolution {
  root: string;
  project: ProjectMetadata;
  owner: PublicUser;
}

export async function resolveHomepageProjectForSet(
  projectId: string,
  options: { preferredProjectRoot?: string } = {}
): Promise<HomepageProjectResolution> {
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
      if (project.status !== "published") {
        throw new Error("Project must be published before it can be the homepage.");
      }
      const owner = await getUserByProjectRoot(root);
      if (!owner) throw new Error("Could not resolve the project owner.");
      return { root, project, owner };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "Project must be published before it can be the homepage." || message === "Could not resolve the project owner.") {
        throw error;
      }
      continue;
    }
  }

  throw new Error("Project not found.");
}
