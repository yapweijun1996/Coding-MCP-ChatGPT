import type { ToolModule } from "../types.js";

export type ToolGroupLoader = () => Promise<ToolModule[]>;

// This is the only runtime mapping from a manifest group to its implementation module.
// Keep each import dynamic: tool definitions live in the generated static manifest, while
// handlers and zod schemas enter memory only when their group is warmed or first invoked.
export const toolGroupLoaders = {
  preview: async () => (await import("./preview.js")).previewTools,
  skills: async () => (await import("./skills.js")).skillTools,
  workspace: async () => (await import("./workspace.js")).workspaceTools,
  storage: async () => (await import("./storage.js")).storageTools,
  conversationFile: async () => (await import("./conversation-file.js")).conversationFileTools,
  command: async () => (await import("./command.js")).commandTools,
  browser: async () => (await import("./browser.js")).browserTools,
  browserObservability: async () => (await import("./browser-observability.js")).browserObservabilityTools,
  codeIntelligence: async () => (await import("./code-intelligence.js")).codeIntelligenceTools,
  dataAnalysis: async () => (await import("./data-analysis.js")).dataAnalysisTools,
  databaseAnalysis: async () => (await import("./database-analysis.js")).databaseAnalysisTools,
  predictionSimulation: async () => (await import("./prediction-simulation.js")).predictionSimulationTools,
  mathVerification: async () => (await import("./math-verification.js")).mathVerificationTools,
  usageCost: async () => (await import("./usage-cost.js")).usageCostTools,
  envConfig: async () => (await import("./env-config.js")).envConfigTools,
  modelComparison: async () => (await import("./model-comparison.js")).modelComparisonTools,
  fileConversion: async () => (await import("./file-conversion.js")).fileConversionTools,
  exportPackage: async () => (await import("./export-package.js")).exportPackageTools,
  notifications: async () => (await import("./notifications.js")).notificationTools,
  imageWorkflow: async () => (await import("./image-workflow.js")).imageWorkflowTools,
  svgDesignStudio: async () => (await import("./svg-design-studio.js")).svgDesignStudioTools,
  musicWorkflow: async () => (await import("./music-workflow.js")).musicWorkflowTools,
  musicProductionOrchestrator: async () => (await import("./music-production-orchestrator.js")).musicProductionOrchestratorTools,
  videoEditor: async () => (await import("./video-editor.js")).videoEditorTools,
  threeDGame: async () => (await import("./three-d-game.js")).threeDGameTools,
  docsKnowledge: async () => (await import("./docs-knowledge.js")).docsKnowledgeTools,
  knowledgeBase: async () => (await import("./knowledge-base.js")).knowledgeBaseTools,
  workflowAutomation: async () => (await import("./workflow-automation.js")).workflowAutomationTools,
  testAutomation: async () => (await import("./test-automation.js")).testAutomationTools,
  accessibilityAutofix: async () => (await import("./accessibility-autofix.js")).accessibilityAutofixTools,
  permissionScope: async () => (await import("./permission-scope.js")).permissionScopeTools,
  publicApi: async () => (await import("./public-api.js")).publicApiTools,
  hotelSearch: async () => (await import("./hotel-search.js")).hotelSearchTools,
  flightSearch: async () => (await import("./flight-search.js")).flightSearchTools,
  auditLog: async () => (await import("./audit-log.js")).auditLogTools,
  agentEvaluation: async () => (await import("./agent-evaluation.js")).agentEvaluationTools,
  releaseManagement: async () => (await import("./release-management.js")).releaseManagementTools,
  requirementsTracking: async () => (await import("./requirements-tracking.js")).requirementsTrackingTools,
  qualityGates: async () => (await import("./quality-gates.js")).qualityGateTools,
  fixLearning: async () => (await import("./fix-learning.js")).fixLearningTools,
  toolOutputSearch: async () => (await import("./tool-output-search.js")).toolOutputSearchTools,
  complianceReview: async () => (await import("./compliance-review.js")).complianceReviewTools,
  dataConnectors: async () => (await import("./data-connectors.js")).dataConnectorTools,
  sandboxExecution: async () => (await import("./sandbox-execution.js")).sandboxExecutionTools,
  backupRecovery: async () => (await import("./backup-recovery.js")).backupRecoveryTools,
  feedback: async () => (await import("./feedback.js")).feedbackTools,
  reviewFeedback: async () => (await import("./review-feedback.js")).reviewFeedbackTools,
  asyncJobs: async () => (await import("./async-jobs.js")).asyncJobTools,
  integrationReadonly: async () => (await import("./integration-readonly.js")).integrationReadonlyTools,
  mcpPlatform: async () => (await import("./mcp-platform.js")).mcpPlatformTools,
  mcpPluginRegistry: async () => (await import("./mcp-plugin-registry.js")).mcpPluginRegistryTools,
  webInspect: async () => (await import("./web-inspect.js")).webInspectTools,
  webRebuild: async () => (await import("./web-rebuild.js")).webRebuildTools,
  presentation: async () => (await import("./presentation.js")).presentationTools,
  git: async () => (await import("./git.js")).gitTools,
  appProject: async () => (await import("./app-project.js")).appProjectTools,
  mockApi: async () => (await import("./mock-api.js")).mockApiTools,
  mockData: async () => (await import("./mock-data.js")).mockDataTools,
  securityScan: async () => (await import("./security-scan.js")).securityScanTools,
  projectReviewComments: async () => (await import("./project-review-comments.js")).projectReviewCommentTools,
  projectCodeReview: async () => (await import("./project-code-review.js")).projectCodeReviewTools,
  designSystemAudit: async () => (await import("./design-system-audit.js")).designSystemAuditTools,
  i18nAudit: async () => (await import("./i18n-audit.js")).i18nAuditTools,
  seoMetaAudit: async () => (await import("./seo-meta-audit.js")).seoMetaAuditTools,
  errorClassification: async () => (await import("./error-classification.js")).errorClassificationTools,
  assetOptimization: async () => (await import("./asset-optimization.js")).assetOptimizationTools,
  svgOptimization: async () => (await import("./svg-optimization.js")).svgOptimizationTools,
  projectDocs: async () => (await import("./project-docs.js")).projectDocsTools,
  componentLibrary: async () => (await import("./component-library.js")).componentLibraryTools,
  componentRegistry: async () => (await import("./component-registry.js")).componentRegistryTools,
  legacyModernization: async () => (await import("./legacy-modernization.js")).legacyModernizationTools,
  demoMonitoring: async () => (await import("./demo-monitoring.js")).demoMonitoringTools,
  demoFeedback: async () => (await import("./demo-feedback.js")).demoFeedbackTools,
  demoAnalytics: async () => (await import("./demo-analytics.js")).demoAnalyticsTools,
  projectTemplates: async () => (await import("./project-templates.js")).projectTemplateTools,
  workflowLibrary: async () => (await import("./workflow-library.js")).workflowLibraryTools,
  contentWorkflow: async () => (await import("./content-workflow.js")).contentWorkflowTools,
  project: async () => (await import("./project.js")).projectTools,
  projectDev: async () => (await import("./project-dev.js")).projectDevTools,
  research: async () => (await import("./research.js")).researchTools,
  share: async () => (await import("./share.js")).shareTools,
  site: async () => (await import("./site.js")).siteTools,
  blog: async () => (await import("./blog.js")).blogTools
} satisfies Record<string, ToolGroupLoader>;

export type ToolGroupId = keyof typeof toolGroupLoaders;

// Common project/file operations are ready when the registry resolves. Heavy browser,
// music, presentation, SVG and 3D domains intentionally stay cold until first use.
export const hotToolGroupIds = [
  "preview",
  "skills",
  "workspace",
  "storage",
  "conversationFile",
  "command",
  "codeIntelligence",
  "sandboxExecution",
  "asyncJobs",
  "project",
  "projectDev",
  "git",
  "appProject"
] as const satisfies readonly ToolGroupId[];

// Capacity-sensitive domains that must not enter the server discovery path. Registry checks
// and startup benchmarks use this list as the regression contract.
export const heavyToolGroupIds = [
  "browser",
  "browserObservability",
  "musicWorkflow",
  "musicProductionOrchestrator",
  "presentation",
  "svgDesignStudio",
  "threeDGame",
  "webInspect",
  "webRebuild"
] as const satisfies readonly ToolGroupId[];

export async function loadAllToolModules(): Promise<ToolModule[]> {
  const groups = await Promise.all(Object.values(toolGroupLoaders).map((load) => load()));
  return groups.flat();
}
