export type ProjectStatus = "draft" | "private" | "published" | "deleted";
export type ValidationStatus = "valid" | "warnings" | "failed" | "not_checked";

export interface ApiResult {
  ok: boolean;
  error?: string;
}

export interface SessionResult extends ApiResult {
  authenticated: boolean;
  csrfToken?: string;
  expiresAt?: string;
  user?: PublicUser;
}

export type UserRole = "admin" | "developer" | "viewer";
export type UserStatus = "pending" | "active" | "disabled";

export interface PublicUser {
  id: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  username?: string;
  publicShareUsernameEnabled: boolean;
  createdAt: string;
  approvedAt?: string;
  approvedBy?: string;
  projectRoot?: string;
}

export interface ActivityEvent {
  id: number;
  time: string;
  userId?: string;
  clientId: string;
  method: string;
  toolName?: string;
  ok: boolean;
  summary: string;
}

export interface ProjectValidationResult {
  ok: boolean;
  status: Exclude<ValidationStatus, "not_checked">;
  entryFile: string;
  filesChecked: number;
  warnings: string[];
  errors: string[];
  checkedAt: string;
  browserInspection?: {
    ok: boolean;
    blockingErrors: string[];
    warnings: string[];
    reportUrl?: string;
    inspectedAt: string;
  };
}

export interface ProjectSummary {
  id: string;
  title: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
  createdByClientId: string;
  status: ProjectStatus;
  entryFile: string;
  publishedUrl?: string;
  filesCount: number;
  lastValidation?: ProjectValidationResult;
  taskHistory?: ProjectTaskHistoryItem[];
}

export interface ProjectFileInfo {
  path: string;
  size: number;
  modifiedAt: string;
}

export interface ProjectTaskHistoryItem {
  id: string;
  time: string;
  toolName: string;
  ok: boolean;
  summary: string;
  details?: unknown;
}

export interface ProjectManifest {
  metadata: ProjectSummary;
  files: ProjectFileInfo[];
  entryFile: string;
  publishedUrl?: string;
  lastValidation?: ProjectValidationResult;
  taskHistory: ProjectTaskHistoryItem[];
}

export interface ClientStatus {
  clientId: string;
  clientName: string;
  redirectHost: string;
  ownerUserId?: string;
  activeAccessTokens: number;
  refreshTokens: number;
  lastUsedAt?: string;
  requestCount: number;
}

export interface ConnectorDetail {
  ok: boolean;
  client: ClientStatus;
  owner?: PublicUser;
  activity: ActivityEvent[];
  failures: ActivityEvent[];
  toolsUsed: string[];
}

export interface SpecialToolState {
  name: string;
  label: string;
  enabled: boolean;
  enabledUntil?: string;
  enabledBy?: string;
}

export interface SkillState {
  id: string;
  label: string;
  category: string;
  description: string;
  enabled: boolean;
  status: string;
  riskLevel: "low" | "medium" | "high";
  toolCount: number;
}

export interface ToolState {
  name: string;
  description: string;
  toolEnabled: boolean;
  enabled: boolean;
  access: "enabled" | "blocked_by_tool" | "blocked_by_skill";
  accessLabel: string;
  enabledBySkills: string[];
}

export interface PageResult<T> extends ApiResult {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  sort?: string;
}

export interface OverviewResult extends ApiResult {
  metrics: {
    connectedClients: number;
    enabledTools: number;
    projects: number;
    publishedProjects: number;
    privateProjects: number;
    draftProjects: number;
    failedValidations: number;
    activeSpecialTools: number;
    failedCalls: number;
    staleDrafts: number;
  };
  recentFailures: ActivityEvent[];
  recentProjects: ProjectSummary[];
  activeSpecialTools: SpecialToolState[];
}

export interface SettingsResult extends ApiResult {
  publicBaseUrl: string;
  workspaceRoot: string;
  projectRoot: string;
  shareRoot: string;
  artifactRoot: string;
  sessionTtlHours: number;
  registrationSettings?: RegistrationSettings;
}

export interface RegistrationSettings {
  allowRegistration: boolean;
  requireApproval: true;
  defaultRole: "developer";
  allowedEmailDomains: string[];
}

export type IssueSeverity = "low" | "medium" | "high" | "critical";
export type IssueStatus = "open" | "investigating" | "resolved" | "wontfix";

export interface FeedbackIssue {
  id: string;
  title: string;
  detail: string;
  severity: IssueSeverity;
  category: string;
  status: IssueStatus;
  toolName?: string;
  reproSteps?: string;
  context?: Record<string, unknown>;
  reportedByClientId?: string;
  reportedByUserId?: string;
  createdAt: string;
  updatedAt: string;
  resolutionNote?: string;
}

export interface FeedbackResult extends ApiResult {
  issues: FeedbackIssue[];
  stats: { total: number; open: number; byStatus: Record<IssueStatus, number> };
}

export interface TelemetryMetric {
  key: string;
  calls: number;
  errors: number;
  errorRate: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  avgMs: number | null;
}

export interface TelemetryErrorSample {
  time: string;
  toolName?: string;
  clientType?: string;
  durationMs?: number;
  errorMessage?: string;
}

export interface TelemetrySummary {
  windowDays: number;
  from: string;
  to: string;
  totalCalls: number;
  totalErrors: number;
  errorRate: number;
  byTool: TelemetryMetric[];
  byClient: TelemetryMetric[];
  recentErrors: TelemetryErrorSample[];
}

export interface TelemetryResult extends ApiResult {
  telemetry: TelemetrySummary;
}
