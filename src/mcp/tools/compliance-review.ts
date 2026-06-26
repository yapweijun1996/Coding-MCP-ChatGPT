import { z } from "zod";
import { listProjectFiles, readProjectFile, writeProjectFile } from "../../projects/store.js";
import type { ToolModule } from "../types.js";

const intendedUseSchema = z.enum(["demo", "internal", "commercial", "open_source"]);
const riskSchema = z.enum(["low", "medium", "high", "unknown"]);

const assetAttributionSchema = z.object({
  path: z.string().min(1).max(500),
  sourceUrl: z.string().max(1000).optional(),
  author: z.string().max(200).optional(),
  license: z.string().max(160).optional(),
  attributionText: z.string().max(1000).optional(),
  intendedUse: intendedUseSchema.optional().default("demo"),
  notes: z.string().max(1000).optional()
});

const scanProjectComplianceSourcesInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  maxFiles: z.number().int().min(1).max(1000).optional().default(300),
  outputPath: z.string().min(1).max(240).optional().default("compliance-review/source-scan.json")
});

const createAssetAttributionManifestInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  assets: z.array(assetAttributionSchema).min(1).max(500),
  outputPath: z.string().min(1).max(240).optional().default("compliance-review/asset-attribution.json")
});

const evaluateLicenseComplianceInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  intendedUse: intendedUseSchema.optional().default("demo"),
  licenses: z.array(z.object({
    name: z.string().min(1).max(200),
    license: z.string().min(1).max(160),
    source: z.string().max(500).optional()
  })).max(500).optional().default([]),
  outputPath: z.string().min(1).max(240).optional().default("compliance-review/license-evaluation.json")
});

const auditPrivacyDataHandlingInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  dataTypes: z.array(z.string().min(1).max(160)).max(100).optional().default([]),
  thirdPartyServices: z.array(z.string().min(1).max(200)).max(100).optional().default([]),
  storesPersonalData: z.boolean().optional().default(false),
  collectsAnalytics: z.boolean().optional().default(false),
  outputPath: z.string().min(1).max(240).optional().default("compliance-review/privacy-data-audit.json")
});

const createComplianceChecklistInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  preset: z.enum(["demo", "production", "commercial", "data_app"]).optional().default("demo"),
  outputPath: z.string().min(1).max(240).optional().default("compliance-review/checklist.json")
});

const exportComplianceReportInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  title: z.string().min(1).max(200).optional().default("Compliance and License Review"),
  scan: z.record(z.string(), z.unknown()).optional().default({}),
  attribution: z.record(z.string(), z.unknown()).optional().default({}),
  licenseEvaluation: z.record(z.string(), z.unknown()).optional().default({}),
  privacyAudit: z.record(z.string(), z.unknown()).optional().default({}),
  checklist: z.record(z.string(), z.unknown()).optional().default({}),
  outputPath: z.string().min(1).max(240).optional().default("compliance-review/compliance-report.md")
});

const permissiveLicenses = new Set(["mit", "apache-2.0", "bsd-2-clause", "bsd-3-clause", "isc", "0bsd"]);
const copyleftLicenses = ["gpl", "agpl", "lgpl", "mpl"];
const nonCommercialSignals = ["noncommercial", "non-commercial", "cc-by-nc", "cc by-nc", "nc"];

function classifyLicense(license: string, intendedUse: z.infer<typeof intendedUseSchema>) {
  const normalized = license.toLowerCase();
  const warnings: string[] = [];
  if (permissiveLicenses.has(normalized)) return { risk: "low" as const, warnings };
  if (nonCommercialSignals.some((signal) => normalized.includes(signal))) {
    warnings.push("Non-commercial license signal conflicts with commercial use.");
    return { risk: intendedUse === "commercial" ? "high" as const : "medium" as const, warnings };
  }
  if (copyleftLicenses.some((signal) => normalized.includes(signal))) {
    warnings.push("Copyleft license may impose source disclosure or redistribution obligations.");
    return { risk: intendedUse === "commercial" ? "high" as const : "medium" as const, warnings };
  }
  if (/unknown|custom|proprietary|unlicensed/i.test(license)) {
    warnings.push("License is unknown, custom, proprietary, or absent.");
    return { risk: "unknown" as const, warnings };
  }
  return { risk: "medium" as const, warnings: ["License should be reviewed before external distribution."] };
}

function externalUrls(text: string) {
  return [...new Set(text.match(/https?:\/\/[^\s"'<>)]{4,}/g) ?? [])].slice(0, 200);
}

function dataSignals(text: string) {
  const signals = [
    ["email", /\bemail\b|mailto:/i],
    ["phone", /\bphone\b|\btel:/i],
    ["location", /\blocation\b|geolocation/i],
    ["analytics", /analytics|gtag|segment|posthog|mixpanel/i],
    ["cookies", /cookie|localStorage|sessionStorage|indexedDB/i],
    ["payment", /payment|stripe|card|billing/i]
  ];
  return signals.filter(([, pattern]) => (pattern as RegExp).test(text)).map(([name]) => name);
}

function assetLike(filePath: string) {
  return /\.(png|jpe?g|webp|gif|svg|mp4|webm|mp3|wav|glb|gltf|obj|fbx|ttf|otf|woff2?)$/i.test(filePath);
}

async function readText(projectRoot: string, projectId: string, filePath: string) {
  return readProjectFile(projectRoot, projectId, filePath, 200000).catch(() => "");
}

function riskRank(risk: z.infer<typeof riskSchema>) {
  return risk === "high" ? 3 : risk === "unknown" ? 2 : risk === "medium" ? 1 : 0;
}

function renderReport(title: string, sections: Record<string, unknown>) {
  return [
    `# ${title}`,
    "",
    ...Object.entries(sections).flatMap(([name, value]) => [
      `## ${name}`,
      "",
      "```json",
      JSON.stringify(value, null, 2),
      "```",
      ""
    ])
  ].join("\n");
}

export const complianceReviewTools: ToolModule[] = [
  {
    definition: {
      name: "scan_project_compliance_sources",
      description: "Scan project files for license files, package licenses, third-party URLs, asset-like files, attribution/privacy notes, and data handling signals.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, maxFiles: { type: "number" }, outputPath: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: scanProjectComplianceSourcesInputSchema,
    handler: async (input, ctx) => {
      const parsed = scanProjectComplianceSourcesInputSchema.parse(input);
      const files = (await listProjectFiles(ctx.projectRoot, parsed.projectId)).slice(0, parsed.maxFiles);
      const textFiles = files.filter((file) => /\.(json|md|txt|html|js|ts|css)$/i.test(file.path));
      const texts = await Promise.all(textFiles.map(async (file) => ({ path: file.path, text: await readText(ctx.projectRoot, parsed.projectId, file.path) })));
      const packageJson = texts.find((file) => file.path.endsWith("package.json"));
      let packageLicense: string | undefined;
      try {
        const parsedPackage = packageJson ? JSON.parse(packageJson.text) as { license?: unknown } : undefined;
        packageLicense = typeof parsedPackage?.license === "string" ? parsedPackage.license : undefined;
      } catch {
        packageLicense = undefined;
      }
      const combined = texts.map((file) => file.text).join("\n");
      const scan = {
        projectId: parsed.projectId,
        scannedAt: new Date().toISOString(),
        fileCount: files.length,
        licenseFiles: files.filter((file) => /(^|\/)(license|licence|copying)(\.|$)/i.test(file.path)).map((file) => file.path),
        packageLicense,
        attributionFiles: files.filter((file) => /attribution|credits|third.party|third-party/i.test(file.path)).map((file) => file.path),
        privacyFiles: files.filter((file) => /privacy|data-handling|data_handling/i.test(file.path)).map((file) => file.path),
        assetFiles: files.filter((file) => assetLike(file.path)).map((file) => file.path),
        externalUrls: externalUrls(combined),
        dataSignals: [...new Set(dataSignals(combined))],
        warnings: [
          ...(!packageLicense ? ["No package.json license field found in project files."] : []),
          ...(files.some((file) => assetLike(file.path)) && !files.some((file) => /attribution|credits/i.test(file.path)) ? ["Asset-like files exist but no attribution/credits file was found."] : []),
          ...(dataSignals(combined).length && !files.some((file) => /privacy/i.test(file.path)) ? ["Data handling signals found but no privacy note was found."] : [])
        ]
      };
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(scan, null, 2)}\n`);
      return { ok: scan.warnings.length === 0, summary: `Scanned ${files.length} project file(s); ${scan.warnings.length} compliance warning(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: scan, logs: [JSON.stringify(scan, null, 2)], errors: scan.warnings };
    }
  },
  {
    definition: {
      name: "create_asset_attribution_manifest",
      description: "Create a project-local attribution manifest for third-party assets with source URL, author, license, attribution text, and commercial-use notes.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, assets: { type: "array" }, outputPath: { type: "string" } }, required: ["projectId", "assets"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: createAssetAttributionManifestInputSchema,
    handler: async (input, ctx) => {
      const parsed = createAssetAttributionManifestInputSchema.parse(input);
      const entries = parsed.assets.map((asset) => {
        const license = asset.license ?? "unknown";
        const classification = classifyLicense(license, asset.intendedUse);
        const missing = [
          ...(!asset.sourceUrl ? ["sourceUrl"] : []),
          ...(!asset.author ? ["author"] : []),
          ...(!asset.license ? ["license"] : []),
          ...(!asset.attributionText ? ["attributionText"] : [])
        ];
        return { ...asset, license, risk: missing.length ? "unknown" : classification.risk, warnings: [...classification.warnings, ...(missing.length ? [`Missing attribution fields: ${missing.join(", ")}.`] : [])] };
      });
      const manifest = { projectId: parsed.projectId, createdAt: new Date().toISOString(), entries, highestRisk: entries.map((entry) => entry.risk).sort((a, b) => riskRank(b) - riskRank(a))[0] ?? "low" };
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const warnings = entries.flatMap((entry) => entry.warnings.map((warning) => `${entry.path}: ${warning}`));
      return { ok: warnings.length === 0, summary: `Created attribution manifest for ${entries.length} asset(s); ${warnings.length} warning(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: manifest, logs: [JSON.stringify(manifest, null, 2)], errors: warnings };
    }
  },
  {
    definition: {
      name: "evaluate_license_compliance",
      description: "Evaluate dependency, package, and asset licenses for intended use, flagging unknown, copyleft, proprietary, and non-commercial risks.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, intendedUse: { type: "string" }, licenses: { type: "array" }, outputPath: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: evaluateLicenseComplianceInputSchema,
    handler: async (input, ctx) => {
      const parsed = evaluateLicenseComplianceInputSchema.parse(input);
      const packageText = await readText(ctx.projectRoot, parsed.projectId, "package.json");
      const packageLicenses = [];
      try {
        const pkg = JSON.parse(packageText) as { name?: string; license?: string };
        if (pkg.license) packageLicenses.push({ name: pkg.name ?? "project", license: pkg.license, source: "package.json" });
      } catch {
        // No package metadata available in project files.
      }
      const entries = [...packageLicenses, ...parsed.licenses].map((item) => ({ ...item, ...classifyLicense(item.license, parsed.intendedUse) }));
      const highRisk = entries.filter((entry) => entry.risk === "high" || entry.risk === "unknown");
      const evaluation = { projectId: parsed.projectId, intendedUse: parsed.intendedUse, evaluatedAt: new Date().toISOString(), entries, highRisk, ok: highRisk.length === 0 };
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(evaluation, null, 2)}\n`);
      return { ok: evaluation.ok, summary: `Evaluated ${entries.length} license item(s); ${highRisk.length} high/unknown risk item(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: evaluation, logs: [JSON.stringify(evaluation, null, 2)], errors: highRisk.map((entry) => `${entry.name}: ${entry.license} (${entry.risk})`) };
    }
  },
  {
    definition: {
      name: "audit_privacy_data_handling",
      description: "Audit project privacy and data-handling posture for personal data, analytics, third-party services, storage, and required privacy notes.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, dataTypes: { type: "array", items: { type: "string" } }, thirdPartyServices: { type: "array", items: { type: "string" } }, storesPersonalData: { type: "boolean" }, collectsAnalytics: { type: "boolean" }, outputPath: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: auditPrivacyDataHandlingInputSchema,
    handler: async (input, ctx) => {
      const parsed = auditPrivacyDataHandlingInputSchema.parse(input);
      const files = await listProjectFiles(ctx.projectRoot, parsed.projectId);
      const privacyFiles = files.filter((file) => /privacy|data-handling|data_handling/i.test(file.path)).map((file) => file.path);
      const warnings = [
        ...((parsed.storesPersonalData || parsed.collectsAnalytics || parsed.dataTypes.length || parsed.thirdPartyServices.length) && privacyFiles.length === 0 ? ["Privacy/data-handling note is required but was not found."] : []),
        ...(parsed.thirdPartyServices.length ? ["Third-party services require disclosure and scope review."] : []),
        ...(parsed.storesPersonalData ? ["Personal data storage requires retention, deletion, and access notes."] : [])
      ];
      const audit = { projectId: parsed.projectId, auditedAt: new Date().toISOString(), dataTypes: parsed.dataTypes, thirdPartyServices: parsed.thirdPartyServices, storesPersonalData: parsed.storesPersonalData, collectsAnalytics: parsed.collectsAnalytics, privacyFiles, warnings, ok: warnings.length === 0 };
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(audit, null, 2)}\n`);
      return { ok: audit.ok, summary: `Privacy/data audit found ${warnings.length} warning(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: audit, logs: [JSON.stringify(audit, null, 2)], errors: warnings };
    }
  },
  {
    definition: {
      name: "create_compliance_checklist",
      description: "Create a project-local compliance checklist for demo, production, commercial, or data app delivery.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, preset: { type: "string" }, outputPath: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: createComplianceChecklistInputSchema,
    handler: async (input, ctx) => {
      const parsed = createComplianceChecklistInputSchema.parse(input);
      const base = ["Project license is known.", "Third-party assets have source, author, license, and attribution.", "External services and URLs are reviewed.", "Privacy/data handling note exists when data is collected."];
      const extra = parsed.preset === "commercial"
        ? ["Commercial-use rights are confirmed for all assets and dependencies.", "Non-commercial and unknown licenses are removed or replaced."]
        : parsed.preset === "data_app"
          ? ["Dataset provenance, data fields, retention, and privacy limitations are documented.", "PII and analytics handling are explicitly reviewed."]
          : parsed.preset === "production"
            ? ["Compliance report is attached to release notes.", "License and privacy blockers are resolved before publish."]
            : ["Demo-only limitations and attribution gaps are disclosed."];
      const checklist = { projectId: parsed.projectId, preset: parsed.preset, createdAt: new Date().toISOString(), checks: [...base, ...extra].map((text, index) => ({ id: `compliance_${index + 1}`, text, required: true, status: "pending" })) };
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(checklist, null, 2)}\n`);
      return { ok: true, summary: `Created ${parsed.preset} compliance checklist with ${checklist.checks.length} check(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: checklist, logs: [JSON.stringify(checklist, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "export_compliance_report",
      description: "Export a Markdown compliance and license review report with scan, attribution, license, privacy, and checklist sections.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, title: { type: "string" }, scan: { type: "object" }, attribution: { type: "object" }, licenseEvaluation: { type: "object" }, privacyAudit: { type: "object" }, checklist: { type: "object" }, outputPath: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: exportComplianceReportInputSchema,
    handler: async (input, ctx) => {
      const parsed = exportComplianceReportInputSchema.parse(input);
      const markdown = renderReport(parsed.title, { scan: parsed.scan, attribution: parsed.attribution, licenseEvaluation: parsed.licenseEvaluation, privacyAudit: parsed.privacyAudit, checklist: parsed.checklist });
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, markdown);
      return { ok: true, summary: `Exported compliance report to ${file.path}.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { path: file.path, markdown }, logs: [markdown], errors: [] };
    }
  }
];
