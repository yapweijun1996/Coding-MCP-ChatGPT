import { commandTools } from "./command.js";
import { appProjectTools } from "./app-project.js";
import { blogTools } from "./blog.js";
import { mockApiTools } from "./mock-api.js";
import { mockDataTools } from "./mock-data.js";
import { securityScanTools } from "./security-scan.js";
import { projectReviewCommentTools } from "./project-review-comments.js";
import { projectCodeReviewTools } from "./project-code-review.js";
import { designSystemAuditTools } from "./design-system-audit.js";
import { i18nAuditTools } from "./i18n-audit.js";
import { seoMetaAuditTools } from "./seo-meta-audit.js";
import { errorClassificationTools } from "./error-classification.js";
import { assetOptimizationTools } from "./asset-optimization.js";
import { svgOptimizationTools } from "./svg-optimization.js";
import { projectDocsTools } from "./project-docs.js";
import { componentLibraryTools } from "./component-library.js";
import { componentRegistryTools } from "./component-registry.js";
import { legacyModernizationTools } from "./legacy-modernization.js";
import { demoMonitoringTools } from "./demo-monitoring.js";
import { demoFeedbackTools } from "./demo-feedback.js";
import { demoAnalyticsTools } from "./demo-analytics.js";
import { projectTemplateTools } from "./project-templates.js";
import { workflowLibraryTools } from "./workflow-library.js";
import { contentWorkflowTools } from "./content-workflow.js";
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
import { mathVerificationTools } from "./math-verification.js";
import { usageCostTools } from "./usage-cost.js";
import { envConfigTools } from "./env-config.js";
import { modelComparisonTools } from "./model-comparison.js";
import { fileConversionTools } from "./file-conversion.js";
import { exportPackageTools } from "./export-package.js";
import { notificationTools } from "./notifications.js";
import { imageWorkflowTools } from "./image-workflow.js";
import { svgDesignStudioTools } from "./svg-design-studio.js";
import { musicWorkflowTools } from "./music-workflow.js";
import { videoEditorTools } from "./video-editor.js";
import { threeDGameTools } from "./three-d-game.js";
import { asyncJobTools } from "./async-jobs.js";
import { docsKnowledgeTools } from "./docs-knowledge.js";
import { knowledgeBaseTools } from "./knowledge-base.js";
import { workflowAutomationTools } from "./workflow-automation.js";
import { testAutomationTools } from "./test-automation.js";
import { accessibilityAutofixTools } from "./accessibility-autofix.js";
import { permissionScopeTools } from "./permission-scope.js";
import { publicApiTools } from "./public-api.js";
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
import { mcpPluginRegistryTools } from "./mcp-plugin-registry.js";
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
  ...mathVerificationTools,
  ...usageCostTools,
  ...envConfigTools,
  ...modelComparisonTools,
  ...fileConversionTools,
  ...exportPackageTools,
  ...notificationTools,
  ...imageWorkflowTools,
  ...svgDesignStudioTools,
  ...musicWorkflowTools,
  ...videoEditorTools,
  ...threeDGameTools,
  ...docsKnowledgeTools,
  ...knowledgeBaseTools,
  ...workflowAutomationTools,
  ...testAutomationTools,
  ...accessibilityAutofixTools,
  ...permissionScopeTools,
  ...publicApiTools,
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
  ...mcpPluginRegistryTools,
  ...webInspectTools,
  ...webRebuildTools,
  ...presentationTools,
  ...gitTools,
  ...appProjectTools,
  ...mockApiTools,
  ...mockDataTools,
  ...securityScanTools,
  ...projectReviewCommentTools,
  ...projectCodeReviewTools,
  ...designSystemAuditTools,
  ...i18nAuditTools,
  ...seoMetaAuditTools,
  ...errorClassificationTools,
  ...assetOptimizationTools,
  ...svgOptimizationTools,
  ...projectDocsTools,
  ...componentLibraryTools,
  ...componentRegistryTools,
  ...legacyModernizationTools,
  ...demoMonitoringTools,
  ...demoFeedbackTools,
  ...demoAnalyticsTools,
  ...projectTemplateTools,
  ...workflowLibraryTools,
  ...contentWorkflowTools,
  ...projectTools,
  ...projectDevTools,
  ...researchTools,
  ...shareTools,
  ...siteTools,
  ...blogTools
];
