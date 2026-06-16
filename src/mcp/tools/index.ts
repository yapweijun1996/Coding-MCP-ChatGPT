import { commandTools } from "./command.js";
import { gitTools } from "./git.js";
import { presentationTools } from "./presentation.js";
import { previewTools } from "./preview.js";
import { projectTools } from "./project.js";
import { researchTools } from "./research.js";
import { skillTools } from "./skills.js";
import { browserTools } from "./browser.js";
import { shareTools } from "./share.js";
import { webInspectTools } from "./web-inspect.js";
import { webRebuildTools } from "./web-rebuild.js";
import { workspaceTools } from "./workspace.js";
import type { ToolModule } from "../types.js";

export const allToolModules: ToolModule[] = [
  ...previewTools,
  ...skillTools,
  ...workspaceTools,
  ...commandTools,
  ...browserTools,
  ...webInspectTools,
  ...webRebuildTools,
  ...presentationTools,
  ...gitTools,
  ...projectTools,
  ...researchTools,
  ...shareTools
];
