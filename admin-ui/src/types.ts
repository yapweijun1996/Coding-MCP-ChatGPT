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
}

export interface ActivityEvent {
  id: number;
  time: string;
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
  activeAccessTokens: number;
  refreshTokens: number;
  lastUsedAt?: string;
  requestCount: number;
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
}
