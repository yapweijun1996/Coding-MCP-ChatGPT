import { z } from "zod";
import { appendProjectTaskHistory, getProjectManifest, readProjectFile, writeProjectFile } from "../../projects/store.js";
import type { ToolModule } from "../types.js";

type Finding = {
  id: string;
  category: "dependency" | "license" | "cdn" | "mixed-content" | "secret" | "browser-api" | "headers";
  severity: "critical" | "high" | "medium" | "low";
  path: string;
  message: string;
  evidence?: string;
  recommendation: string;
};

const scanProjectSecurityInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  paths: z.array(z.string().min(1).max(240)).max(200).optional(),
  includeLowSeverity: z.boolean().default(true),
  outputJsonPath: z.string().min(1).max(240).default("security/security-scan.json"),
  outputMarkdownPath: z.string().min(1).max(240).default("security/security-scan.md")
});

const knownRiskyDependencies: Record<string, Array<{ range: string; severity: Finding["severity"]; message: string }>> = {
  lodash: [{ range: "<4.17.21", severity: "high", message: "Known lodash versions before 4.17.21 have prototype pollution and command injection advisories." }],
  minimist: [{ range: "<1.2.6", severity: "high", message: "Known minimist versions before 1.2.6 have prototype pollution advisories." }],
  axios: [{ range: "<1.6.0", severity: "medium", message: "Older axios versions have had SSRF or credential leakage advisories; verify the exact installed version." }],
  jquery: [{ range: "<3.5.0", severity: "medium", message: "Older jQuery versions have had XSS-related advisories." }]
};

const riskyLicenses = [/gpl/i, /agpl/i, /lgpl/i, /unknown/i, /unlicensed/i];
const secretPatterns = [
  { id: "openai-key", pattern: /sk-[A-Za-z0-9_-]{20,}/g, label: "OpenAI-style API key" },
  { id: "aws-access-key", pattern: /AKIA[0-9A-Z]{16}/g, label: "AWS access key id" },
  { id: "generic-secret", pattern: /(api[_-]?key|secret|token|password)\s*[:=]\s*["'][^"']{12,}["']/gi, label: "hard-coded secret-like value" }
];
const riskyApiPatterns = [
  { id: "eval", pattern: /\beval\s*\(/g, severity: "high" as const, message: "eval() executes dynamic code." },
  { id: "inner-html", pattern: /\.innerHTML\s*=/g, severity: "medium" as const, message: "innerHTML assignment can introduce XSS if data is not sanitized." },
  { id: "document-write", pattern: /document\.write\s*\(/g, severity: "medium" as const, message: "document.write can inject unsafe markup and block rendering." },
  { id: "geolocation", pattern: /navigator\.geolocation/g, severity: "low" as const, message: "Geolocation requires clear user consent and privacy copy." },
  { id: "clipboard", pattern: /navigator\.clipboard/g, severity: "low" as const, message: "Clipboard access should be user-initiated and explained." },
  { id: "local-storage-sensitive", pattern: /localStorage\.(setItem|getItem)\s*\([^)]*(token|password|secret|key)/gi, severity: "medium" as const, message: "Sensitive values should not be stored in localStorage." }
];

function normalizeVersion(version: string): number[] {
  return version.replace(/^[^\d]*/, "").split(".").slice(0, 3).map((part) => Number.parseInt(part.replace(/\D.*/, ""), 10) || 0);
}

function versionLessThan(version: string, target: string): boolean {
  const left = normalizeVersion(version);
  const right = normalizeVersion(target);
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] ?? 0) < (right[index] ?? 0)) return true;
    if ((left[index] ?? 0) > (right[index] ?? 0)) return false;
  }
  return false;
}

function matchesRange(version: string, range: string): boolean {
  const lessThan = /^<(.+)$/.exec(range);
  return lessThan ? versionLessThan(version, lessThan[1]!) : false;
}

function snippet(source: string, index: number): string {
  return source.slice(Math.max(0, index - 40), Math.min(source.length, index + 100)).replace(/\s+/g, " ").trim();
}

function scanPackageJson(path: string, source: string): Finding[] {
  const findings: Finding[] = [];
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; license?: string; scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(source);
  } catch {
    return findings;
  }
  const dependencies = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  for (const [name, version] of Object.entries(dependencies)) {
    for (const risk of knownRiskyDependencies[name] ?? []) {
      if (matchesRange(version, risk.range)) {
        findings.push({ id: `dependency-${name}`, category: "dependency", severity: risk.severity, path, evidence: `${name}@${version}`, message: risk.message, recommendation: `Upgrade ${name} to a patched version or remove it if unused.` });
      }
    }
    if (/^(http:|https:|git\+|github:|file:)/.test(version)) {
      findings.push({ id: `dependency-non-registry-${name}`, category: "dependency", severity: "medium", path, evidence: `${name}: ${version}`, message: "Dependency is pinned to a URL, git source, or local file instead of a registry version.", recommendation: "Use a reviewed registry version and lockfile when possible." });
    }
  }
  if (pkg.license && riskyLicenses.some((pattern) => pattern.test(pkg.license!))) {
    findings.push({ id: "license-risk", category: "license", severity: /agpl/i.test(pkg.license) ? "high" : "medium", path, evidence: pkg.license, message: "Project license may impose copyleft, network-use, or unclear commercial-use obligations.", recommendation: "Review license obligations before public or commercial delivery." });
  }
  for (const [scriptName, script] of Object.entries(pkg.scripts ?? {})) {
    if (/curl\s+|wget\s+|chmod\s+777|rm\s+-rf\s+\//.test(script)) {
      findings.push({ id: `script-risk-${scriptName}`, category: "dependency", severity: "high", path, evidence: `${scriptName}: ${script}`, message: "Package script contains a risky shell pattern.", recommendation: "Review script behavior before running install/build commands." });
    }
  }
  return findings;
}

function scanSource(path: string, source: string): Finding[] {
  const findings: Finding[] = [];
  const externalUrls = [...source.matchAll(/https?:\/\/[^"')\s<>]+/gi)];
  for (const match of externalUrls) {
    const url = match[0];
    if (url.startsWith("http://")) {
      findings.push({ id: "mixed-content-http", category: "mixed-content", severity: "high", path, evidence: url, message: "HTTP URL can cause mixed-content blocking or insecure transport.", recommendation: "Use HTTPS or bundle the asset locally." });
    }
    if (/(unpkg\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|esm\.sh|skypack\.dev)/i.test(url)) {
      const pinned = /@[0-9]+\.[0-9]+\.[0-9]+/.test(url);
      findings.push({ id: pinned ? "cdn-reviewed" : "cdn-unpinned", category: "cdn", severity: pinned ? "low" : "medium", path, evidence: url, message: pinned ? "External CDN dependency is version-pinned but still third-party hosted." : "External CDN dependency is not pinned to an exact version.", recommendation: pinned ? "Consider vendoring for offline/reproducible demos." : "Pin an exact version, add SRI where possible, or vendor the asset." });
    }
  }
  for (const secret of secretPatterns) {
    for (const match of source.matchAll(secret.pattern)) {
      findings.push({ id: `secret-${secret.id}`, category: "secret", severity: "critical", path, evidence: snippet(source, match.index ?? 0), message: `Possible ${secret.label} found in project source.`, recommendation: "Remove the secret, rotate it if real, and use environment/config injection instead." });
    }
  }
  for (const api of riskyApiPatterns) {
    for (const match of source.matchAll(api.pattern)) {
      findings.push({ id: `browser-api-${api.id}`, category: "browser-api", severity: api.severity, path, evidence: snippet(source, match.index ?? 0), message: api.message, recommendation: "Review usage and add sanitization, consent, or safer browser APIs as appropriate." });
    }
  }
  if (/<script\b(?![^>]*\bintegrity=)[^>]*\bsrc=["']https?:\/\//i.test(source)) {
    findings.push({ id: "missing-sri", category: "cdn", severity: "medium", path, message: "External script tag lacks Subresource Integrity.", recommendation: "Add integrity/crossorigin attributes or bundle the dependency locally." });
  }
  if (/<iframe\b(?![^>]*\bsandbox=)/i.test(source)) {
    findings.push({ id: "iframe-no-sandbox", category: "headers", severity: "medium", path, message: "iframe lacks sandbox restrictions.", recommendation: "Add a scoped sandbox attribute or avoid embedding untrusted pages." });
  }
  return findings;
}

function markdown(report: { projectId: string; findingCount: number; riskCounts: Record<string, number>; findings: Finding[] }): string {
  const rows = report.findings.map((finding) => `| ${finding.severity} | ${finding.category} | ${finding.path} | ${finding.message.replaceAll("|", "\\|")} | ${finding.recommendation.replaceAll("|", "\\|")} |`).join("\n");
  return `# Project Security Scan

- Project: \`${report.projectId}\`
- Findings: ${report.findingCount}
- Risk counts: ${Object.entries(report.riskCounts).map(([key, value]) => `${key}: ${value}`).join(", ") || "none"}

| Severity | Category | Path | Finding | Recommendation |
| --- | --- | --- | --- | --- |
${rows || "| low | headers | project | No findings | Keep dependencies pinned and rerun before publish. |"}
`;
}

export const securityScanTools: ToolModule[] = [
  {
    definition: {
      name: "scan_project_security",
      description: "Scan project files for dependency, license, CDN, mixed-content, secret, insecure browser API, and embed risks; writes JSON and Markdown reports.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          paths: { type: "array", items: { type: "string" } },
          includeLowSeverity: { type: "boolean" },
          outputJsonPath: { type: "string" },
          outputMarkdownPath: { type: "string" }
        },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: scanProjectSecurityInputSchema,
    handler: async (input, ctx) => {
      const parsed = scanProjectSecurityInputSchema.parse(input);
      const manifest = await getProjectManifest(ctx.projectRoot, parsed.projectId);
      const targetPaths = (parsed.paths?.length ? parsed.paths : manifest.files.map((file) => file.path))
        .filter((filePath) => /\.(html?|css|js|mjs|json|webmanifest|txt|md)$/i.test(filePath));
      const findings: Finding[] = [];
      for (const filePath of targetPaths) {
        const source = await readProjectFile(ctx.projectRoot, parsed.projectId, filePath, 1024 * 1024).catch(() => "");
        if (!source) continue;
        if (filePath.endsWith("package.json")) findings.push(...scanPackageJson(filePath, source));
        findings.push(...scanSource(filePath, source));
      }
      const filtered = parsed.includeLowSeverity ? findings : findings.filter((finding) => finding.severity !== "low");
      const riskCounts = filtered.reduce<Record<string, number>>((counts, finding) => {
        counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
        return counts;
      }, {});
      const report = {
        projectId: parsed.projectId,
        scannedFiles: targetPaths,
        findingCount: filtered.length,
        riskCounts,
        findings: filtered,
        nextSteps: ["Review critical/high findings before publish.", "Vendor or pin CDN dependencies.", "Rotate any real secrets found in source.", "Run npm audit in the bound workspace when package-lock.json is available."]
      };
      const jsonFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputJsonPath, `${JSON.stringify(report, null, 2)}\n`);
      const markdownFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputMarkdownPath, markdown(report));
      await appendProjectTaskHistory(ctx.projectRoot, parsed.projectId, { toolName: "scan_project_security", ok: filtered.every((finding) => !["critical", "high"].includes(finding.severity)), summary: `Security scan found ${filtered.length} finding(s).`, details: { riskCounts, outputJsonPath: jsonFile.path, outputMarkdownPath: markdownFile.path } });
      return { ok: filtered.every((finding) => finding.severity !== "critical"), summary: `Security scan found ${filtered.length} finding(s).`, jobId: parsed.projectId, artifacts: [jsonFile.path, markdownFile.path], structuredContent: report, logs: [JSON.stringify(report, null, 2)], errors: filtered.filter((finding) => finding.severity === "critical").map((finding) => finding.message) };
    }
  }
];
