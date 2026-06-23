import { z } from "zod";
import { readProjectFile, writeProjectFile } from "../../projects/store.js";
import type { ToolContext, ToolModule } from "../types.js";

type DataRow = Record<string, string | number | boolean | null>;
type DataType = "number" | "boolean" | "date" | "string" | "empty" | "mixed";

const maxRows = 2000;
const maxColumns = 100;

const datasetSourceBaseSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  path: z.string().min(1).max(240).optional(),
  format: z.enum(["csv", "json"]).optional(),
  rows: z.array(z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]))).max(maxRows).optional()
});

const datasetSourceSchema = datasetSourceBaseSchema.refine((input) => Boolean(input.rows || (input.projectId && input.path)), {
  message: "Provide either inline rows or projectId + path."
});

const withDatasetSource = <T extends z.ZodRawShape>(shape: T) => datasetSourceBaseSchema.extend(shape).refine((input) => Boolean(input.rows || (input.projectId && input.path)), {
  message: "Provide either inline rows or projectId + path."
});

const loadDatasetPreviewInputSchema = withDatasetSource({
  maxRows: z.number().int().min(1).max(maxRows).optional().default(50)
});

const profileDatasetQualityInputSchema = withDatasetSource({
  maxRows: z.number().int().min(1).max(maxRows).optional().default(maxRows)
});

const cleanDatasetPreviewInputSchema = withDatasetSource({
  trimStrings: z.boolean().optional().default(true),
  emptyToNull: z.boolean().optional().default(true),
  coerceNumbers: z.boolean().optional().default(true),
  dropEmptyRows: z.boolean().optional().default(true),
  maxRows: z.number().int().min(1).max(maxRows).optional().default(100)
});

const createDatasetChartSpecInputSchema = withDatasetSource({
  chartType: z.enum(["bar", "line", "scatter", "area"]).optional().default("bar"),
  xField: z.string().min(1).max(120),
  yField: z.string().min(1).max(120),
  groupBy: z.string().min(1).max(120).optional(),
  maxPoints: z.number().int().min(1).max(500).optional().default(100)
});

const forecastDatasetTrendInputSchema = withDatasetSource({
  timeField: z.string().min(1).max(120),
  valueField: z.string().min(1).max(120),
  periods: z.number().int().min(1).max(30).optional().default(5)
});

const exportDataAnalysisReportInputSchema = withDatasetSource({
  title: z.string().min(1).max(160),
  questions: z.array(z.string().min(1).max(240)).max(20).optional().default([]),
  writeToProject: z.boolean().optional().default(false),
  outputPath: z.string().min(1).max(240).optional().default("reports/data-analysis-report.md")
});

function parseCsv(text: string): DataRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted) {
      if (char === "\"" && next === "\"") {
        cell += "\"";
        index += 1;
      } else if (char === "\"") {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === "\"") quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }
  row.push(cell);
  rows.push(row);
  const [header = [], ...body] = rows.filter((item) => item.some((value) => value.trim() !== ""));
  const columns = header.map((value, index) => value.trim() || `column_${index + 1}`).slice(0, maxColumns);
  return body.slice(0, maxRows).map((values) => Object.fromEntries(columns.map((column, index) => [column, values[index] ?? ""])));
}

function parseJsonRows(text: string): DataRow[] {
  const parsed = JSON.parse(text) as unknown;
  const rows = Array.isArray(parsed) ? parsed : (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { rows?: unknown }).rows) ? (parsed as { rows: unknown[] }).rows : undefined);
  if (!rows) throw new Error("JSON dataset must be an array of row objects or an object with a rows array.");
  return rows.slice(0, maxRows).map((row) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) throw new Error("Each JSON dataset row must be an object.");
    return Object.fromEntries(Object.entries(row as Record<string, unknown>).slice(0, maxColumns).map(([key, value]) => [key, normalizeCell(value)]));
  });
}

function normalizeCell(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return JSON.stringify(value);
}

function detectFormat(pathName?: string, explicit?: "csv" | "json"): "csv" | "json" {
  if (explicit) return explicit;
  return pathName?.toLowerCase().endsWith(".json") ? "json" : "csv";
}

async function loadRows(ctx: ToolContext, input: z.infer<typeof datasetSourceSchema>): Promise<{ rows: DataRow[]; source: string; truncated: boolean }> {
  if (input.rows) return { rows: input.rows.slice(0, maxRows), source: "inline", truncated: input.rows.length > maxRows };
  const projectId = input.projectId;
  const path = input.path;
  if (!projectId || !path) throw new Error("projectId and path are required when rows are not provided.");
  const text = await readProjectFile(ctx.projectRoot, projectId, path, 5 * 1024 * 1024);
  const format = detectFormat(path, input.format);
  const rows = format === "json" ? parseJsonRows(text) : parseCsv(text);
  return { rows, source: `${projectId}:${path}`, truncated: rows.length >= maxRows };
}

function cleanRows(rows: DataRow[], options: { trimStrings: boolean; emptyToNull: boolean; coerceNumbers: boolean; dropEmptyRows: boolean }): DataRow[] {
  const cleaned = rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => {
    let next: string | number | boolean | null = value;
    if (typeof next === "string" && options.trimStrings) next = next.trim();
    if (typeof next === "string" && options.emptyToNull && next === "") next = null;
    if (typeof next === "string" && options.coerceNumbers && /^-?\d+(\.\d+)?$/.test(next)) next = Number(next);
    return [key, next];
  })));
  return options.dropEmptyRows ? cleaned.filter((row) => Object.values(row).some((value) => value !== null && value !== "")) : cleaned;
}

function columns(rows: DataRow[]): string[] {
  return [...new Set(rows.flatMap((row) => Object.keys(row)))].slice(0, maxColumns);
}

function inferType(values: Array<string | number | boolean | null>): DataType {
  const present = values.filter((value) => value !== null && value !== "");
  if (present.length === 0) return "empty";
  const checks = {
    number: present.every((value) => typeof value === "number" || (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim()))),
    boolean: present.every((value) => typeof value === "boolean" || value === "true" || value === "false"),
    date: present.every((value) => typeof value === "string" && !Number.isNaN(Date.parse(value)))
  };
  if (checks.number) return "number";
  if (checks.boolean) return "boolean";
  if (checks.date) return "date";
  return present.every((value) => typeof value === "string") ? "string" : "mixed";
}

function numericValues(rows: DataRow[], column: string): number[] {
  return rows.map((row) => row[column]).map((value) => typeof value === "number" ? value : typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : NaN).filter((value) => Number.isFinite(value));
}

function stats(values: number[]): Record<string, number> | undefined {
  if (values.length === 0) return undefined;
  const sorted = values.slice().sort((left, right) => left - right);
  const sum = values.reduce((acc, value) => acc + value, 0);
  const mean = sum / values.length;
  const variance = values.reduce((acc, value) => acc + (value - mean) ** 2, 0) / values.length;
  const pick = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)))] ?? 0;
  return {
    count: values.length,
    min: sorted[0] ?? 0,
    max: sorted.at(-1) ?? 0,
    mean: Math.round(mean * 1000) / 1000,
    median: pick(0.5),
    p25: pick(0.25),
    p75: pick(0.75),
    stddev: Math.round(Math.sqrt(variance) * 1000) / 1000
  };
}

function profileRows(rows: DataRow[]): Record<string, unknown> {
  const rowCount = rows.length;
  const schema = columns(rows).map((column) => {
    const values = rows.map((row) => row[column] ?? null);
    const missing = values.filter((value) => value === null || value === "").length;
    const type = inferType(values);
    return {
      name: column,
      type,
      missing,
      missingRate: rowCount === 0 ? 0 : Math.round((missing / rowCount) * 1000) / 1000,
      unique: new Set(values.map((value) => String(value))).size,
      stats: type === "number" ? stats(numericValues(rows, column)) : undefined
    };
  });
  const qualityIssues = schema.flatMap((field) => {
    const issues: string[] = [];
    if ((field as { missingRate: number }).missingRate > 0.25) issues.push(`${(field as { name: string }).name} has high missing rate.`);
    if ((field as { type: DataType }).type === "mixed") issues.push(`${(field as { name: string }).name} has mixed types.`);
    return issues;
  });
  return { rowCount, columnCount: schema.length, schema, qualityIssues };
}

function chartRows(rows: DataRow[], xField: string, yField: string, groupBy: string | undefined, maxPoints: number): DataRow[] {
  return rows
    .filter((row) => row[xField] !== undefined && row[yField] !== undefined)
    .slice(0, maxPoints)
    .map((row) => {
      const item: DataRow = { [xField]: row[xField] ?? null, [yField]: row[yField] ?? null };
      if (groupBy) item[groupBy] = row[groupBy] ?? null;
      return item;
    });
}

function linearForecast(rows: DataRow[], timeField: string, valueField: string, periods: number): Record<string, unknown> {
  const points = rows
    .map((row) => ({ time: String(row[timeField] ?? ""), value: typeof row[valueField] === "number" ? row[valueField] as number : Number(row[valueField]) }))
    .filter((point) => point.time && Number.isFinite(point.value));
  if (points.length < 2) throw new Error("At least two numeric points are required for a trend forecast.");
  const n = points.length;
  const xs = points.map((_, index) => index + 1);
  const ys = points.map((point) => point.value);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  const slope = xs.reduce((acc, x, index) => acc + (x - meanX) * (ys[index] - meanY), 0) / xs.reduce((acc, x) => acc + (x - meanX) ** 2, 0);
  const intercept = meanY - slope * meanX;
  return {
    method: "ordinary_least_squares_over_row_index",
    pointsUsed: n,
    slope: Math.round(slope * 1000) / 1000,
    intercept: Math.round(intercept * 1000) / 1000,
    forecast: Array.from({ length: periods }, (_, index) => ({
      step: n + index + 1,
      predictedValue: Math.round((intercept + slope * (n + index + 1)) * 1000) / 1000
    })),
    caveats: ["Forecast uses row order as time index and does not model seasonality, uncertainty intervals, or external drivers."]
  };
}

function markdownReport(title: string, source: string, profile: Record<string, unknown>, questions: string[]): string {
  const schema = profile.schema as Array<{ name: string; type: string; missingRate: number; stats?: Record<string, number> }>;
  const issues = profile.qualityIssues as string[];
  return [
    `# ${title}`,
    "",
    `Source: ${source}`,
    "",
    "## Questions",
    questions.length ? questions.map((item) => `- ${item}`).join("\n") : "- No explicit questions provided.",
    "",
    "## Dataset Profile",
    `- Rows: ${profile.rowCount}`,
    `- Columns: ${profile.columnCount}`,
    "",
    "## Schema",
    ...schema.map((field) => `- ${field.name}: ${field.type}, missing ${(field.missingRate * 100).toFixed(1)}%${field.stats ? `, mean ${field.stats.mean}` : ""}`),
    "",
    "## Quality Issues",
    issues.length ? issues.map((issue) => `- ${issue}`).join("\n") : "- No major quality issues detected by the bounded profiler.",
    "",
    "## Method Notes",
    "- Profiling is bounded to at most 2,000 rows and 100 columns.",
    "- Treat inferred types and simple statistics as exploratory, not a substitute for domain validation.",
    ""
  ].join("\n");
}

export const dataAnalysisTools: ToolModule[] = [
  {
    definition: {
      name: "load_dataset_preview",
      description: "Load a bounded CSV/JSON dataset from a project file or inline rows and return rows plus inferred schema preview.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, path: { type: "string" }, format: { type: "string", enum: ["csv", "json"] }, rows: { type: "array" }, maxRows: { type: "number" } }, additionalProperties: false }
    },
    enabledByDefault: true,
    schema: loadDatasetPreviewInputSchema,
    handler: async (input, ctx) => {
      const parsed = loadDatasetPreviewInputSchema.parse(input);
      const loaded = await loadRows(ctx, parsed);
      const rows = loaded.rows.slice(0, parsed.maxRows);
      const profile = profileRows(rows);
      return { ok: true, summary: `Loaded ${rows.length} preview row(s) from ${loaded.source}.`, artifacts: [loaded.source], structuredContent: { source: loaded.source, rows, profile, truncated: loaded.truncated }, logs: [JSON.stringify({ source: loaded.source, profile }, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "profile_dataset_quality",
      description: "Inspect dataset schema, missingness, inferred types, quality issues, and numeric summary statistics.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, path: { type: "string" }, format: { type: "string", enum: ["csv", "json"] }, rows: { type: "array" }, maxRows: { type: "number" } }, additionalProperties: false }
    },
    enabledByDefault: true,
    schema: profileDatasetQualityInputSchema,
    handler: async (input, ctx) => {
      const parsed = profileDatasetQualityInputSchema.parse(input);
      const loaded = await loadRows(ctx, parsed);
      const rows = loaded.rows.slice(0, parsed.maxRows);
      const profile = profileRows(rows);
      return { ok: true, summary: `Profiled ${rows.length} row(s), ${(profile.columnCount as number)} column(s), ${(profile.qualityIssues as string[]).length} quality issue(s).`, artifacts: [loaded.source], structuredContent: { source: loaded.source, ...profile, truncated: loaded.truncated }, logs: [JSON.stringify(profile, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "clean_dataset_preview",
      description: "Return a bounded cleaned dataset preview with string trimming, empty-to-null conversion, numeric coercion, and empty-row dropping.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, path: { type: "string" }, format: { type: "string", enum: ["csv", "json"] }, rows: { type: "array" }, trimStrings: { type: "boolean" }, emptyToNull: { type: "boolean" }, coerceNumbers: { type: "boolean" }, dropEmptyRows: { type: "boolean" }, maxRows: { type: "number" } }, additionalProperties: false }
    },
    enabledByDefault: true,
    schema: cleanDatasetPreviewInputSchema,
    handler: async (input, ctx) => {
      const parsed = cleanDatasetPreviewInputSchema.parse(input);
      const loaded = await loadRows(ctx, parsed);
      const cleaned = cleanRows(loaded.rows, parsed).slice(0, parsed.maxRows);
      return { ok: true, summary: `Cleaned preview has ${cleaned.length} row(s).`, artifacts: [loaded.source], structuredContent: { source: loaded.source, rows: cleaned, profile: profileRows(cleaned) }, logs: [JSON.stringify({ source: loaded.source, rowCount: cleaned.length }, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "create_dataset_chart_spec",
      description: "Create a bounded chart specification from a dataset for bar, line, scatter, or area charts.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, path: { type: "string" }, format: { type: "string", enum: ["csv", "json"] }, rows: { type: "array" }, chartType: { type: "string", enum: ["bar", "line", "scatter", "area"] }, xField: { type: "string" }, yField: { type: "string" }, groupBy: { type: "string" }, maxPoints: { type: "number" } }, required: ["xField", "yField"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: createDatasetChartSpecInputSchema,
    handler: async (input, ctx) => {
      const parsed = createDatasetChartSpecInputSchema.parse(input);
      const loaded = await loadRows(ctx, parsed);
      const data = chartRows(cleanRows(loaded.rows, { trimStrings: true, emptyToNull: true, coerceNumbers: true, dropEmptyRows: true }), parsed.xField, parsed.yField, parsed.groupBy, parsed.maxPoints);
      const spec = { chartType: parsed.chartType, source: loaded.source, fields: { x: parsed.xField, y: parsed.yField, color: parsed.groupBy }, data, rowCount: data.length };
      return { ok: true, summary: `Created ${parsed.chartType} chart spec with ${data.length} point(s).`, artifacts: [loaded.source], structuredContent: spec, logs: [JSON.stringify(spec, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "forecast_dataset_trend",
      description: "Build a simple bounded linear trend forecast for a numeric value field over row order/time field.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, path: { type: "string" }, format: { type: "string", enum: ["csv", "json"] }, rows: { type: "array" }, timeField: { type: "string" }, valueField: { type: "string" }, periods: { type: "number" } }, required: ["timeField", "valueField"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: forecastDatasetTrendInputSchema,
    handler: async (input, ctx) => {
      const parsed = forecastDatasetTrendInputSchema.parse(input);
      const loaded = await loadRows(ctx, parsed);
      const rows = cleanRows(loaded.rows, { trimStrings: true, emptyToNull: true, coerceNumbers: true, dropEmptyRows: true });
      const forecast = linearForecast(rows, parsed.timeField, parsed.valueField, parsed.periods);
      return { ok: true, summary: `Forecasted ${parsed.periods} future period(s) for ${parsed.valueField}.`, artifacts: [loaded.source], structuredContent: { source: loaded.source, ...forecast }, logs: [JSON.stringify(forecast, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "export_data_analysis_report",
      description: "Export a bounded Markdown data analysis report with schema, quality issues, statistics, and methodology notes.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, path: { type: "string" }, format: { type: "string", enum: ["csv", "json"] }, rows: { type: "array" }, title: { type: "string" }, questions: { type: "array", items: { type: "string" } }, writeToProject: { type: "boolean" }, outputPath: { type: "string" } }, required: ["title"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: exportDataAnalysisReportInputSchema,
    handler: async (input, ctx) => {
      const parsed = exportDataAnalysisReportInputSchema.parse(input);
      const loaded = await loadRows(ctx, parsed);
      const profile = profileRows(cleanRows(loaded.rows, { trimStrings: true, emptyToNull: true, coerceNumbers: true, dropEmptyRows: true }));
      const report = markdownReport(parsed.title, loaded.source, profile, parsed.questions);
      const artifacts = [loaded.source];
      if (parsed.writeToProject) {
        if (!parsed.projectId) throw new Error("projectId is required when writeToProject is true.");
        const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, report);
        artifacts.push(file.path);
      }
      return { ok: true, summary: parsed.writeToProject ? `Exported data analysis report to ${parsed.outputPath}.` : "Generated data analysis report.", jobId: parsed.projectId, artifacts, structuredContent: { source: loaded.source, report, profile, outputPath: parsed.writeToProject ? parsed.outputPath : undefined }, logs: [report], errors: [] };
    }
  }
];
