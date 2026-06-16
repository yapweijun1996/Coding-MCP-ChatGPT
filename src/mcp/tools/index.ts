import { commandTools } from "./command.js";
import { gitTools } from "./git.js";
import { previewTools } from "./preview.js";
import { projectTools } from "./project.js";
import { shareTools } from "./share.js";
import { webInspectTools } from "./web-inspect.js";
import { workspaceTools } from "./workspace.js";
import type { ToolModule } from "../types.js";

export const allToolModules: ToolModule[] = [
  ...previewTools,
  ...workspaceTools,
  ...commandTools,
  ...webInspectTools,
  ...gitTools,
  ...projectTools,
  ...shareTools
];
