import path from "node:path";
import { z } from "zod";
import { getProjectManifest } from "../../projects/store.js";
import { skillRegistry } from "../../skills/registry.js";
import { ensureUnderWorkspace } from "./agent-tool-utils.js";
import type { ToolModule } from "../types.js";

const operationSchema = z.enum(["read", "write", "delete", "publish", "execute", "git", "network", "admin"]);

const checkToolActionPermissionInputSchema = z.object({
  toolName: z.string().min(1).max(160),
  intendedOperation: operationSchema.optional(),
  requireApprovalForHighRisk: z.boolean().optional().default(true)
});

const checkWorkspacePathScopeInputSchema = z.object({
  paths: z.array(z.string().min(1).max(2000)).min(1).max(100),
  operation: operationSchema.optional().default("read"),
  allowHidden: z.boolean().optional().default(false)
});

const checkProjectScopeInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  paths: z.array(z.string().min(1).max(240)).max(100).optional().default([]),
  operation: operationSchema.optional().default("read")
});

const checkPublishPermissionInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  entryFile: z.string().min(1).max(240).optional(),
  requireValidLastValidation: z.boolean().optional().default(true)
});

const createRiskApprovalChecklistInputSchema = z.object({
  action: z.string().min(1).max(240),
  operation: operationSchema,
  tools: z.array(z.string().min(1).max(160)).max(50).optional().default([]),
  touchedPaths: z.array(z.string().min(1).max(2000)).max(100).optional().default([]),
  publishesExternally: z.boolean().optional().default(false),
  mutatesWorkspace: z.boolean().optional().default(false),
  destructive: z.boolean().optional().default(false)
});

const summarizePermissionScopeInputSchema = z.object({
  checks: z.array(z.record(z.string(), z.unknown())).min(1).max(100)
});

const highRiskToolNames = new Set(skillRegistry.find((skill) => skill.id === "high-risk")?.toolNames ?? []);

function pathSegments(input: string) {
  return input.replaceAll("\\", "/").split("/").filter(Boolean);
}

function checkRelativeProjectPath(relativePath: string) {
  const warnings: string[] = [];
  const errors: string[] = [];
  if (path.isAbsolute(relativePath)) errors.push("Absolute project paths are not allowed.");
  const segments = pathSegments(relativePath);
  if (segments.some((segment) => segment === "..")) errors.push("Parent traversal is not allowed.");
  if (segments.some((segment) => segment === ".")) warnings.push("Path contains redundant current-directory segments.");
  if (segments.some((segment) => segment.startsWith("."))) warnings.push("Hidden project paths should be avoided unless explicitly intended.");
  if (relativePath.length > 240) errors.push("Project path exceeds 240 characters.");
  const normalized = path.posix.normalize(relativePath.replaceAll("\\", "/"));
  return { ok: errors.length === 0, path: relativePath, normalized, errors, warnings };
}

function classifyOperationRisk(input: z.infer<typeof createRiskApprovalChecklistInputSchema>) {
  const reasons: string[] = [];
  if (input.destructive || input.operation === "delete") reasons.push("destructive operation");
  if (input.publishesExternally || input.operation === "publish") reasons.push("external publish");
  if (input.operation === "execute") reasons.push("command execution");
  if (input.operation === "admin") reasons.push("admin-scoped operation");
  if (input.tools.some((tool) => highRiskToolNames.has(tool))) reasons.push("uses high-risk skill tool");
  if (input.touchedPaths.some((item) => path.isAbsolute(item) || pathSegments(item).includes(".."))) reasons.push("path boundary risk");
  if (input.mutatesWorkspace || input.operation === "write" || input.operation === "git") reasons.push("workspace mutation");
  const unique = [...new Set(reasons)];
  const approvalRequired = unique.length > 0;
  const riskLevel = unique.some((reason) => ["destructive operation", "admin-scoped operation", "path boundary risk"].includes(reason))
    ? "high"
    : approvalRequired ? "medium" : "low";
  return {
    approvalRequired,
    riskLevel,
    reasons: unique,
    checklist: approvalRequired
      ? ["Confirm target scope and exact files/resources.", "Confirm rollback or recovery path.", "Record user/admin approval before proceeding.", "Run validation after the operation."]
      : ["Proceed within normal enabled tool and skill boundaries.", "Record evidence if the action changes deliverables."]
  };
}

export const permissionScopeTools: ToolModule[] = [
  {
    definition: {
      name: "check_tool_action_permission",
      description: "Check whether a tool is registered, enabled by tool state, enabled by an active skill, and whether high-risk approval is required.",
      inputSchema: { type: "object", properties: { toolName: { type: "string" }, intendedOperation: { type: "string" }, requireApprovalForHighRisk: { type: "boolean" } }, required: ["toolName"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: checkToolActionPermissionInputSchema,
    handler: async (input) => {
      const parsed = checkToolActionPermissionInputSchema.parse(input);
      const { getToolAccess } = await import("../../tool-state.js");
      const access = getToolAccess(parsed.toolName);
      const approvalRequired = parsed.requireApprovalForHighRisk && highRiskToolNames.has(parsed.toolName);
      const result = {
        ...access,
        intendedOperation: parsed.intendedOperation,
        highRiskTool: highRiskToolNames.has(parsed.toolName),
        approvalRequired,
        decision: access.enabled && !approvalRequired ? "allowed" : access.enabled ? "approval_required" : "blocked",
        nextActions: access.enabled
          ? approvalRequired ? ["Request explicit approval before using this high-risk tool."] : ["Tool is available through enabled tool and skill state."]
          : [`Resolve tool access first: ${access.access}.`]
      };
      return { ok: result.decision === "allowed", summary: `Tool ${parsed.toolName} permission decision: ${result.decision}.`, artifacts: [], structuredContent: result, logs: [JSON.stringify(result, null, 2)], errors: result.decision === "blocked" ? [`Tool access is ${access.access}.`] : [] };
    }
  },
  {
    definition: {
      name: "check_workspace_path_scope",
      description: "Check workspace-relative or absolute paths against the configured workspace boundary before read/write/delete operations.",
      inputSchema: { type: "object", properties: { paths: { type: "array", items: { type: "string" } }, operation: { type: "string" }, allowHidden: { type: "boolean" } }, required: ["paths"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: checkWorkspacePathScopeInputSchema,
    handler: (input, ctx) => {
      const parsed = checkWorkspacePathScopeInputSchema.parse(input);
      const checks = parsed.paths.map((candidate) => {
        const errors: string[] = [];
        const warnings: string[] = [];
        let resolved = "";
        try {
          resolved = ensureUnderWorkspace(ctx.workspaceRoot, candidate);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : "Path is outside workspace.");
        }
        const segments = pathSegments(candidate);
        if (segments.includes("..")) errors.push("Parent traversal is not allowed.");
        if (!parsed.allowHidden && segments.some((segment) => segment.startsWith("."))) warnings.push("Hidden path segment requires explicit intent.");
        return { path: candidate, resolved, operation: parsed.operation, ok: errors.length === 0, errors, warnings };
      });
      const errors = checks.flatMap((check) => check.errors.map((error) => `${check.path}: ${error}`));
      const result = { ok: errors.length === 0, workspaceRoot: ctx.workspaceRoot, checks };
      return { ok: result.ok, summary: result.ok ? `All ${checks.length} path(s) are inside workspace scope.` : `${errors.length} workspace path scope error(s).`, artifacts: [], structuredContent: result, logs: [JSON.stringify(result, null, 2)], errors };
    }
  },
  {
    definition: {
      name: "check_project_scope",
      description: "Check project status, write/delete eligibility, and project file path boundaries for a project-scoped operation.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, paths: { type: "array", items: { type: "string" } }, operation: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: checkProjectScopeInputSchema,
    handler: async (input, ctx) => {
      const parsed = checkProjectScopeInputSchema.parse(input);
      const manifest = await getProjectManifest(ctx.projectRoot, parsed.projectId);
      const pathChecks = parsed.paths.map(checkRelativeProjectPath);
      const errors = pathChecks.flatMap((check) => check.errors.map((error) => `${check.path}: ${error}`));
      if (manifest.metadata.status === "deleted" && ["write", "delete", "publish"].includes(parsed.operation)) errors.push("Deleted projects cannot be mutated or published.");
      const result = {
        ok: errors.length === 0,
        projectId: parsed.projectId,
        status: manifest.metadata.status,
        operation: parsed.operation,
        entryFile: manifest.entryFile,
        fileCount: manifest.files.length,
        pathChecks,
        writable: manifest.metadata.status !== "deleted",
        publishable: manifest.metadata.status !== "deleted" && manifest.files.some((file) => file.path === manifest.entryFile)
      };
      return { ok: result.ok, summary: result.ok ? `Project ${parsed.projectId} is in scope for ${parsed.operation}.` : `Project scope check found ${errors.length} error(s).`, jobId: parsed.projectId, artifacts: [], structuredContent: result, logs: [JSON.stringify(result, null, 2)], errors };
    }
  },
  {
    definition: {
      name: "check_publish_permission",
      description: "Check whether a project publish is in scope, has a safe entry file, and has recent passing validation when required.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, entryFile: { type: "string" }, requireValidLastValidation: { type: "boolean" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: checkPublishPermissionInputSchema,
    handler: async (input, ctx) => {
      const parsed = checkPublishPermissionInputSchema.parse(input);
      const manifest = await getProjectManifest(ctx.projectRoot, parsed.projectId);
      const entryFile = parsed.entryFile ?? manifest.entryFile;
      const entryCheck = checkRelativeProjectPath(entryFile);
      const errors = [...entryCheck.errors];
      const warnings = [...entryCheck.warnings];
      if (manifest.metadata.status === "deleted") errors.push("Deleted projects cannot be published.");
      if (!manifest.files.some((file) => file.path === entryCheck.normalized)) errors.push(`Entry file not found: ${entryCheck.normalized}.`);
      const validation = manifest.lastValidation;
      if (parsed.requireValidLastValidation && (!validation || !validation.ok || validation.entryFile !== entryCheck.normalized)) {
        errors.push("Publish requires a passing lastValidation for the selected entry file.");
      }
      if (manifest.publishedUrl) warnings.push("Project already has a published URL; publishing will update the same project route.");
      const result = {
        ok: errors.length === 0,
        projectId: parsed.projectId,
        entryFile: entryCheck.normalized,
        status: manifest.metadata.status,
        publishedUrl: manifest.publishedUrl,
        requireValidLastValidation: parsed.requireValidLastValidation,
        lastValidation: validation ?? null,
        warnings,
        nextActions: errors.length ? ["Run validate_project for the selected entry file before publish.", "Fix missing or unsafe entry file issues."] : ["Publish is in scope; proceed with publish_project or publish_and_report."]
      };
      return { ok: result.ok, summary: result.ok ? `Project ${parsed.projectId} can be published.` : `Publish permission check blocked with ${errors.length} issue(s).`, jobId: parsed.projectId, artifacts: [], structuredContent: result, logs: [JSON.stringify(result, null, 2)], errors };
    }
  },
  {
    definition: {
      name: "create_risk_approval_checklist",
      description: "Create an approval checklist for risky operations including destructive actions, publishes, command execution, git mutations, and boundary risks.",
      inputSchema: { type: "object", properties: { action: { type: "string" }, operation: { type: "string" }, tools: { type: "array", items: { type: "string" } }, touchedPaths: { type: "array", items: { type: "string" } }, publishesExternally: { type: "boolean" }, mutatesWorkspace: { type: "boolean" }, destructive: { type: "boolean" } }, required: ["action", "operation"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: createRiskApprovalChecklistInputSchema,
    handler: (input) => {
      const parsed = createRiskApprovalChecklistInputSchema.parse(input);
      const risk = classifyOperationRisk(parsed);
      const result = { action: parsed.action, operation: parsed.operation, tools: parsed.tools, touchedPaths: parsed.touchedPaths, ...risk };
      return { ok: !risk.approvalRequired, summary: `Risk approval decision for ${parsed.action}: ${risk.approvalRequired ? "approval_required" : "allowed"}.`, artifacts: [], structuredContent: result, logs: [JSON.stringify(result, null, 2)], errors: risk.approvalRequired ? risk.reasons : [] };
    }
  },
  {
    definition: {
      name: "summarize_permission_scope",
      description: "Summarize multiple permission/scope check payloads into one allow/block/approval-required decision.",
      inputSchema: { type: "object", properties: { checks: { type: "array", items: { type: "object" } } }, required: ["checks"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: summarizePermissionScopeInputSchema,
    handler: (input) => {
      const parsed = summarizePermissionScopeInputSchema.parse(input);
      const blocked = parsed.checks.filter((check) => check.ok === false || check.decision === "blocked");
      const approval = parsed.checks.filter((check) => check.approvalRequired === true || check.decision === "approval_required");
      const result = {
        ok: blocked.length === 0 && approval.length === 0,
        decision: blocked.length ? "blocked" : approval.length ? "approval_required" : "allowed",
        checkCount: parsed.checks.length,
        blockedCount: blocked.length,
        approvalRequiredCount: approval.length,
        nextActions: blocked.length ? ["Resolve blocked scope or permission checks before proceeding."] : approval.length ? ["Record explicit approval before proceeding."] : ["Proceed and record validation evidence."]
      };
      return { ok: result.ok, summary: `Permission scope summary decision: ${result.decision}.`, artifacts: [], structuredContent: result, logs: [JSON.stringify(result, null, 2)], errors: result.decision === "allowed" ? [] : result.nextActions };
    }
  }
];
