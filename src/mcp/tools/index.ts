import { commandTools } from "./command.js";
import { appProjectTools } from "./app-project.js";
import { blogTools } from "./blog.js";
import { gitTools } from "./git.js";
import { presentationTools } from "./presentation.js";
import { previewTools } from "./preview.js";
import { projectTools } from "./project.js";
import { researchTools } from "./research.js";
import { skillTools } from "./skills.js";
import { browserObservabilityTools } from "./browser-observability.js";
import { browserTools } from "./browser.js";
import { codeIntelligenceTools } from "./code-intelligence.js";
import { docsKnowledgeTools } from "./docs-knowledge.js";
import { integrationReadonlyTools } from "./integration-readonly.js";
import { shareTools } from "./share.js";
import { siteTools } from "./site.js";
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
  ...browserObservabilityTools,
  ...codeIntelligenceTools,
  ...docsKnowledgeTools,
  ...integrationReadonlyTools,
  ...webInspectTools,
  ...webRebuildTools,
  ...presentationTools,
  ...gitTools,
  ...appProjectTools,
  ...projectTools,
  ...researchTools,
  ...shareTools,
  ...siteTools,
  ...blogTools
];
