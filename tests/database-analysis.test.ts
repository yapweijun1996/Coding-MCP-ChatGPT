import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getToolModule } from "../src/mcp/registry.js";
import { createProject, readProjectFile } from "../src/projects/store.js";
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
    clientId: "database-analysis-test"
  };
}

const tables = [
  {
    name: "users",
    schema: "public",
    estimatedRows: 1000,
    columns: [
      { name: "id", type: "uuid", nullable: false, primaryKey: true, indexed: true },
      { name: "created_at", type: "timestamp", nullable: false, indexed: true },
      { name: "plan", type: "text", nullable: true }
    ]
  },
  {
    name: "orders",
    schema: "public",
    estimatedRows: 2000000,
    columns: [
      { name: "id", type: "uuid", nullable: false, primaryKey: true, indexed: true },
      { name: "user_id", type: "uuid", nullable: false, indexed: true, foreignKey: { table: "users", column: "id" } },
      { name: "total", type: "numeric", nullable: false },
      { name: "created_at", type: "timestamp", nullable: false, indexed: true }
    ]
  }
];

test("database analysis tools create schema inventories, safe SQL, sample queries, hints, and reports", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "database-analysis-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Database project", createdByClientId: "analyst" });
    const inventory = getToolModule("create_database_schema_inventory");
    const generate = getToolModule("generate_readonly_sql");
    const validate = getToolModule("validate_readonly_sql");
    const sample = getToolModule("create_database_sample_preview_query");
    const hints = getToolModule("suggest_database_performance_hints");
    const report = getToolModule("export_database_analysis_report");
    for (const [name, tool] of Object.entries({ inventory, generate, validate, sample, hints, report })) assert.ok(tool, `${name} registered`);

    const inventoryResult = await inventory!.handler({
      projectId: project.id,
      databaseName: "app",
      dialect: "postgres",
      tables
    }, ctx);
    assert.equal(inventoryResult.ok, true);
    assert.ok(inventoryResult.artifacts.includes("database-analysis/schema-inventory.json"));
    const inventoryPayload = inventoryResult.structuredContent as { relationships: unknown[]; largeTables: string[] };
    assert.equal(inventoryPayload.relationships.length, 1);
    assert.deepEqual(inventoryPayload.largeTables, ["orders"]);

    const generatedResult = await generate!.handler({
      projectId: project.id,
      dialect: "postgres",
      question: "Revenue by plan",
      tables,
      metrics: ["plan", "SUM(total) AS revenue"],
      filters: ["created_at >= :start_ts", "created_at < :end_ts"],
      groupBy: ["plan"],
      writeToProject: true
    }, ctx);
    assert.equal(generatedResult.ok, true);
    const generatedPayload = generatedResult.structuredContent as { sql: string; validation: { ok: boolean } };
    assert.equal(generatedPayload.validation.ok, true);
    assert.match(generatedPayload.sql, /LIMIT 100/);
    assert.ok(generatedResult.artifacts.includes("database-analysis/readonly-query-pack.txt"));

    const rejected = await validate!.handler({ sql: "UPDATE users SET plan = 'pro';", dialect: "postgres" }, ctx);
    assert.equal(rejected.ok, false);
    assert.match(rejected.errors.join("\n"), /Forbidden SQL keyword: UPDATE/);

    const warning = await validate!.handler({ sql: "SELECT * FROM users;", dialect: "postgres" }, ctx);
    const warningPayload = warning.structuredContent as { warnings: string[] };
    assert.equal(warning.ok, true);
    assert.equal(warningPayload.warnings.some((item) => item.includes("LIMIT")), true);
    assert.equal(warningPayload.warnings.some((item) => item.includes("SELECT *")), true);

    const sampleResult = await sample!.handler({
      projectId: project.id,
      dialect: "postgres",
      table: tables[0],
      orderBy: "created_at",
      writeToProject: true
    }, ctx);
    const samplePayload = sampleResult.structuredContent as { sql: string };
    assert.match(samplePayload.sql, /Null profile/);
    assert.match(samplePayload.sql, /ORDER BY "created_at"/);

    const hintsResult = await hints!.handler({
      dialect: "mysql",
      sql: "SELECT * FROM orders ORDER BY created_at",
      tables,
      explainText: "type: ALL; Extra: Using filesort"
    }, ctx);
    const hintsPayload = hintsResult.structuredContent as { hints: string[] };
    assert.equal(hintsPayload.hints.some((item) => item.includes("SELECT *")), true);
    assert.equal(hintsPayload.hints.some((item) => item.includes("ORDER BY without LIMIT")), true);
    assert.equal(hintsPayload.hints.some((item) => item.includes("scan/sort risk")), true);

    const reportResult = await report!.handler({
      projectId: project.id,
      title: "Database Analysis",
      question: "Revenue by plan",
      schemaSummary: inventoryPayload,
      queries: [generatedPayload.sql],
      findings: ["orders is the largest table."],
      performanceHints: hintsPayload.hints
    }, ctx);
    assert.equal(reportResult.ok, true);
    const markdown = await readProjectFile(ctx.projectRoot, project.id, "database-analysis/database-analysis-report.md");
    assert.match(markdown, /# Database Analysis/);
    assert.match(markdown, /orders is the largest table/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("database-analysis skill exposes database tools through dedicated, coding, and debug skills", () => {
  const toolNames = [
    "create_database_schema_inventory",
    "generate_readonly_sql",
    "validate_readonly_sql",
    "create_database_sample_preview_query",
    "suggest_database_performance_hints",
    "export_database_analysis_report"
  ];
  const database = skillRegistry.find((entry) => entry.id === "database-analysis");
  const coding = skillRegistry.find((entry) => entry.id === "coding");
  const debug = skillRegistry.find((entry) => entry.id === "debug");
  assert.ok(database);
  for (const toolName of toolNames) {
    assert.ok(database!.toolNames.includes(toolName), `${toolName} exposed in database-analysis`);
    assert.ok(coding?.toolNames.includes(toolName), `${toolName} exposed in coding`);
    assert.ok(debug?.toolNames.includes(toolName), `${toolName} exposed in debug`);
  }
});
