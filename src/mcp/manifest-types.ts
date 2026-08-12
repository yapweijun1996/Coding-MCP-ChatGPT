import type { ToolGroupId } from "./tools/index.js";
import type { ToolDefinition } from "./types.js";

export interface ToolManifestEntryBase<GroupId extends string> {
  groupId: GroupId;
  definition: ToolDefinition;
  enabledByDefault: boolean;
}

export type ToolManifestEntry = ToolManifestEntryBase<ToolGroupId>;
