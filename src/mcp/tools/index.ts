import { commandTools } from "./command.js";
import { appProjectTools } from "./app-project.js";
import { blogTools } from "./blog.js";
import { gitTools } from "./git.js";
import { presentationTools } from "./presentation.js";
import { previewTools } from "./preview.js";
import { projectTools } from "./project.js";
import { projectDevTools } from "./project-dev.js";
import { researchTools } from "./research.js";
import { skillTools } from "./skills.js";
import { browserObservabilityTools } from "./browser-observability.js";
import { browserTools } from "./browser.js";
import { codeIntelligenceTools } from "./code-intelligence.js";
import { dataAnalysisTools } from "./data-analysis.js";
import { databaseAnalysisTools } from "./database-analysis.js";
import { predictionSimulationTools } from "./prediction-simulation.js";
import { fileConversionTools } from "./file-conversion.js";
import { imageWorkflowTools } from "./image-workflow.js";
import { musicWorkflowTools } from "./music-workflow.js";
import { threeDGameTools } from "./three-d-game.js";
import { asyncJobTools } from "./async-jobs.js";
import { docsKnowledgeTools } from "./docs-knowledge.js";
import { knowledgeBaseTools } from "./knowledge-base.js";
import { workflowAutomationTools } from "./workflow-automation.js";
import { testAutomationTools } from "./test-automation.js";
import { permissionScopeTools } from "./permission-scope.js";
import { auditLogTools } from "./audit-log.js";
import { agentEvaluationTools } from "./agent-evaluation.js";
import { releaseManagementTools } from "./release-management.js";
import { requirementsTrackingTools } from "./requirements-tracking.js";
import { qualityGateTools } from "./quality-gates.js";
import { fixLearningTools } from "./fix-learning.js";
import { toolOutputSearchTools } from "./tool-output-search.js";
import { complianceReviewTools } from "./compliance-review.js";
import { dataConnectorTools } from "./data-connectors.js";
import { sandboxExecutionTools } from "./sandbox-execution.js";
import { backupRecoveryTools } from "./backup-recovery.js";
import { feedbackTools } from "./feedback.js";
import { reviewFeedbackTools } from "./review-feedback.js";
import { integrationReadonlyTools } from "./integration-readonly.js";
import { mcpPlatformTools } from "./mcp-platform.js";
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
  ...dataAnalysisTools,
  ...databaseAnalysisTools,
  ...predictionSimulationTools,
  ...fileConversionTools,
  ...imageWorkflowTools,
  ...musicWorkflowTools,
  ...threeDGameTools,
  ...docsKnowledgeTools,
  ...knowledgeBaseTools,
  ...workflowAutomationTools,
  ...testAutomationTools,
  ...permissionScopeTools,
  ...auditLogTools,
  ...agentEvaluationTools,
  ...releaseManagementTools,
  ...requirementsTrackingTools,
  ...qualityGateTools,
  ...fixLearningTools,
  ...toolOutputSearchTools,
  ...complianceReviewTools,
  ...dataConnectorTools,
  ...sandboxExecutionTools,
  ...backupRecoveryTools,
  ...feedbackTools,
  ...reviewFeedbackTools,
  ...asyncJobTools,
  ...integrationReadonlyTools,
  ...mcpPlatformTools,
  ...webInspectTools,
  ...webRebuildTools,
  ...presentationTools,
  ...gitTools,
  ...appProjectTools,
  ...projectTools,
  ...projectDevTools,
  ...researchTools,
  ...shareTools,
  ...siteTools,
  ...blogTools
];
