import type { ProjectMetadata } from "../projects/store.js";
import { resolveProjectAcrossRoots } from "../projects/project-resolution.js";
import type { PublicUser } from "../user-store.js";

export interface HomepageProjectResolution {
  root: string;
  project: ProjectMetadata;
  owner: PublicUser;
}

export async function resolveHomepageProjectForSet(
  projectId: string,
  options: { preferredProjectRoot?: string } = {}
): Promise<HomepageProjectResolution> {
  const resolved = await resolveProjectAcrossRoots(projectId, options);
  if (resolved.project.status !== "published") {
    throw new Error("Project must be published before it can be the homepage.");
  }
  if (resolved.project.shareAccess !== "anyone_with_link") {
    throw new Error("Project must be public before it can be the homepage.");
  }
  if (!resolved.owner) throw new Error("Could not resolve the project owner.");
  return { root: resolved.root, project: resolved.project, owner: resolved.owner };
}
