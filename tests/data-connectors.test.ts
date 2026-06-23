import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getToolModule } from "../src/mcp/registry.js";
import { skillRegistry } from "../src/skills/registry.js";
import type { ToolContext } from "../src/mcp/types.js";

function toolContext(root: string): ToolContext {
  return {
    publicBaseUrl: "https://example.test",
    workspaceRoot: root,
    commandTimeoutMs: 1000,
    shareRoot: path.join(root, "shares"),
    artifactRoot: path.join(root, "artifacts"),
    feedbackRoot: path.join(root, "feedback"),
    projectRoot: path.join(root, "projects"),
    clientId: "data-connectors-test"
  };
}

test("data connector tools manage inventory, auth scope, health plans, and reports", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "data-connectors-"));
  try {
    const ctx = toolContext(root);
    const register = getToolModule("register_data_connector");
    const list = getToolModule("list_data_connectors");
    const check = getToolModule("check_connector_auth_scope");
    const update = getToolModule("update_connector_status");
    const health = getToolModule("create_connector_healthcheck_plan");
    const report = getToolModule("export_connector_inventory_report");
    for (const [name, tool] of Object.entries({ register, list, check, update, health, report })) assert.ok(tool, `${name} registered`);

    const dbResult = await register!.handler({
      id: "warehouse",
      name: "Analytics Warehouse",
      type: "database",
      status: "available",
      authStatus: "configured",
      scopeLevel: "readonly",
      allowedOperations: ["read"],
      dataClasses: ["analytics", "pii"],
      requiredScopes: ["warehouse.read"],
      owner: "Data",
      endpointLabel: "postgres://warehouse.example/analytics"
    }, ctx);
    assert.equal(dbResult.ok, true);
    const dbPayload = dbResult.structuredContent as { connector: { id: string }; risk: { risk: string; warnings: string[] } };
    assert.equal(dbPayload.connector.id, "warehouse");
    assert.equal(dbPayload.risk.risk, "high");
    assert.equal(dbPayload.risk.warnings.some((warning) => warning.includes("sensitive")), true);

    await register!.handler({
      id: "gmail",
      name: "Support Mailbox",
      type: "email",
      status: "blocked",
      authStatus: "missing",
      scopeLevel: "denied",
      allowedOperations: ["read"],
      dataClasses: ["personal"],
      requiredScopes: ["gmail.readonly"]
    }, ctx);

    const listed = await list!.handler({ type: "database" }, ctx);
    assert.equal(listed.ok, true);
    const listPayload = listed.structuredContent as { connectors: Array<{ id: string }> };
    assert.deepEqual(listPayload.connectors.map((connector) => connector.id), ["warehouse"]);

    const readCheck = await check!.handler({ connectorId: "warehouse", intendedOperation: "read", requiredScopes: ["warehouse.read"] }, ctx);
    assert.equal(readCheck.ok, true);
    const readPayload = readCheck.structuredContent as { decision: { decision: string; errors: string[] } };
    assert.equal(readPayload.decision.decision, "approval_or_review_required");
    assert.deepEqual(readPayload.decision.errors, []);

    const writeCheck = await check!.handler({ connectorId: "warehouse", intendedOperation: "write" }, ctx);
    assert.equal(writeCheck.ok, false);
    const writePayload = writeCheck.structuredContent as { decision: { errors: string[] } };
    assert.equal(writePayload.decision.errors.some((error) => error.includes("allowedOperations")), true);

    const blockedCheck = await check!.handler({ connectorId: "gmail", intendedOperation: "read" }, ctx);
    assert.equal(blockedCheck.ok, false);
    assert.match(blockedCheck.errors.join("\n"), /blocked|missing/i);

    const updateResult = await update!.handler({
      connectorId: "gmail",
      status: "available",
      authStatus: "configured",
      scopeLevel: "readonly",
      lastHealth: { ok: true, status: "mailbox_search_ready", detail: "Readonly search scope confirmed." }
    }, ctx);
    assert.equal(updateResult.ok, true);
    const updatePayload = updateResult.structuredContent as { connector: { status: string; authStatus: string; lastHealth: { ok: boolean } } };
    assert.equal(updatePayload.connector.status, "available");
    assert.equal(updatePayload.connector.authStatus, "configured");
    assert.equal(updatePayload.connector.lastHealth.ok, true);

    const healthResult = await health!.handler({ connectorId: "warehouse", outputPath: "connector-health/warehouse.json" }, ctx);
    assert.equal(healthResult.ok, true);
    const healthPayload = healthResult.structuredContent as { steps: string[]; connectorType: string };
    assert.equal(healthPayload.connectorType, "database");
    assert.equal(healthPayload.steps.some((step) => step.includes("SELECT 1")), true);
    assert.match(await readFile(path.join(ctx.feedbackRoot, "connector-health/warehouse.json"), "utf8"), /warehouse/);

    const reportResult = await report!.handler({ title: "Connector Inventory" }, ctx);
    assert.equal(reportResult.ok, true);
    const markdown = await readFile(path.join(ctx.feedbackRoot, "data-connectors-report.md"), "utf8");
    assert.match(markdown, /Connector Inventory/);
    assert.match(markdown, /Analytics Warehouse/);
    assert.match(markdown, /Support Mailbox/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("data-connectors skill exposes tools through core, coding, debug, and integration skills", () => {
  const toolNames = [
    "register_data_connector",
    "list_data_connectors",
    "check_connector_auth_scope",
    "update_connector_status",
    "create_connector_healthcheck_plan",
    "export_connector_inventory_report"
  ];
  const dataConnectors = skillRegistry.find((entry) => entry.id === "data-connectors");
  const core = skillRegistry.find((entry) => entry.id === "core");
  const coding = skillRegistry.find((entry) => entry.id === "coding");
  const debug = skillRegistry.find((entry) => entry.id === "debug");
  const integration = skillRegistry.find((entry) => entry.id === "agent-integration-readonly");
  assert.ok(dataConnectors);
  for (const toolName of toolNames) {
    assert.ok(dataConnectors!.toolNames.includes(toolName), `${toolName} exposed in data-connectors`);
    assert.ok(core?.toolNames.includes(toolName), `${toolName} exposed in core`);
    assert.ok(coding?.toolNames.includes(toolName), `${toolName} exposed in coding`);
    assert.ok(debug?.toolNames.includes(toolName), `${toolName} exposed in debug`);
    assert.ok(integration?.toolNames.includes(toolName), `${toolName} exposed in integration`);
  }
});
