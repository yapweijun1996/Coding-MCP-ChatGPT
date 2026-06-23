import { z } from "zod";
import { writeProjectFile } from "../../projects/store.js";
import type { ToolContext, ToolModule } from "../types.js";

const triggerSchema = z.object({
  type: z.enum(["manual", "schedule", "webhook", "event", "file_change"]),
  name: z.string().min(1).max(120),
  config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().default({})
});

const retrySchema = z.object({
  maxAttempts: z.number().int().min(1).max(20).optional().default(1),
  backoff: z.enum(["none", "fixed", "exponential"]).optional().default("none"),
  delaySeconds: z.number().int().min(0).max(86400).optional().default(0)
});

const approvalSchema = z.object({
  required: z.boolean().optional().default(false),
  approvers: z.array(z.string().min(1).max(120)).max(20).optional().default([]),
  timeoutMinutes: z.number().int().min(1).max(43200).optional()
});

const notificationSchema = z.object({
  channel: z.enum(["log", "email", "webhook", "slack", "dashboard"]),
  on: z.array(z.enum(["start", "success", "failure", "approval_required", "retry", "recovered"])).min(1).max(6),
  target: z.string().min(1).max(240).optional()
});

const stepSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  name: z.string().min(1).max(160),
  action: z.string().min(1).max(240),
  dependsOn: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)).max(30).optional().default([]),
  retry: retrySchema.optional().default({}),
  approval: approvalSchema.optional().default({}),
  timeoutSeconds: z.number().int().min(1).max(86400).optional().default(300),
  recovery: z.string().min(1).max(500).optional()
});

const workflowSpecSchema = z.object({
  name: z.string().min(1).max(160),
  description: z.string().min(1).max(1000).optional(),
  triggers: z.array(triggerSchema).min(1).max(20),
  steps: z.array(stepSchema).min(1).max(200),
  notifications: z.array(notificationSchema).max(50).optional().default([]),
  logs: z.object({
    retainDays: z.number().int().min(1).max(3650).optional().default(30),
    includeInputs: z.boolean().optional().default(false),
    includeOutputs: z.boolean().optional().default(true)
  }).optional().default({}),
  failurePolicy: z.enum(["stop", "continue", "compensate"]).optional().default("stop")
});

const createWorkflowAutomationSpecInputSchema = workflowSpecSchema.extend({
  projectId: z.string().min(8).max(80),
  outputPath: z.string().min(1).max(240).optional().default("workflow-automation/workflow-spec.json")
});

const validateWorkflowAutomationSpecInputSchema = z.object({
  spec: workflowSpecSchema
});

const simulateWorkflowExecutionInputSchema = z.object({
  spec: workflowSpecSchema,
  failStepIds: z.array(z.string().min(1).max(80)).max(50).optional().default([]),
  approvedStepIds: z.array(z.string().min(1).max(80)).max(50).optional().default([])
});

const createWorkflowSchedulePlanInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  workflowName: z.string().min(1).max(160),
  schedules: z.array(z.object({
    name: z.string().min(1).max(120),
    cron: z.string().min(1).max(120),
    timezone: z.string().min(1).max(80).optional().default("UTC"),
    enabled: z.boolean().optional().default(true)
  })).min(1).max(50),
  outputPath: z.string().min(1).max(240).optional().default("workflow-automation/schedule-plan.json")
});

const createWorkflowRecoveryPlanInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  workflowName: z.string().min(1).max(160),
  failureModes: z.array(z.object({
    stepId: z.string().min(1).max(80),
    failure: z.string().min(1).max(240),
    detection: z.string().min(1).max(240),
    recovery: z.string().min(1).max(500),
    notify: z.array(z.string().min(1).max(120)).max(20).optional().default([])
  })).min(1).max(100),
  outputPath: z.string().min(1).max(240).optional().default("workflow-automation/recovery-plan.json")
});

const exportWorkflowAutomationReportInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  title: z.string().min(1).max(160),
  spec: workflowSpecSchema.optional(),
  validation: z.record(z.string(), z.unknown()).optional().default({}),
  simulation: z.record(z.string(), z.unknown()).optional().default({}),
  findings: z.array(z.string().min(1).max(500)).max(100).optional().default([]),
  outputPath: z.string().min(1).max(240).optional().default("workflow-automation/workflow-report.md")
});

function validateSpec(spec: z.infer<typeof workflowSpecSchema>) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = new Set<string>();
  for (const step of spec.steps) {
    if (ids.has(step.id)) errors.push(`Duplicate step id: ${step.id}.`);
    ids.add(step.id);
  }
  for (const step of spec.steps) {
    for (const dep of step.dependsOn) if (!ids.has(dep)) errors.push(`Step ${step.id} depends on unknown step ${dep}.`);
    if (step.approval.required && step.approval.approvers.length === 0) warnings.push(`Step ${step.id} requires approval but has no approvers.`);
    if (step.retry.maxAttempts > 1 && step.retry.backoff === "none") warnings.push(`Step ${step.id} retries without backoff.`);
    if (spec.failurePolicy === "compensate" && !step.recovery) warnings.push(`Step ${step.id} has no recovery action for compensate policy.`);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(spec.steps.map((step) => [step.id, step]));
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      errors.push(`Dependency cycle includes ${id}.`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) if (byId.has(dep)) visit(dep);
    visiting.delete(id);
    visited.add(id);
  };
  for (const step of spec.steps) visit(step.id);
  if (!spec.notifications.some((notification) => notification.on.includes("failure"))) warnings.push("No failure notification configured.");
  return { ok: errors.length === 0, errors: [...new Set(errors)], warnings: [...new Set(warnings)], stepCount: spec.steps.length, triggerCount: spec.triggers.length };
}

function readySteps(spec: z.infer<typeof workflowSpecSchema>, done: Set<string>, blocked: Set<string>) {
  return spec.steps.filter((step) => !done.has(step.id) && !blocked.has(step.id) && step.dependsOn.every((dep) => done.has(dep)));
}

function simulate(spec: z.infer<typeof workflowSpecSchema>, failStepIds: string[], approvedStepIds: string[]) {
  const validation = validateSpec(spec);
  if (!validation.ok) return { ok: false, validation, events: [], finalStatus: "invalid" };
  const fail = new Set(failStepIds);
  const approved = new Set(approvedStepIds);
  const done = new Set<string>();
  const blocked = new Set<string>();
  const events: Array<Record<string, unknown>> = [];
  let guard = 0;
  while (done.size + blocked.size < spec.steps.length && guard++ < spec.steps.length * 4) {
    const ready = readySteps(spec, done, blocked);
    if (ready.length === 0) break;
    for (const step of ready) {
      events.push({ stepId: step.id, event: "start" });
      if (step.approval.required && !approved.has(step.id)) {
        blocked.add(step.id);
        events.push({ stepId: step.id, event: "approval_required", approvers: step.approval.approvers });
        continue;
      }
      if (fail.has(step.id)) {
        events.push({ stepId: step.id, event: "failure", attempts: step.retry.maxAttempts });
        if (spec.failurePolicy === "continue") {
          done.add(step.id);
          events.push({ stepId: step.id, event: "continued_after_failure" });
        } else if (spec.failurePolicy === "compensate" && step.recovery) {
          blocked.add(step.id);
          events.push({ stepId: step.id, event: "recovery_required", recovery: step.recovery });
        } else {
          blocked.add(step.id);
        }
        continue;
      }
      done.add(step.id);
      events.push({ stepId: step.id, event: "success" });
    }
  }
  const finalStatus = blocked.size > 0 ? "blocked" : done.size === spec.steps.length ? "success" : "incomplete";
  return { ok: finalStatus === "success", validation, events, finalStatus, completed: [...done], blocked: [...blocked] };
}

export const workflowAutomationTools: ToolModule[] = [
  {
    definition: {
      name: "create_workflow_automation_spec",
      description: "Create a project-local workflow automation spec with triggers, steps, retries, approvals, notifications, logs, and failure policy.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, name: { type: "string" }, description: { type: "string" }, triggers: { type: "array" }, steps: { type: "array" }, notifications: { type: "array" }, logs: { type: "object" }, failurePolicy: { type: "string", enum: ["stop", "continue", "compensate"] }, outputPath: { type: "string" } }, required: ["projectId", "name", "triggers", "steps"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: createWorkflowAutomationSpecInputSchema,
    handler: async (input, ctx) => {
      const parsed = createWorkflowAutomationSpecInputSchema.parse(input);
      const spec = workflowSpecSchema.parse(parsed);
      const validation = validateSpec(spec);
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify({ ...spec, validation, createdAt: new Date().toISOString() }, null, 2)}\n`);
      return { ok: validation.ok, summary: `Created workflow spec with ${spec.steps.length} step(s), ${validation.errors.length} error(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { spec, validation }, logs: [JSON.stringify(validation, null, 2)], errors: validation.errors };
    }
  },
  {
    definition: {
      name: "validate_workflow_automation_spec",
      description: "Validate workflow dependencies, approval coverage, retry backoff, failure notifications, and recovery coverage.",
      inputSchema: { type: "object", properties: { spec: { type: "object" } }, required: ["spec"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: validateWorkflowAutomationSpecInputSchema,
    handler: (input) => {
      const parsed = validateWorkflowAutomationSpecInputSchema.parse(input);
      const validation = validateSpec(parsed.spec);
      return { ok: validation.ok, summary: validation.ok ? `Workflow spec valid with ${validation.warnings.length} warning(s).` : `Workflow spec invalid with ${validation.errors.length} error(s).`, artifacts: [], structuredContent: validation, logs: [JSON.stringify(validation, null, 2)], errors: validation.errors };
    }
  },
  {
    definition: {
      name: "simulate_workflow_execution",
      description: "Simulate workflow execution with optional failed and approved steps to test approvals, retries, and recovery paths.",
      inputSchema: { type: "object", properties: { spec: { type: "object" }, failStepIds: { type: "array", items: { type: "string" } }, approvedStepIds: { type: "array", items: { type: "string" } } }, required: ["spec"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: simulateWorkflowExecutionInputSchema,
    handler: (input) => {
      const parsed = simulateWorkflowExecutionInputSchema.parse(input);
      const result = simulate(parsed.spec, parsed.failStepIds, parsed.approvedStepIds);
      return { ok: result.ok, summary: `Workflow simulation ended ${result.finalStatus}.`, artifacts: [], structuredContent: result, logs: [JSON.stringify(result, null, 2)], errors: result.ok ? [] : [`Workflow simulation ended ${result.finalStatus}.`] };
    }
  },
  {
    definition: {
      name: "create_workflow_schedule_plan",
      description: "Create a schedule plan for workflow triggers with cron, timezone, and enabled state.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, workflowName: { type: "string" }, schedules: { type: "array" }, outputPath: { type: "string" } }, required: ["projectId", "workflowName", "schedules"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: createWorkflowSchedulePlanInputSchema,
    handler: async (input, ctx) => {
      const parsed = createWorkflowSchedulePlanInputSchema.parse(input);
      const invalid = parsed.schedules.filter((schedule) => schedule.cron.trim().split(/\s+/).length < 5);
      const plan = { workflowName: parsed.workflowName, schedules: parsed.schedules, warnings: invalid.map((schedule) => `${schedule.name} cron expression has fewer than 5 fields.`), createdAt: new Date().toISOString() };
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(plan, null, 2)}\n`);
      return { ok: invalid.length === 0, summary: `Created workflow schedule plan with ${parsed.schedules.length} schedule(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: plan, logs: [JSON.stringify(plan, null, 2)], errors: invalid.length ? ["Invalid cron-like schedule detected."] : [] };
    }
  },
  {
    definition: {
      name: "create_workflow_recovery_plan",
      description: "Create a failure recovery plan mapping failed steps to detection, recovery actions, and notifications.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, workflowName: { type: "string" }, failureModes: { type: "array" }, outputPath: { type: "string" } }, required: ["projectId", "workflowName", "failureModes"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: createWorkflowRecoveryPlanInputSchema,
    handler: async (input, ctx) => {
      const parsed = createWorkflowRecoveryPlanInputSchema.parse(input);
      const plan = { workflowName: parsed.workflowName, failureModes: parsed.failureModes, checklist: ["Detect failure", "Stop or isolate affected step", "Run recovery action", "Notify owners", "Record incident log", "Resume or close workflow"], createdAt: new Date().toISOString() };
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(plan, null, 2)}\n`);
      return { ok: true, summary: `Created workflow recovery plan for ${parsed.failureModes.length} failure mode(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: plan, logs: [JSON.stringify(plan, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "export_workflow_automation_report",
      description: "Export a Markdown workflow automation report with spec, validation, simulation, findings, and recovery notes.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, title: { type: "string" }, spec: { type: "object" }, validation: { type: "object" }, simulation: { type: "object" }, findings: { type: "array", items: { type: "string" } }, outputPath: { type: "string" } }, required: ["projectId", "title"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: exportWorkflowAutomationReportInputSchema,
    handler: async (input, ctx) => {
      const parsed = exportWorkflowAutomationReportInputSchema.parse(input);
      const markdown = [`# ${parsed.title}`, "", "## Findings", ...(parsed.findings.length ? parsed.findings.map((item) => `- ${item}`) : ["- No findings recorded."]), "", "## Validation", "```json", JSON.stringify(parsed.validation, null, 2), "```", "", "## Simulation", "```json", JSON.stringify(parsed.simulation, null, 2), "```", "", "## Spec", "```json", JSON.stringify(parsed.spec ?? {}, null, 2), "```", ""].join("\n");
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, markdown);
      return { ok: true, summary: `Exported workflow automation report to ${file.path}.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { report: markdown }, logs: [markdown], errors: [] };
    }
  }
];
