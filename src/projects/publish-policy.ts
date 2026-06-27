import { z } from "zod";
import type { PublishProjectOptions, ProjectShareAccess } from "./store.js";

export const projectShareAccessSchema = z.enum(["private", "anyone_with_link"]);

export interface PublishUrlContext {
  publicBaseUrl: string;
  contentBaseUrl?: string;
  publicShareBasePath?: string;
}

export interface ProjectPublishPolicy {
  publicBaseUrl: string;
  options: PublishProjectOptions;
}

export const defaultProjectPublishShareAccess: ProjectShareAccess = "anyone_with_link";

export function publishBaseUrlForShareAccess(context: PublishUrlContext, shareAccess: ProjectShareAccess | undefined): string {
  return shareAccess === "anyone_with_link"
    ? context.contentBaseUrl ?? context.publicBaseUrl
    : context.publicBaseUrl;
}

export function buildProjectPublishOptions(
  context: PublishUrlContext,
  shareAccess: ProjectShareAccess = defaultProjectPublishShareAccess
): ProjectPublishPolicy {
  return {
    publicBaseUrl: publishBaseUrlForShareAccess(context, shareAccess),
    options: {
      privateBaseUrl: context.publicBaseUrl,
      shareBasePath: context.publicShareBasePath,
      shareAccess
    }
  };
}
