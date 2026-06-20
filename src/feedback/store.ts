import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "../shared/atomic-write.js";
import { withKeyedLock } from "../shared/keyed-lock.js";

export type IssueSeverity = "low" | "medium" | "high" | "critical";
export type IssueCategory =
  | "tool_error"
  | "tool_missing"
  | "tool_unclear"
  | "auth"
  | "performance"
  | "docs"
  | "other";
export type IssueStatus = "open" | "investigating" | "resolved" | "wontfix";

export interface FeedbackIssue {
  id: string;
  title: string;
  detail: string;
  severity: IssueSeverity;
  category: IssueCategory;
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

export interface ReportIssueInput {
  title: string;
  detail: string;
  severity: IssueSeverity;
  category: IssueCategory;
  toolName?: string;
  reproSteps?: string;
  context?: Record<string, unknown>;
  reportedByClientId?: string;
  reportedByUserId?: string;
}

export interface ListIssuesFilter {
  status?: IssueStatus;
  severity?: IssueSeverity;
  category?: IssueCategory;
  toolName?: string;
  limit?: number;
}

export interface UpdateIssueStatusInput {
  id: string;
  status: IssueStatus;
  resolutionNote?: string;
}

const issuesFileName = "issues.json";
const idPattern = /^issue_(\d{4,})$/;

function issuesFilePath(feedbackRoot: string): string {
  return path.join(feedbackRoot, issuesFileName);
}

// Key the lock on the concrete file path so concurrent report/update calls to the
// same inbox serialize their read-modify-write, while unrelated roots stay parallel.
function lockKey(feedbackRoot: string): string {
  return `feedback:${issuesFilePath(feedbackRoot)}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSeverity(value: unknown): value is IssueSeverity {
  return value === "low" || value === "medium" || value === "high" || value === "critical";
}

function isCategory(value: unknown): value is IssueCategory {
  return (
    value === "tool_error" ||
    value === "tool_missing" ||
    value === "tool_unclear" ||
    value === "auth" ||
    value === "performance" ||
    value === "docs" ||
    value === "other"
  );
}

function isStatus(value: unknown): value is IssueStatus {
  return value === "open" || value === "investigating" || value === "resolved" || value === "wontfix";
}

function parseIssue(value: Record<string, unknown>, fallbackId: string): FeedbackIssue {
  const id = typeof value.id === "string" && idPattern.test(value.id) ? value.id : fallbackId;
  return {
    id,
    title: String(value.title ?? ""),
    detail: String(value.detail ?? ""),
    severity: isSeverity(value.severity) ? value.severity : "medium",
    category: isCategory(value.category) ? value.category : "other",
    status: isStatus(value.status) ? value.status : "open",
    toolName: typeof value.toolName === "string" ? value.toolName : undefined,
    reproSteps: typeof value.reproSteps === "string" ? value.reproSteps : undefined,
    context: isPlainObject(value.context) ? value.context : undefined,
    reportedByClientId: typeof value.reportedByClientId === "string" ? value.reportedByClientId : undefined,
    reportedByUserId: typeof value.reportedByUserId === "string" ? value.reportedByUserId : undefined,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
    resolutionNote: typeof value.resolutionNote === "string" ? value.resolutionNote : undefined
  };
}

async function readIssuesUnlocked(feedbackRoot: string): Promise<FeedbackIssue[]> {
  let raw: string;
  try {
    raw = await readFile(issuesFilePath(feedbackRoot), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const trimmed = raw.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`${issuesFileName} is corrupt and is not valid JSON.`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${issuesFileName} must contain a JSON array.`);
  return parsed.map((item, index) =>
    parseIssue(isPlainObject(item) ? item : {}, `issue_${String(index + 1).padStart(4, "0")}`)
  );
}

async function writeIssuesUnlocked(feedbackRoot: string, issues: FeedbackIssue[]): Promise<void> {
  await mkdir(feedbackRoot, { recursive: true });
  await atomicWrite(issuesFilePath(feedbackRoot), `${JSON.stringify(issues, null, 2)}\n`);
}

// Derive the next id from the max existing numeric suffix (not array length) so ids
// stay unique even if an issue is ever deleted.
function nextIssueId(issues: FeedbackIssue[]): string {
  const maxIndex = issues.reduce((max, issue) => {
    const match = idPattern.exec(issue.id);
    if (!match) return max;
    return Math.max(max, Number.parseInt(match[1], 10));
  }, 0);
  return `issue_${String(maxIndex + 1).padStart(4, "0")}`;
}

export async function reportIssue(feedbackRoot: string, input: ReportIssueInput): Promise<FeedbackIssue> {
  return withKeyedLock(lockKey(feedbackRoot), async () => {
    const issues = await readIssuesUnlocked(feedbackRoot);
    const now = new Date().toISOString();
    const issue: FeedbackIssue = {
      id: nextIssueId(issues),
      title: input.title.trim(),
      detail: input.detail.trim(),
      severity: input.severity,
      category: input.category,
      status: "open",
      toolName: input.toolName?.trim() || undefined,
      reproSteps: input.reproSteps?.trim() || undefined,
      context: input.context,
      reportedByClientId: input.reportedByClientId,
      reportedByUserId: input.reportedByUserId,
      createdAt: now,
      updatedAt: now
    };
    await writeIssuesUnlocked(feedbackRoot, [...issues, issue]);
    return issue;
  });
}

export async function listIssues(feedbackRoot: string, filter: ListIssuesFilter = {}): Promise<FeedbackIssue[]> {
  const issues = await readIssuesUnlocked(feedbackRoot);
  const filtered = issues.filter((issue) => {
    if (filter.status && issue.status !== filter.status) return false;
    if (filter.severity && issue.severity !== filter.severity) return false;
    if (filter.category && issue.category !== filter.category) return false;
    if (filter.toolName && issue.toolName !== filter.toolName) return false;
    return true;
  });
  // Newest first so the team triages recent agent pain before stale items.
  filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return typeof filter.limit === "number" ? filtered.slice(0, filter.limit) : filtered;
}

export async function updateIssueStatus(
  feedbackRoot: string,
  input: UpdateIssueStatusInput
): Promise<FeedbackIssue> {
  return withKeyedLock(lockKey(feedbackRoot), async () => {
    const issues = await readIssuesUnlocked(feedbackRoot);
    const index = issues.findIndex((issue) => issue.id === input.id);
    if (index === -1) throw new Error(`No reported issue with id ${input.id}.`);
    const updated: FeedbackIssue = {
      ...issues[index],
      status: input.status,
      resolutionNote: input.resolutionNote?.trim() || issues[index].resolutionNote,
      updatedAt: new Date().toISOString()
    };
    const next = [...issues];
    next[index] = updated;
    await writeIssuesUnlocked(feedbackRoot, next);
    return updated;
  });
}

export async function getIssueStats(feedbackRoot: string): Promise<{
  total: number;
  open: number;
  byStatus: Record<IssueStatus, number>;
}> {
  const issues = await readIssuesUnlocked(feedbackRoot);
  const byStatus: Record<IssueStatus, number> = { open: 0, investigating: 0, resolved: 0, wontfix: 0 };
  for (const issue of issues) byStatus[issue.status] += 1;
  return { total: issues.length, open: byStatus.open, byStatus };
}
