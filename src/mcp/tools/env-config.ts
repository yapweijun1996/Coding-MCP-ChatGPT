import { z } from "zod";
import { readProjectFile, writeProjectFile } from "../../projects/store.js";
import type { ToolModule } from "../types.js";

const environmentSchema = z.enum(["dev", "preview", "demo", "production"]);
const entryKindSchema = z.enum(["env_var", "feature_flag", "config_value"]);
const statusSchema = z.enum(["configured", "missing", "placeholder", "external_secret", "not_required"]);

const envEntrySchema = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9_]{1,120}$/),
  kind: entryKindSchema.default("env_var"),
  environment: environmentSchema,
  required: z.boolean().default(false),
  secret: z.boolean().default(false),
  status: statusSchema.default("missing"),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  safeDefault: z.union([z.string(), z.number(), z.boolean()]).optional(),
  allowedValues: z.array(z.union([z.string(), z.number(), z.boolean()])).max(50).default([]),
  description: z.string().max(500).default(""),
  owner: z.string().max(160).optional()
});

const envConfigPathSchema = z.string().min(1).max(240).default("env-config/env-config.json");

const upsertEnvConfigProfileInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  environment: environmentSchema,
  label: z.string().min(1).max(120).optional(),
  safeDefaultsPolicy: z.enum(["strict", "warn", "off"]).default("warn"),
  notes: z.string().max(1000).default(""),
  configPath: envConfigPathSchema
});

const upsertEnvConfigEntryInputSchema = envEntrySchema.extend({
  projectId: z.string().min(8).max(80),
  configPath: envConfigPathSchema
});

const listEnvConfigProfilesInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  environment: environmentSchema.optional(),
  configPath: envConfigPathSchema
});

const validateEnvConfigInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  environment: environmentSchema.optional(),
  configPath: envConfigPathSchema
});

const exportEnvConfigReportInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  title: z.string().min(1).max(200).default("Environment Configuration Report"),
  configPath: envConfigPathSchema,
  outputPath: z.string().min(1).max(240).default("env-config/env-config-report.md")
});

type EnvConfigEntry = z.infer<typeof envEntrySchema> & { updatedAt: string; valueRedacted?: boolean };
type EnvProfile = { environment: z.infer<typeof environmentSchema>; label: string; safeDefaultsPolicy: "strict" | "warn" | "off"; notes: string; updatedAt: string };
type EnvConfigFile = { version: 1; projectId: string; updatedAt: string; profiles: EnvProfile[]; entries: EnvConfigEntry[] };

function now(): string {
  return new Date().toISOString();
}

async function readConfig(projectRoot: string, projectId: string, configPath: string): Promise<EnvConfigFile> {
  try {
    const raw = await readProjectFile(projectRoot, projectId, configPath, 2 * 1024 * 1024);
    const parsed = JSON.parse(raw) as Partial<EnvConfigFile>;
    if (parsed.version === 1 && Array.isArray(parsed.profiles) && Array.isArray(parsed.entries)) {
      return {
        version: 1,
        projectId,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : now(),
        profiles: parsed.profiles as EnvProfile[],
        entries: parsed.entries as EnvConfigEntry[]
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!/not found|ENOENT|no such file/i.test(message)) throw error;
  }
  return { version: 1, projectId, updatedAt: now(), profiles: [], entries: [] };
}

async function writeConfig(projectRoot: string, projectId: string, configPath: string, config: EnvConfigFile) {
  const payload = {
    ...config,
    updatedAt: now(),
    profiles: config.profiles.sort((a, b) => a.environment.localeCompare(b.environment)),
    entries: config.entries.sort((a, b) => a.environment.localeCompare(b.environment) || a.key.localeCompare(b.key))
  };
  const file = await writeProjectFile(projectRoot, projectId, configPath, `${JSON.stringify(payload, null, 2)}\n`);
  return { payload, file };
}

function sanitizeEntry(input: z.infer<typeof envEntrySchema>): { entry: EnvConfigEntry; warnings: string[] } {
  const warnings: string[] = [];
  const entry: EnvConfigEntry = { ...input, updatedAt: now() };
  if (entry.secret && entry.value !== undefined) {
    delete entry.value;
    entry.valueRedacted = true;
    entry.status = entry.status === "configured" ? "external_secret" : entry.status;
    warnings.push(`Secret value for ${entry.key} was not stored; use external secret management.`);
  }
  if (entry.secret && entry.safeDefault !== undefined) {
    warnings.push(`Secret ${entry.key} has a safeDefault; verify it is only a placeholder and not a real credential.`);
  }
  if (entry.environment === "production" && entry.kind === "feature_flag" && entry.value === true && entry.safeDefault === undefined) {
    warnings.push(`Production feature flag ${entry.key} is enabled without a documented safeDefault.`);
  }
  return { entry, warnings };
}

function validate(config: EnvConfigFile, environment?: z.infer<typeof environmentSchema>) {
  const entries = environment ? config.entries.filter((entry) => entry.environment === environment) : config.entries;
  const findings: Array<{ severity: "high" | "medium" | "low"; key?: string; environment?: string; message: string; recommendation: string }> = [];
  for (const entry of entries) {
    if (entry.required && (entry.status === "missing" || entry.status === "placeholder")) {
      findings.push({ severity: "high", key: entry.key, environment: entry.environment, message: `Required ${entry.key} is ${entry.status}.`, recommendation: "Configure it before publishing or running production workflows." });
    }
    if (entry.secret && entry.value !== undefined) {
      findings.push({ severity: "high", key: entry.key, environment: entry.environment, message: `Secret ${entry.key} has a persisted value.`, recommendation: "Remove the value and store the secret externally." });
    }
    if (!entry.secret && entry.required && entry.safeDefault === undefined && entry.environment !== "production") {
      findings.push({ severity: "medium", key: entry.key, environment: entry.environment, message: `${entry.key} has no safe default.`, recommendation: "Document a safe fallback or placeholder for dev/demo use." });
    }
    if (entry.environment === "production" && entry.status === "not_required" && entry.required) {
      findings.push({ severity: "high", key: entry.key, environment: entry.environment, message: `Production required key ${entry.key} is marked not_required.`, recommendation: "Set a real configured/external_secret status or mark it not required only if the requirement changed." });
    }
  }
  const profileEnvironments = new Set(config.profiles.map((profile) => profile.environment));
  const entryEnvironments = new Set(entries.map((entry) => entry.environment));
  for (const env of entryEnvironments) {
    if (!profileEnvironments.has(env)) findings.push({ severity: "low", environment: env, message: `Entries exist for ${env} without a profile.`, recommendation: "Create an environment profile to document policy and notes." });
  }
  const high = findings.filter((finding) => finding.severity === "high").length;
  const medium = findings.filter((finding) => finding.severity === "medium").length;
  return {
    status: high ? "blocked" : medium ? "warning" : "ready",
    environment: environment ?? "all",
    totalEntries: entries.length,
    findings,
    counts: { high, medium, low: findings.length - high - medium }
  };
}

function markdown(title: string, config: EnvConfigFile, validation: ReturnType<typeof validate>): string {
  const rows = config.entries.map((entry) => `| ${entry.environment} | ${entry.key} | ${entry.kind} | ${entry.required ? "yes" : "no"} | ${entry.secret ? "yes" : "no"} | ${entry.status} | ${entry.safeDefault ?? "-"} |`).join("\n");
  const findings = validation.findings.map((finding) => `- **${finding.severity}** ${finding.environment ?? ""} ${finding.key ?? ""}: ${finding.message} ${finding.recommendation}`).join("\n");
  return `# ${title}

- Project: \`${config.projectId}\`
- Profiles: ${config.profiles.length}
- Entries: ${config.entries.length}
- Validation status: ${validation.status}

## Entries

| Environment | Key | Kind | Required | Secret | Status | Safe Default |
| --- | --- | --- | --- | --- | --- | --- |
${rows || "| - | - | - | - | - | - | - |"}

## Findings

${findings || "No findings."}
`;
}

export const envConfigTools: ToolModule[] = [
  {
    definition: { name: "upsert_env_config_profile", description: "Create or update a project environment profile for dev, preview, demo, or production config policy.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, environment: { type: "string" }, label: { type: "string" }, safeDefaultsPolicy: { type: "string" }, notes: { type: "string" }, configPath: { type: "string" } }, required: ["projectId", "environment"], additionalProperties: false } },
    enabledByDefault: true,
    schema: upsertEnvConfigProfileInputSchema,
    handler: async (input, ctx) => {
      const parsed = upsertEnvConfigProfileInputSchema.parse(input);
      const config = await readConfig(ctx.projectRoot, parsed.projectId, parsed.configPath);
      const profile: EnvProfile = { environment: parsed.environment, label: parsed.label ?? parsed.environment, safeDefaultsPolicy: parsed.safeDefaultsPolicy, notes: parsed.notes, updatedAt: now() };
      const profiles = [...config.profiles.filter((item) => item.environment !== parsed.environment), profile];
      const { payload, file } = await writeConfig(ctx.projectRoot, parsed.projectId, parsed.configPath, { ...config, profiles });
      return { ok: true, summary: `Updated ${parsed.environment} environment profile.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { profile, profileCount: payload.profiles.length }, logs: [JSON.stringify(profile, null, 2)], errors: [] };
    }
  },
  {
    definition: { name: "upsert_env_config_entry", description: "Create or update one environment variable, feature flag, or config value without persisting real secrets.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, key: { type: "string" }, kind: { type: "string" }, environment: { type: "string" }, required: { type: "boolean" }, secret: { type: "boolean" }, status: { type: "string" }, value: {}, safeDefault: {}, allowedValues: { type: "array" }, description: { type: "string" }, owner: { type: "string" }, configPath: { type: "string" } }, required: ["projectId", "key", "environment"], additionalProperties: false } },
    enabledByDefault: true,
    schema: upsertEnvConfigEntryInputSchema,
    handler: async (input, ctx) => {
      const parsed = upsertEnvConfigEntryInputSchema.parse(input);
      const config = await readConfig(ctx.projectRoot, parsed.projectId, parsed.configPath);
      const { entry, warnings } = sanitizeEntry(envEntrySchema.parse(parsed));
      const entries = [...config.entries.filter((item) => !(item.environment === entry.environment && item.key === entry.key)), entry];
      const { payload, file } = await writeConfig(ctx.projectRoot, parsed.projectId, parsed.configPath, { ...config, entries });
      return { ok: warnings.length === 0, summary: `Updated ${entry.environment} config entry ${entry.key}.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { entry, entryCount: payload.entries.length, warnings }, logs: [JSON.stringify({ entry, warnings }, null, 2)], errors: warnings };
    }
  },
  {
    definition: { name: "list_env_config_profiles", description: "List project environment profiles and config entries, optionally scoped to one environment.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, environment: { type: "string" }, configPath: { type: "string" } }, required: ["projectId"], additionalProperties: false } },
    enabledByDefault: true,
    schema: listEnvConfigProfilesInputSchema,
    handler: async (input, ctx) => {
      const parsed = listEnvConfigProfilesInputSchema.parse(input);
      const config = await readConfig(ctx.projectRoot, parsed.projectId, parsed.configPath);
      const profiles = parsed.environment ? config.profiles.filter((profile) => profile.environment === parsed.environment) : config.profiles;
      const entries = parsed.environment ? config.entries.filter((entry) => entry.environment === parsed.environment) : config.entries;
      return { ok: true, summary: `Found ${profiles.length} profile(s) and ${entries.length} config entrie(s).`, jobId: parsed.projectId, artifacts: [], structuredContent: { profiles, entries }, logs: [JSON.stringify({ profiles, entries }, null, 2)], errors: [] };
    }
  },
  {
    definition: { name: "validate_env_config", description: "Validate environment config for missing required values, unsafe persisted secrets, placeholders, and safe-default gaps.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, environment: { type: "string" }, configPath: { type: "string" } }, required: ["projectId"], additionalProperties: false } },
    enabledByDefault: true,
    schema: validateEnvConfigInputSchema,
    handler: async (input, ctx) => {
      const parsed = validateEnvConfigInputSchema.parse(input);
      const config = await readConfig(ctx.projectRoot, parsed.projectId, parsed.configPath);
      const result = validate(config, parsed.environment);
      return { ok: result.status !== "blocked", summary: `Environment config validation is ${result.status} with ${result.findings.length} finding(s).`, jobId: parsed.projectId, artifacts: [], structuredContent: result, logs: [JSON.stringify(result, null, 2)], errors: result.findings.filter((finding) => finding.severity === "high").map((finding) => finding.message) };
    }
  },
  {
    definition: { name: "export_env_config_report", description: "Export a Markdown environment configuration report with profiles, entries, safe defaults, and validation findings.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, title: { type: "string" }, configPath: { type: "string" }, outputPath: { type: "string" } }, required: ["projectId"], additionalProperties: false } },
    enabledByDefault: true,
    schema: exportEnvConfigReportInputSchema,
    handler: async (input, ctx) => {
      const parsed = exportEnvConfigReportInputSchema.parse(input);
      const config = await readConfig(ctx.projectRoot, parsed.projectId, parsed.configPath);
      const result = validate(config);
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, markdown(parsed.title, config, result));
      return { ok: true, summary: `Exported environment config report to ${file.path}.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { outputPath: file.path, validation: result }, logs: [JSON.stringify({ outputPath: file.path, validation: result }, null, 2)], errors: [] };
    }
  }
];
