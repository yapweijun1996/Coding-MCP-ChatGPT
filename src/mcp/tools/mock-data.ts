import { z } from "zod";
import { appendProjectTaskHistory, getProjectManifest, writeProjectFile } from "../../projects/store.js";
import type { ToolModule } from "../types.js";

type FieldSpec = z.infer<typeof fieldSpecSchema>;
type TableSpec = z.infer<typeof tableSpecSchema>;

const fieldSpecSchema = z.object({
  name: z.string().min(1).max(80).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  type: z.enum(["id", "string", "name", "email", "phone", "city", "country", "status", "number", "currency", "date", "boolean", "sku", "foreignKey"]),
  values: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).max(80).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  prefix: z.string().max(40).optional(),
  reference: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/).optional()
});

const tableSpecSchema = z.object({
  name: z.string().min(1).max(80).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  rowCount: z.number().int().min(1).max(10000),
  fields: z.array(fieldSpecSchema).min(1).max(80),
  includeEdgeCases: z.boolean().default(true)
});

const generateMockDataInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  seed: z.number().int().min(1).max(2147483647).default(12345),
  domain: z.string().min(1).max(80).default("admin"),
  tables: z.array(tableSpecSchema).min(1).max(30).optional(),
  outputDir: z.string().min(1).max(160).default("mock-data"),
  formats: z.array(z.enum(["json", "csv"])).min(1).max(2).default(["json", "csv"])
});

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, values: T[]): T {
  return values[Math.floor(rng() * values.length)]!;
}

const firstNames = ["Ada", "Grace", "Lin", "Maya", "Noor", "Iris", "Omar", "Kenji", "Ava", "Ravi"];
const lastNames = ["Tan", "Lim", "Chen", "Patel", "Ng", "Wong", "Lee", "Singh", "Khan", "Hopper"];
const cities = ["Singapore", "Kuala Lumpur", "Jakarta", "Bangkok", "Tokyo", "Sydney", "Manila"];
const countries = ["Singapore", "Malaysia", "Indonesia", "Thailand", "Japan", "Australia", "Philippines"];
const statuses = ["active", "pending", "paused", "archived"];
const productWords = ["Atlas", "Beacon", "Cedar", "Delta", "Ember", "Forge", "Harbor", "Ion", "Jade", "Keystone"];

function defaultTables(domain: string): TableSpec[] {
  const prefix = domain.replace(/[^A-Za-z0-9]/g, "").slice(0, 3).toUpperCase() || "ADM";
  return [
    {
      name: "customers",
      rowCount: 25,
      includeEdgeCases: true,
      fields: [
        { name: "id", type: "id", prefix: "cus" },
        { name: "name", type: "name" },
        { name: "email", type: "email" },
        { name: "city", type: "city" },
        { name: "country", type: "country" },
        { name: "status", type: "status", values: ["active", "trial", "past_due", "churned"] },
        { name: "created_at", type: "date" }
      ]
    },
    {
      name: "orders",
      rowCount: 60,
      includeEdgeCases: true,
      fields: [
        { name: "id", type: "id", prefix: "ord" },
        { name: "customer_id", type: "foreignKey", reference: "customers.id" },
        { name: "sku", type: "sku", prefix },
        { name: "amount", type: "currency", min: 0, max: 2500 },
        { name: "status", type: "status", values: ["new", "paid", "fulfilled", "refunded", "cancelled"] },
        { name: "ordered_at", type: "date" }
      ]
    }
  ];
}

function edgeValue(field: FieldSpec, index: number): unknown | undefined {
  if (index !== 0) return undefined;
  if (field.type === "string" || field.type === "name" || field.type === "email" || field.type === "phone") return "";
  if (field.type === "number" || field.type === "currency") return field.min ?? 0;
  if (field.type === "date") return "1970-01-01";
  if (field.type === "status") return field.values?.[0] ?? "unknown";
  return undefined;
}

function generateValue(field: FieldSpec, rowIndex: number, rng: () => number, generated: Record<string, Array<Record<string, unknown>>>): unknown {
  const edge = edgeValue(field, rowIndex);
  if (edge !== undefined) return edge;
  if (field.values?.length) return pick(rng, field.values);
  if (field.type === "id") return `${field.prefix ?? "row"}_${String(rowIndex + 1).padStart(4, "0")}`;
  if (field.type === "name") return `${pick(rng, firstNames)} ${pick(rng, lastNames)}`;
  if (field.type === "email") return `user${rowIndex + 1}@example.test`;
  if (field.type === "phone") return `+65 6${Math.floor(1000000 + rng() * 8999999)}`;
  if (field.type === "city") return pick(rng, cities);
  if (field.type === "country") return pick(rng, countries);
  if (field.type === "status") return pick(rng, statuses);
  if (field.type === "number") return Math.round(((field.min ?? 0) + rng() * ((field.max ?? 1000) - (field.min ?? 0))) * 100) / 100;
  if (field.type === "currency") return Math.round(((field.min ?? 10) + rng() * ((field.max ?? 5000) - (field.min ?? 10))) * 100) / 100;
  if (field.type === "date") {
    const start = Date.UTC(2024, 0, 1);
    const offset = Math.floor(rng() * 730) * 86400000;
    return new Date(start + offset).toISOString().slice(0, 10);
  }
  if (field.type === "boolean") return rng() > 0.5;
  if (field.type === "sku") return `${field.prefix ?? "SKU"}-${pick(rng, productWords).toUpperCase()}-${String(rowIndex + 1).padStart(3, "0")}`;
  if (field.type === "foreignKey") {
    if (!field.reference) throw new Error(`foreignKey field ${field.name} requires reference.`);
    const [tableName, fieldName] = field.reference.split(".");
    const rows = generated[tableName!];
    if (!rows?.length) throw new Error(`Referenced table ${tableName} must be generated before ${field.name}.`);
    return pick(rng, rows)[fieldName!];
  }
  return `${field.name} ${rowIndex + 1}`;
}

function generateTable(table: TableSpec, rng: () => number, generated: Record<string, Array<Record<string, unknown>>>): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let rowIndex = 0; rowIndex < table.rowCount; rowIndex += 1) {
    const row: Record<string, unknown> = {};
    for (const field of table.fields) {
      row[field.name] = table.includeEdgeCases ? generateValue(field, rowIndex, rng, generated) : generateValue({ ...field, values: field.values }, rowIndex + 1, rng, generated);
    }
    rows.push(row);
  }
  generated[table.name] = rows;
  return rows;
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

function toCsv(rows: Array<Record<string, unknown>>, fields: string[]): string {
  return `${fields.join(",")}\n${rows.map((row) => fields.map((field) => csvEscape(row[field])).join(",")).join("\n")}\n`;
}

export const mockDataTools: ToolModule[] = [
  {
    definition: {
      name: "generate_mock_data_fixture",
      description: "Generate deterministic project JSON/CSV mock tables for admin, ERP, inventory, sales, and dashboard demos, with schema fields, relationships, row counts, and edge cases.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          seed: { type: "number" },
          domain: { type: "string" },
          tables: { type: "array", items: { type: "object" } },
          outputDir: { type: "string" },
          formats: { type: "array", items: { type: "string", enum: ["json", "csv"] } }
        },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: generateMockDataInputSchema,
    handler: async (input, ctx) => {
      const parsed = generateMockDataInputSchema.parse(input);
      await getProjectManifest(ctx.projectRoot, parsed.projectId);
      const rng = mulberry32(parsed.seed);
      const tables = parsed.tables?.length ? parsed.tables : defaultTables(parsed.domain);
      const generated: Record<string, Array<Record<string, unknown>>> = {};
      const artifacts: string[] = [];
      const manifest = {
        version: 1,
        domain: parsed.domain,
        seed: parsed.seed,
        generatedAt: new Date().toISOString(),
        tables: tables.map((table) => ({
          name: table.name,
          rowCount: table.rowCount,
          fields: table.fields,
          includeEdgeCases: table.includeEdgeCases
        }))
      };
      for (const table of tables) {
        const rows = generateTable(table, rng, generated);
        if (parsed.formats.includes("json")) {
          artifacts.push((await writeProjectFile(ctx.projectRoot, parsed.projectId, `${parsed.outputDir}/${table.name}.json`, `${JSON.stringify(rows, null, 2)}\n`)).path);
        }
        if (parsed.formats.includes("csv")) {
          artifacts.push((await writeProjectFile(ctx.projectRoot, parsed.projectId, `${parsed.outputDir}/${table.name}.csv`, toCsv(rows, table.fields.map((field) => field.name)))).path);
        }
      }
      artifacts.push((await writeProjectFile(ctx.projectRoot, parsed.projectId, `${parsed.outputDir}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`)).path);
      await appendProjectTaskHistory(ctx.projectRoot, parsed.projectId, { toolName: "generate_mock_data_fixture", ok: true, summary: `Generated ${tables.length} mock data table(s).`, details: { outputDir: parsed.outputDir, seed: parsed.seed, tables: manifest.tables } });
      return { ok: true, summary: `Generated ${tables.length} mock data table(s).`, jobId: parsed.projectId, artifacts, structuredContent: { projectId: parsed.projectId, outputDir: parsed.outputDir, seed: parsed.seed, tables: Object.fromEntries(Object.entries(generated).map(([name, rows]) => [name, { rowCount: rows.length, preview: rows.slice(0, 3) }])) }, logs: [JSON.stringify({ outputDir: parsed.outputDir, seed: parsed.seed, artifacts }, null, 2)], errors: [] };
    }
  }
];
