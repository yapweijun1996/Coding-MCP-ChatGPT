import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomicWrite } from "../../shared/atomic-write.js";
import { withKeyedLock } from "../../shared/keyed-lock.js";
import type { ToolModule } from "../types.js";

const connectorTypeSchema = z.enum(["database", "api", "file", "calendar", "email", "storage", "internal_app"]);
const connectorStatusSchema = z.enum(["planned", "available", "degraded", "blocked", "retired"]);
const authStatusSchema = z.enum(["not_required", "configured", "missing", "expired", "unknown"]);
const scopeLevelSchema = z.enum(["readonly", "read_write", "admin", "unknown", "denied"]);

const connectorSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/),
  name: z.string().min(1).max(200),
  type: connectorTypeSchema,
  status: connectorStatusSchema,
  authStatus: authStatusSchema,
  scopeLevel: scopeLevelSchema,
  projectId: z.string().min(1).max(120).optional(),
  owner: z.string().max(160).optional(),
  system: z.string().max(200).optional(),
  endpointLabel: z.string().max(300).optional(),
  allowedOperations: z.array(z.enum(["read", "write", "delete", "publish", "execute", "admin"])).max(20).optional().default(["read"]),
  dataClasses: z.array(z.string().min(1).max(120)).max(50).optional().default([]),
  requiredScopes: z.array(z.string().min(1).max(200)).max(100).optional().default([]),
  notes: z.string().max(2000).optional().default(""),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastCheckedAt: z.string().datetime().optional(),
  lastHealth: z.object({
    ok: z.boolean(),
    status: z.string().max(120),
    detail: z.string().max(1000).optional()
  }).optional()
});

const registerDataConnectorInputSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/),
  name: z.string().min(1).max(200),
  type: connectorTypeSchema,
  status: connectorStatusSchema.optional().default("planned"),
  authStatus: authStatusSchema.optional().default("unknown"),
  scopeLevel: scopeLevelSchema.optional().default("unknown"),
  projectId: z.string().min(1).max(120).optional(),
  owner: z.string().max(160).optional(),
  system: z.string().max(200).optional(),
  endpointLabel: z.string().max(300).optional(),
  allowedOperations: z.array(z.enum(["read", "write", "delete", "publish", "execute", "admin"])).max(20).optional().default(["read"]),
  dataClasses: z.array(z.string().min(1).max(120)).max(50).optional().default([]),
  requiredScopes: z.array(z.string().min(1).max(200)).max(100).optional().default([]),
  notes: z.string().max(2000).optional().default("")
});

const listDataConnectorsInputSchema = z.object({
  type: connectorTypeSchema.optional(),
  status: connectorStatusSchema.optional(),
  authStatus: authStatusSchema.optional(),
  scopeLevel: scopeLevelSchema.optional(),
  projectId: z.string().min(1).max(120).optional(),
  limit: z.number().int().min(1).max(500).optional().default(100)
});

const checkConnectorAuthScopeInputSchema = z.object({
  connectorId: z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/),
  intendedOperation: z.enum(["read", "write", "delete", "publish", "execute", "admin"]).optional().default("read"),
  requiredScopes: z.array(z.string().min(1).max(200)).max(100).optional().default([])
});

const updateConnectorStatusInputSchema = z.object({
  connectorId: z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/),
  status: connectorStatusSchema.optional(),
  authStatus: authStatusSchema.optional(),
  scopeLevel: scopeLevelSchema.optional(),
  lastHealth: z.object({
    ok: z.boolean(),
    status: z.string().min(1).max(120),
    detail: z.string().max(1000).optional()
  }).optional(),
  notes: z.string().max(2000).optional()
});

const createConnectorHealthcheckPlanInputSchema = z.object({
  connectorId: z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/),
  includeWriteCheck: z.boolean().optional().default(false),
  outputPath: z.string().min(1).max(240).optional()
});

const exportConnectorInventoryReportInputSchema = z.object({
  title: z.string().min(1).max(200).optional().default("Data Connector Inventory Report"),
  outputPath: z.string().min(1).max(240).optional().default("data-connectors-report.md")
});

type DataConnector = z.infer<typeof connectorSchema>;

interface ConnectorStore {
  version: 1;
  updatedAt: string;
  connectors: DataConnector[];
}

function storePath(feedbackRoot: string): string {
  return path.join(feedbackRoot, "data-connectors.json");
}

function outputPath(feedbackRoot: string, relativePath: string): string {
  return path.join(feedbackRoot, relativePath);
}

async function readStore(feedbackRoot: string): Promise<ConnectorStore> {
  try {
    const raw = await readFile(storePath(feedbackRoot), "utf8");
    const parsed = JSON.parse(raw) as Partial<ConnectorStore>;
    if (parsed.version === 1 && Array.isArray(parsed.connectors)) {
      return {
        version: 1,
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
        connectors: parsed.connectors.map((connector) => connectorSchema.parse(connector))
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { version: 1, updatedAt: new Date().toISOString(), connectors: [] };
}

async function writeStore(feedbackRoot: string, connectors: DataConnector[]): Promise<ConnectorStore> {
  await mkdir(feedbackRoot, { recursive: true });
  const payload: ConnectorStore = {
    version: 1,
    updatedAt: new Date().toISOString(),
    connectors: connectors.sort((left, right) => left.id.localeCompare(right.id))
  };
  await atomicWrite(storePath(feedbackRoot), `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

async function mutateStore(feedbackRoot: string, updater: (store: ConnectorStore) => ConnectorStore | Promise<ConnectorStore>) {
  return withKeyedLock(`data-connectors:${storePath(feedbackRoot)}`, async () => {
    const store = await readStore(feedbackRoot);
    return updater(store);
  });
}

function riskFor(connector: DataConnector) {
  const warnings: string[] = [];
  if (connector.authStatus === "missing" || connector.authStatus === "expired" || connector.authStatus === "unknown") warnings.push(`Auth status is ${connector.authStatus}.`);
  if (connector.scopeLevel === "admin") warnings.push("Admin scope requires explicit approval before use.");
  if (connector.allowedOperations.some((operation) => operation !== "read")) warnings.push("Connector allows non-read operations.");
  if (connector.dataClasses.some((item) => /pii|personal|payment|health|secret/i.test(item))) warnings.push("Connector handles sensitive data classes.");
  const risk = warnings.some((warning) => /Admin|sensitive|non-read/i.test(warning))
    ? "high"
    : warnings.length ? "medium" : "low";
  return { risk, warnings };
}

function decisionFor(connector: DataConnector, operation: string, requiredScopes: string[]) {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (connector.status !== "available") errors.push(`Connector status is ${connector.status}.`);
  if (connector.authStatus !== "configured" && connector.authStatus !== "not_required") errors.push(`Connector auth is ${connector.authStatus}.`);
  if (!connector.allowedOperations.includes(operation as never)) errors.push(`Operation ${operation} is not listed in allowedOperations.`);
  if (operation !== "read" && connector.scopeLevel === "readonly") errors.push("Readonly scope cannot perform non-read operation.");
  if (operation === "admin" && connector.scopeLevel !== "admin") errors.push("Admin operation requires admin scope.");
  const missingScopes = requiredScopes.filter((scope) => !connector.requiredScopes.includes(scope));
  if (missingScopes.length) warnings.push(`Required scopes not documented on connector: ${missingScopes.join(", ")}.`);
  const risk = riskFor(connector);
  return {
    allowed: errors.length === 0,
    decision: errors.length ? "blocked" : risk.risk === "high" || warnings.length ? "approval_or_review_required" : "allowed",
    errors,
    warnings: [...warnings, ...risk.warnings],
    riskLevel: risk.risk
  };
}

function healthcheckSteps(connector: DataConnector, includeWriteCheck: boolean) {
  const common = [
    "Confirm auth status and documented scopes before use.",
    "Run the safest read-only metadata or health endpoint check.",
    "Record latency, status, error text, and checkedAt timestamp.",
    "Do not log secrets, tokens, cookies, or raw sensitive records."
  ];
  const typeSpecific: Record<string, string[]> = {
    database: ["Run a bounded SELECT 1 or schema metadata query through approved read-only workflow.", "Verify tenant/date filters before previewing rows."],
    api: ["Run api_healthcheck against an allowlisted host.", "Run api_contract_test for key readonly endpoints when an OpenAPI/contract exists."],
    file: ["Check path scope and file readability.", "Inspect file size, format, and freshness before parsing."],
    calendar: ["Confirm calendar readonly scope and list a bounded event window.", "Avoid exporting attendee details unless explicitly needed."],
    email: ["Confirm mailbox readonly scope and search a bounded query.", "Avoid message body export unless explicitly approved."],
    storage: ["List a bounded prefix or object metadata only.", "Avoid broad recursive reads without scope approval."],
    internal_app: ["Check app health/status endpoint or documented ping route.", "Verify role/scope before state-changing actions."]
  };
  const write = includeWriteCheck ? ["If write access is required, use a dry-run or sandbox object first.", "Record explicit approval and rollback path before any mutation."] : [];
  return [...common, ...(typeSpecific[connector.type] ?? []), ...write];
}

function summarize(connectors: DataConnector[]) {
  const byType: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const byAuth: Record<string, number> = {};
  const risk: Record<string, number> = {};
  for (const connector of connectors) {
    byType[connector.type] = (byType[connector.type] ?? 0) + 1;
    byStatus[connector.status] = (byStatus[connector.status] ?? 0) + 1;
    byAuth[connector.authStatus] = (byAuth[connector.authStatus] ?? 0) + 1;
    const level = riskFor(connector).risk;
    risk[level] = (risk[level] ?? 0) + 1;
  }
  return { totalConnectors: connectors.length, byType, byStatus, byAuth, risk };
}

function renderReport(title: string, connectors: DataConnector[]) {
  return [
    `# ${title}`,
    "",
    "## Summary",
    "```json",
    JSON.stringify(summarize(connectors), null, 2),
    "```",
    "",
    "## Connectors",
    ...(connectors.length ? connectors.map((connector) => {
      const risk = riskFor(connector);
      return `- ${connector.id} (${connector.type}/${connector.status}) auth=${connector.authStatus} scope=${connector.scopeLevel} risk=${risk.risk}: ${connector.name}`;
    }) : ["- No connectors registered."]),
    ""
  ].join("\n");
}

export const dataConnectorTools: ToolModule[] = [
  {
    definition: {
      name: "register_data_connector",
      description: "Register or update a data connector inventory record without storing secrets, covering type, auth status, scope level, allowed operations, data classes, and owner.",
      inputSchema: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, type: { type: "string" }, status: { type: "string" }, authStatus: { type: "string" }, scopeLevel: { type: "string" }, projectId: { type: "string" }, owner: { type: "string" }, system: { type: "string" }, endpointLabel: { type: "string" }, allowedOperations: { type: "array", items: { type: "string" } }, dataClasses: { type: "array", items: { type: "string" } }, requiredScopes: { type: "array", items: { type: "string" } }, notes: { type: "string" } }, required: ["id", "name", "type"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: registerDataConnectorInputSchema,
    handler: async (input, ctx) => {
      const parsed = registerDataConnectorInputSchema.parse(input);
      const now = new Date().toISOString();
      const store = await mutateStore(ctx.feedbackRoot, async (current) => {
        const existing = current.connectors.find((connector) => connector.id === parsed.id);
        const connector: DataConnector = {
          id: parsed.id,
          name: parsed.name,
          type: parsed.type,
          status: parsed.status,
          authStatus: parsed.authStatus,
          scopeLevel: parsed.scopeLevel,
          projectId: parsed.projectId,
          owner: parsed.owner,
          system: parsed.system,
          endpointLabel: parsed.endpointLabel,
          allowedOperations: parsed.allowedOperations,
          dataClasses: parsed.dataClasses,
          requiredScopes: parsed.requiredScopes,
          notes: parsed.notes,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          lastCheckedAt: existing?.lastCheckedAt,
          lastHealth: existing?.lastHealth
        };
        return writeStore(ctx.feedbackRoot, [connector, ...current.connectors.filter((item) => item.id !== parsed.id)]);
      });
      const connector = store.connectors.find((item) => item.id === parsed.id)!;
      return { ok: true, summary: `Registered data connector ${connector.id}.`, artifacts: [storePath(ctx.feedbackRoot)], structuredContent: { connector, risk: riskFor(connector), summary: summarize(store.connectors) }, logs: [JSON.stringify(connector, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "list_data_connectors",
      description: "List registered data connectors with optional filters by type, status, auth status, scope level, and project id.",
      inputSchema: { type: "object", properties: { type: { type: "string" }, status: { type: "string" }, authStatus: { type: "string" }, scopeLevel: { type: "string" }, projectId: { type: "string" }, limit: { type: "number" } }, additionalProperties: false }
    },
    enabledByDefault: true,
    schema: listDataConnectorsInputSchema,
    handler: async (input, ctx) => {
      const parsed = listDataConnectorsInputSchema.parse(input);
      const store = await readStore(ctx.feedbackRoot);
      const connectors = store.connectors
        .filter((connector) => !parsed.type || connector.type === parsed.type)
        .filter((connector) => !parsed.status || connector.status === parsed.status)
        .filter((connector) => !parsed.authStatus || connector.authStatus === parsed.authStatus)
        .filter((connector) => !parsed.scopeLevel || connector.scopeLevel === parsed.scopeLevel)
        .filter((connector) => !parsed.projectId || connector.projectId === parsed.projectId)
        .slice(0, parsed.limit);
      return { ok: true, summary: `Found ${connectors.length} data connector(s).`, artifacts: [], structuredContent: { connectors, summary: summarize(store.connectors) }, logs: connectors.map((connector) => `${connector.id} ${connector.type}/${connector.status} auth=${connector.authStatus} scope=${connector.scopeLevel}`), errors: [] };
    }
  },
  {
    definition: {
      name: "check_connector_auth_scope",
      description: "Check whether a connector has usable auth and documented scope for an intended operation.",
      inputSchema: { type: "object", properties: { connectorId: { type: "string" }, intendedOperation: { type: "string" }, requiredScopes: { type: "array", items: { type: "string" } } }, required: ["connectorId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: checkConnectorAuthScopeInputSchema,
    handler: async (input, ctx) => {
      const parsed = checkConnectorAuthScopeInputSchema.parse(input);
      const store = await readStore(ctx.feedbackRoot);
      const connector = store.connectors.find((item) => item.id === parsed.connectorId);
      if (!connector) return { ok: false, summary: `Connector ${parsed.connectorId} was not found.`, artifacts: [], logs: [], errors: [`Connector ${parsed.connectorId} is not registered.`] };
      const decision = decisionFor(connector, parsed.intendedOperation, parsed.requiredScopes);
      return { ok: decision.allowed, summary: `Connector ${connector.id} decision: ${decision.decision}.`, artifacts: [], structuredContent: { connector, decision }, logs: [JSON.stringify(decision, null, 2)], errors: decision.errors };
    }
  },
  {
    definition: {
      name: "update_connector_status",
      description: "Update connector availability, auth status, scope level, health status, and notes after a check or incident.",
      inputSchema: { type: "object", properties: { connectorId: { type: "string" }, status: { type: "string" }, authStatus: { type: "string" }, scopeLevel: { type: "string" }, lastHealth: { type: "object" }, notes: { type: "string" } }, required: ["connectorId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: updateConnectorStatusInputSchema,
    handler: async (input, ctx) => {
      const parsed = updateConnectorStatusInputSchema.parse(input);
      const now = new Date().toISOString();
      let updated: DataConnector | undefined;
      const store = await mutateStore(ctx.feedbackRoot, async (current) => {
        const connectors = current.connectors.map((connector) => {
          if (connector.id !== parsed.connectorId) return connector;
          updated = {
            ...connector,
            status: parsed.status ?? connector.status,
            authStatus: parsed.authStatus ?? connector.authStatus,
            scopeLevel: parsed.scopeLevel ?? connector.scopeLevel,
            notes: parsed.notes ?? connector.notes,
            lastHealth: parsed.lastHealth ?? connector.lastHealth,
            lastCheckedAt: parsed.lastHealth ? now : connector.lastCheckedAt,
            updatedAt: now
          };
          return updated;
        });
        if (!updated) throw new Error(`Connector ${parsed.connectorId} is not registered.`);
        return writeStore(ctx.feedbackRoot, connectors);
      });
      return { ok: true, summary: `Updated connector ${parsed.connectorId}.`, artifacts: [storePath(ctx.feedbackRoot)], structuredContent: { connector: updated, summary: summarize(store.connectors) }, logs: [JSON.stringify(updated, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "create_connector_healthcheck_plan",
      description: "Create a safe healthcheck plan for a registered connector with type-specific readonly checks and optional write-check precautions.",
      inputSchema: { type: "object", properties: { connectorId: { type: "string" }, includeWriteCheck: { type: "boolean" }, outputPath: { type: "string" } }, required: ["connectorId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: createConnectorHealthcheckPlanInputSchema,
    handler: async (input, ctx) => {
      const parsed = createConnectorHealthcheckPlanInputSchema.parse(input);
      const store = await readStore(ctx.feedbackRoot);
      const connector = store.connectors.find((item) => item.id === parsed.connectorId);
      if (!connector) return { ok: false, summary: `Connector ${parsed.connectorId} was not found.`, artifacts: [], logs: [], errors: [`Connector ${parsed.connectorId} is not registered.`] };
      const plan = { connectorId: connector.id, connectorType: connector.type, createdAt: new Date().toISOString(), includeWriteCheck: parsed.includeWriteCheck, steps: healthcheckSteps(connector, parsed.includeWriteCheck), risk: riskFor(connector) };
      const artifacts: string[] = [];
      if (parsed.outputPath) {
        const target = outputPath(ctx.feedbackRoot, parsed.outputPath);
        await mkdir(path.dirname(target), { recursive: true });
        await atomicWrite(target, `${JSON.stringify(plan, null, 2)}\n`);
        artifacts.push(target);
      }
      return { ok: true, summary: `Created healthcheck plan for ${connector.id}.`, artifacts, structuredContent: plan, logs: [JSON.stringify(plan, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "export_connector_inventory_report",
      description: "Export a Markdown inventory report of data connectors, auth/scope status, risk signals, owners, and health metadata.",
      inputSchema: { type: "object", properties: { title: { type: "string" }, outputPath: { type: "string" } }, additionalProperties: false }
    },
    enabledByDefault: true,
    schema: exportConnectorInventoryReportInputSchema,
    handler: async (input, ctx) => {
      const parsed = exportConnectorInventoryReportInputSchema.parse(input);
      const store = await readStore(ctx.feedbackRoot);
      const markdown = renderReport(parsed.title, store.connectors);
      const target = outputPath(ctx.feedbackRoot, parsed.outputPath);
      await mkdir(path.dirname(target), { recursive: true });
      await atomicWrite(target, markdown);
      return { ok: true, summary: `Exported connector inventory report with ${store.connectors.length} connector(s).`, artifacts: [target], structuredContent: { path: target, summary: summarize(store.connectors), markdown }, logs: [markdown], errors: [] };
    }
  }
];
