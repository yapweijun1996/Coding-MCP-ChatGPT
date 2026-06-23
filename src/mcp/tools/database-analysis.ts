import { z } from "zod";
import { writeProjectFile } from "../../projects/store.js";
import type { ToolContext, ToolModule } from "../types.js";

const sqlDialectSchema = z.enum(["postgres", "mysql", "sqlite", "generic"]);

const columnSchema = z.object({
  name: z.string().min(1).max(120),
  type: z.string().min(1).max(120),
  nullable: z.boolean().optional().default(true),
  primaryKey: z.boolean().optional().default(false),
  foreignKey: z.object({
    table: z.string().min(1).max(160),
    column: z.string().min(1).max(120)
  }).optional(),
  indexed: z.boolean().optional().default(false),
  description: z.string().min(1).max(300).optional()
});

const tableSchema = z.object({
  name: z.string().min(1).max(160),
  schema: z.string().min(1).max(120).optional(),
  estimatedRows: z.number().int().min(0).optional(),
  columns: z.array(columnSchema).min(1).max(300)
});

const createDatabaseSchemaInventoryInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  databaseName: z.string().min(1).max(160).optional(),
  dialect: sqlDialectSchema.optional().default("generic"),
  tables: z.array(tableSchema).min(1).max(200),
  outputPath: z.string().min(1).max(240).optional().default("database-analysis/schema-inventory.json")
});

const generateReadonlySqlInputSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  dialect: sqlDialectSchema.optional().default("generic"),
  question: z.string().min(1).max(1000),
  tables: z.array(tableSchema).min(1).max(50),
  metrics: z.array(z.string().min(1).max(120)).max(20).optional().default([]),
  filters: z.array(z.string().min(1).max(240)).max(30).optional().default([]),
  groupBy: z.array(z.string().min(1).max(120)).max(20).optional().default([]),
  limit: z.number().int().min(1).max(10000).optional().default(100),
  writeToProject: z.boolean().optional().default(false),
  outputPath: z.string().min(1).max(240).optional().default("database-analysis/readonly-query-pack.txt")
});

const validateReadonlySqlInputSchema = z.object({
  sql: z.string().min(1).max(10000),
  dialect: sqlDialectSchema.optional().default("generic"),
  allowExplain: z.boolean().optional().default(true),
  requireLimit: z.boolean().optional().default(true)
});

const createDatabaseSamplePreviewQueryInputSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  dialect: sqlDialectSchema.optional().default("generic"),
  table: tableSchema,
  orderBy: z.string().min(1).max(120).optional(),
  limit: z.number().int().min(1).max(1000).optional().default(25),
  includeNullProfile: z.boolean().optional().default(true),
  writeToProject: z.boolean().optional().default(false),
  outputPath: z.string().min(1).max(240).optional().default("database-analysis/sample-preview.txt")
});

const suggestDatabasePerformanceHintsInputSchema = z.object({
  dialect: sqlDialectSchema.optional().default("generic"),
  sql: z.string().min(1).max(10000),
  tables: z.array(tableSchema).max(50).optional().default([]),
  explainText: z.string().max(10000).optional().default("")
});

const exportDatabaseAnalysisReportInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  title: z.string().min(1).max(160),
  question: z.string().min(1).max(1000).optional(),
  schemaSummary: z.record(z.string(), z.unknown()).optional().default({}),
  queries: z.array(z.string().min(1).max(5000)).max(30).optional().default([]),
  findings: z.array(z.string().min(1).max(500)).max(100).optional().default([]),
  performanceHints: z.array(z.string().min(1).max(500)).max(100).optional().default([]),
  outputPath: z.string().min(1).max(240).optional().default("database-analysis/database-analysis-report.md")
});

function q(identifier: string, dialect: z.infer<typeof sqlDialectSchema>): string {
  const clean = identifier.replaceAll("\"", "").replaceAll("`", "");
  if (dialect === "mysql") return `\`${clean}\``;
  return `"${clean}"`;
}

function tableRef(table: z.infer<typeof tableSchema>, dialect: z.infer<typeof sqlDialectSchema>): string {
  return table.schema ? `${q(table.schema, dialect)}.${q(table.name, dialect)}` : q(table.name, dialect);
}

function schemaInventory(input: z.infer<typeof createDatabaseSchemaInventoryInputSchema>) {
  const relationships = input.tables.flatMap((table) => table.columns
    .filter((column) => column.foreignKey)
    .map((column) => ({
      from: `${table.schema ? `${table.schema}.` : ""}${table.name}.${column.name}`,
      to: `${column.foreignKey!.table}.${column.foreignKey!.column}`
    })));
  const largeTables = input.tables.filter((table) => (table.estimatedRows ?? 0) > 1_000_000).map((table) => table.name);
  return {
    databaseName: input.databaseName,
    dialect: input.dialect,
    tableCount: input.tables.length,
    tables: input.tables,
    relationships,
    largeTables,
    generatedAt: new Date().toISOString()
  };
}

function readonlySql(input: z.infer<typeof generateReadonlySqlInputSchema>): string {
  const primary = input.tables[0];
  const cols = primary.columns.slice(0, 8).map((column) => `${q(primary.name, input.dialect)}.${q(column.name, input.dialect)}`);
  const selectItems = input.metrics.length > 0
    ? input.metrics
    : [...cols, "COUNT(*) AS row_count"];
  const group = input.groupBy.length ? `\nGROUP BY ${input.groupBy.join(", ")}` : "";
  const where = input.filters.length ? `\nWHERE ${input.filters.join(" AND ")}` : "";
  const order = input.groupBy.length ? `\nORDER BY row_count DESC` : "";
  return [
    `-- Question: ${input.question}`,
    "-- Read-only query pack. Review filters and run EXPLAIN before broad scans.",
    `SELECT ${selectItems.join(",\n       ")}`,
    `FROM ${tableRef(primary, input.dialect)}${where}${group}${order}`,
    `LIMIT ${input.limit};`,
    "",
    "-- Sanity check",
    `SELECT COUNT(*) AS total_rows FROM ${tableRef(primary, input.dialect)} LIMIT 1;`,
    ""
  ].join("\n");
}

function stripSqlComments(sql: string): string {
  return sql
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim();
}

function validateSql(sql: string, allowExplain: boolean, requireLimit: boolean) {
  const cleaned = stripSqlComments(sql);
  const normalized = cleaned.replace(/\s+/g, " ").trim().toLowerCase();
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!/^(select|with|explain)\b/.test(normalized)) errors.push("SQL must start with SELECT, WITH, or EXPLAIN.");
  const forbidden = /\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|copy|call|execute|vacuum|analyze|replace|load|set)\b/i;
  const match = forbidden.exec(cleaned);
  if (match) errors.push(`Forbidden SQL keyword: ${match[1].toUpperCase()}.`);
  const statements = cleaned.split(";").map((part) => part.trim()).filter(Boolean);
  for (const statement of statements) {
    const lower = statement.replace(/\s+/g, " ").trim().toLowerCase();
    if (!/^(select|with|explain)\b/.test(lower)) errors.push("Each SQL statement must start with SELECT, WITH, or EXPLAIN.");
    if (lower.startsWith("explain") && !allowExplain) errors.push("EXPLAIN is not allowed by this policy.");
    if (lower.startsWith("explain") && !/\b(select|with)\b/.test(lower)) errors.push("EXPLAIN must wrap a SELECT/WITH query.");
  }
  if (requireLimit && !/\blimit\s+\d+\b/i.test(cleaned)) warnings.push("No LIMIT clause found; add a bound before previewing rows.");
  if (/\bselect\s+\*/i.test(cleaned)) warnings.push("Avoid SELECT * in final analysis queries; use explicit columns.");
  if (!/\bwhere\b/i.test(cleaned)) warnings.push("No WHERE clause found; consider bounding by tenant, date, or key.");
  return { ok: errors.length === 0, errors, warnings, normalizedSql: cleaned };
}

function samplePreview(input: z.infer<typeof createDatabaseSamplePreviewQueryInputSchema>): string {
  const columns = input.table.columns.slice(0, 20).map((column) => q(column.name, input.dialect));
  const orderBy = input.orderBy ? `\nORDER BY ${q(input.orderBy, input.dialect)}` : "";
  const nullProfile = input.includeNullProfile
    ? [
        "",
        "-- Null profile",
        `SELECT ${input.table.columns.slice(0, 12).map((column) => `SUM(CASE WHEN ${q(column.name, input.dialect)} IS NULL THEN 1 ELSE 0 END) AS ${q(`${column.name}_nulls`, input.dialect)}`).join(",\n       ")}`,
        `FROM ${tableRef(input.table, input.dialect)};`
      ].join("\n")
    : "";
  return [
    "-- Deterministic sample preview",
    `SELECT ${columns.join(", ")}`,
    `FROM ${tableRef(input.table, input.dialect)}${orderBy}`,
    `LIMIT ${input.limit};`,
    nullProfile,
    ""
  ].join("\n");
}

function performanceHints(input: z.infer<typeof suggestDatabasePerformanceHintsInputSchema>) {
  const sql = input.sql.toLowerCase();
  const hints: string[] = [];
  if (/\bselect\s+\*/i.test(input.sql)) hints.push("Replace SELECT * with explicit columns to reduce I/O and result size.");
  if (!/\bwhere\b/i.test(input.sql)) hints.push("Add selective WHERE predicates before running against large tables.");
  if (/\border\s+by\b/i.test(input.sql) && !/\blimit\b/i.test(input.sql)) hints.push("ORDER BY without LIMIT can force large sorts.");
  if (/\bjoin\b/i.test(input.sql) && !/\bon\b/i.test(input.sql)) hints.push("JOIN without ON may create a Cartesian product.");
  if (/\blower\s*\(|\bupper\s*\(|\bdate\s*\(/i.test(input.sql)) hints.push("Functions on filtered columns can prevent index usage; consider computed columns or range predicates.");
  for (const table of input.tables) {
    const tableMentioned = sql.includes(table.name.toLowerCase());
    if (!tableMentioned) continue;
    const indexed = table.columns.filter((column) => column.indexed || column.primaryKey).map((column) => column.name);
    if (indexed.length === 0) hints.push(`Table ${table.name} has no indexed/primary-key columns in the supplied schema.`);
  }
  if (/seq scan|table scan|filesort|temporary|full scan/i.test(input.explainText)) hints.push("EXPLAIN indicates a scan/sort risk; review predicates, indexes, and result ordering.");
  if (hints.length === 0) hints.push("No obvious static performance risks detected; verify with EXPLAIN on the target database.");
  return {
    dialect: input.dialect,
    hints,
    explainSignals: input.explainText ? input.explainText.split("\n").filter((line) => /scan|sort|join|rows|cost|filesort|temporary/i.test(line)).slice(0, 20) : [],
    caveats: ["Static SQL hints are advisory. Confirm with EXPLAIN and bounded sample queries on the actual database."]
  };
}

async function maybeWrite(ctx: ToolContext, projectId: string | undefined, writeToProject: boolean, outputPath: string, content: string): Promise<string[]> {
  if (!writeToProject) return [];
  if (!projectId) throw new Error("projectId is required when writeToProject is true.");
  const file = await writeProjectFile(ctx.projectRoot, projectId, outputPath, content);
  return [file.path];
}

export const databaseAnalysisTools: ToolModule[] = [
  {
    definition: {
      name: "create_database_schema_inventory",
      description: "Create a reviewable read-only database schema inventory from supplied table/column metadata.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, databaseName: { type: "string" }, dialect: { type: "string", enum: ["postgres", "mysql", "sqlite", "generic"] }, tables: { type: "array" }, outputPath: { type: "string" } }, required: ["projectId", "tables"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: createDatabaseSchemaInventoryInputSchema,
    handler: async (input, ctx) => {
      const parsed = createDatabaseSchemaInventoryInputSchema.parse(input);
      const inventory = schemaInventory(parsed);
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(inventory, null, 2)}\n`);
      return { ok: true, summary: `Created database schema inventory for ${parsed.tables.length} table(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: inventory, logs: [JSON.stringify(inventory, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "generate_readonly_sql",
      description: "Generate a bounded SELECT-only SQL query pack from supplied table metadata, metrics, filters, and grouping.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, dialect: { type: "string", enum: ["postgres", "mysql", "sqlite", "generic"] }, question: { type: "string" }, tables: { type: "array" }, metrics: { type: "array", items: { type: "string" } }, filters: { type: "array", items: { type: "string" } }, groupBy: { type: "array", items: { type: "string" } }, limit: { type: "number" }, writeToProject: { type: "boolean" }, outputPath: { type: "string" } }, required: ["question", "tables"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: generateReadonlySqlInputSchema,
    handler: async (input, ctx) => {
      const parsed = generateReadonlySqlInputSchema.parse(input);
      const sql = readonlySql(parsed);
      const validation = validateSql(sql, true, true);
      const artifacts = await maybeWrite(ctx, parsed.projectId, parsed.writeToProject, parsed.outputPath, sql);
      return { ok: validation.ok, summary: `Generated read-only SQL with ${validation.errors.length} error(s), ${validation.warnings.length} warning(s).`, jobId: parsed.projectId, artifacts, structuredContent: { sql, validation }, logs: [sql, JSON.stringify(validation, null, 2)], errors: validation.errors };
    }
  },
  {
    definition: {
      name: "validate_readonly_sql",
      description: "Validate that SQL is SELECT/WITH/EXPLAIN-only and flag missing LIMIT, SELECT *, broad scans, and write keywords.",
      inputSchema: { type: "object", properties: { sql: { type: "string" }, dialect: { type: "string", enum: ["postgres", "mysql", "sqlite", "generic"] }, allowExplain: { type: "boolean" }, requireLimit: { type: "boolean" } }, required: ["sql"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: validateReadonlySqlInputSchema,
    handler: (input) => {
      const parsed = validateReadonlySqlInputSchema.parse(input);
      const validation = validateSql(parsed.sql, parsed.allowExplain, parsed.requireLimit);
      return { ok: validation.ok, summary: validation.ok ? `SQL is read-only with ${validation.warnings.length} warning(s).` : `SQL rejected with ${validation.errors.length} error(s).`, artifacts: [], structuredContent: { dialect: parsed.dialect, ...validation }, logs: [JSON.stringify(validation, null, 2)], errors: validation.errors };
    }
  },
  {
    definition: {
      name: "create_database_sample_preview_query",
      description: "Create bounded sample and null-profile SELECT queries for a table without executing them.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, dialect: { type: "string", enum: ["postgres", "mysql", "sqlite", "generic"] }, table: { type: "object" }, orderBy: { type: "string" }, limit: { type: "number" }, includeNullProfile: { type: "boolean" }, writeToProject: { type: "boolean" }, outputPath: { type: "string" } }, required: ["table"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: createDatabaseSamplePreviewQueryInputSchema,
    handler: async (input, ctx) => {
      const parsed = createDatabaseSamplePreviewQueryInputSchema.parse(input);
      const sql = samplePreview(parsed);
      const artifacts = await maybeWrite(ctx, parsed.projectId, parsed.writeToProject, parsed.outputPath, sql);
      return { ok: true, summary: `Created sample preview SQL for ${parsed.table.name}.`, jobId: parsed.projectId, artifacts, structuredContent: { sql }, logs: [sql], errors: [] };
    }
  },
  {
    definition: {
      name: "suggest_database_performance_hints",
      description: "Return static SQL performance hints from query text, optional schema metadata, and optional EXPLAIN text.",
      inputSchema: { type: "object", properties: { dialect: { type: "string", enum: ["postgres", "mysql", "sqlite", "generic"] }, sql: { type: "string" }, tables: { type: "array" }, explainText: { type: "string" } }, required: ["sql"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: suggestDatabasePerformanceHintsInputSchema,
    handler: (input) => {
      const parsed = suggestDatabasePerformanceHintsInputSchema.parse(input);
      const report = performanceHints(parsed);
      return { ok: true, summary: `Generated ${report.hints.length} database performance hint(s).`, artifacts: [], structuredContent: report, logs: [JSON.stringify(report, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "export_database_analysis_report",
      description: "Export a Markdown database analysis report with schema summary, query pack, findings, performance hints, and read-only caveats.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, title: { type: "string" }, question: { type: "string" }, schemaSummary: { type: "object" }, queries: { type: "array", items: { type: "string" } }, findings: { type: "array", items: { type: "string" } }, performanceHints: { type: "array", items: { type: "string" } }, outputPath: { type: "string" } }, required: ["projectId", "title"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: exportDatabaseAnalysisReportInputSchema,
    handler: async (input, ctx) => {
      const parsed = exportDatabaseAnalysisReportInputSchema.parse(input);
      const markdown = [
        `# ${parsed.title}`,
        "",
        parsed.question ? `Question: ${parsed.question}` : "Question: Not specified.",
        "",
        "## Findings",
        ...(parsed.findings.length ? parsed.findings.map((item) => `- ${item}`) : ["- No findings recorded."]),
        "",
        "## Performance Hints",
        ...(parsed.performanceHints.length ? parsed.performanceHints.map((item) => `- ${item}`) : ["- No performance hints recorded."]),
        "",
        "## Query Pack",
        ...parsed.queries.map((query, index) => [`### Query ${index + 1}`, "```sql", query.trim(), "```"].join("\n")),
        "",
        "## Schema Summary",
        "```json",
        JSON.stringify(parsed.schemaSummary, null, 2),
        "```",
        "",
        "## Safety Notes",
        "- Queries in this report are intended to be read-only.",
        "- Run EXPLAIN before broad scans and use replicas for production analysis.",
        ""
      ].join("\n");
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, markdown);
      return { ok: true, summary: `Exported database analysis report to ${file.path}.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { report: markdown }, logs: [markdown], errors: [] };
    }
  }
];
