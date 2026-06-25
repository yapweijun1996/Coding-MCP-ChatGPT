import { z } from "zod";
import { appendProjectTaskHistory, getProjectManifest, readProjectFile, writeProjectFile } from "../../projects/store.js";
import type { ToolModule } from "../types.js";

type Finding = {
  id: string;
  category: "title" | "description" | "canonical" | "favicon" | "open-graph" | "twitter" | "viewport" | "robots" | "theme" | "share-preview";
  severity: "high" | "medium" | "low";
  path: string;
  message: string;
  evidence?: string;
  recommendation: string;
};

type PageSummary = {
  path: string;
  title?: string;
  description?: string;
  canonical?: string;
  favicon?: string;
  themeColor?: string;
  viewport?: string;
  robots?: string;
  openGraph: Record<string, string>;
  twitter: Record<string, string>;
  sharePreview: {
    title?: string;
    description?: string;
    image?: string;
    url?: string;
    card?: string;
  };
};

const auditSeoSocialMetaInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  paths: z.array(z.string().min(1).max(240)).max(100).optional(),
  siteUrl: z.string().url().optional(),
  outputJsonPath: z.string().min(1).max(240).default("seo/seo-meta-audit.json"),
  outputMarkdownPath: z.string().min(1).max(240).default("seo/seo-meta-audit.md")
});

function compact(value: string | undefined): string | undefined {
  const text = value?.replace(/\s+/g, " ").trim();
  return text || undefined;
}

function decodeEntities(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function extractHead(source: string): string {
  return /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(source)?.[1] ?? source;
}

function attr(tag: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return compact(decodeEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? ""));
}

function titleFrom(head: string): string | undefined {
  return compact(decodeEntities(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? ""));
}

function metaMap(head: string, attribute: "name" | "property"): Record<string, string> {
  const output: Record<string, string> = {};
  for (const match of head.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const key = attr(tag, attribute)?.toLowerCase();
    const content = attr(tag, "content");
    if (key && content) output[key] = content;
  }
  return output;
}

function linkMap(head: string): Array<{ rel: string; href: string }> {
  const links = [];
  for (const match of head.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = attr(tag, "rel")?.toLowerCase();
    const href = attr(tag, "href");
    if (rel && href) links.push({ rel, href });
  }
  return links;
}

function isAbsoluteUrl(value: string | undefined): boolean {
  return !!value && /^https?:\/\//i.test(value);
}

function addFinding(findings: Finding[], finding: Finding): void {
  findings.push(finding);
}

function auditPage(path: string, source: string, siteUrl?: string): { summary: PageSummary; findings: Finding[] } {
  const head = extractHead(source);
  const names = metaMap(head, "name");
  const properties = metaMap(head, "property");
  const links = linkMap(head);
  const title = titleFrom(head);
  const description = names.description;
  const canonical = links.find((link) => link.rel.split(/\s+/).includes("canonical"))?.href;
  const favicon = links.find((link) => /\b(?:icon|shortcut icon|apple-touch-icon)\b/.test(link.rel))?.href;
  const themeColor = names["theme-color"];
  const viewport = names.viewport;
  const robots = names.robots;
  const openGraph = Object.fromEntries(Object.entries(properties).filter(([key]) => key.startsWith("og:")));
  const twitter = Object.fromEntries(Object.entries(names).filter(([key]) => key.startsWith("twitter:")));
  const sharePreview = {
    title: openGraph["og:title"] ?? twitter["twitter:title"] ?? title,
    description: openGraph["og:description"] ?? twitter["twitter:description"] ?? description,
    image: openGraph["og:image"] ?? twitter["twitter:image"],
    url: openGraph["og:url"] ?? canonical,
    card: twitter["twitter:card"]
  };
  const summary: PageSummary = { path, title, description, canonical, favicon, themeColor, viewport, robots, openGraph, twitter, sharePreview };
  const findings: Finding[] = [];

  if (!title) addFinding(findings, { id: "missing-title", category: "title", severity: "high", path, message: "Page is missing a <title>.", recommendation: "Add a concise, descriptive page title." });
  else if (title.length < 12 || title.length > 70) addFinding(findings, { id: "title-length-risk", category: "title", severity: "low", path, evidence: title, message: "Page title length may not be ideal for search results.", recommendation: "Keep titles descriptive and roughly 12-70 characters." });

  if (!description) addFinding(findings, { id: "missing-description", category: "description", severity: "medium", path, message: "Page is missing meta description.", recommendation: "Add a useful <meta name=\"description\"> summary for search and shares." });
  else if (description.length < 50 || description.length > 170) addFinding(findings, { id: "description-length-risk", category: "description", severity: "low", path, evidence: description, message: "Meta description length may be weak for search snippets.", recommendation: "Use a natural description around 50-170 characters." });

  if (!canonical) addFinding(findings, { id: "missing-canonical-url", category: "canonical", severity: "medium", path, message: "Page is missing a canonical URL.", recommendation: "Add <link rel=\"canonical\"> with the preferred published URL." });
  else if (!isAbsoluteUrl(canonical)) addFinding(findings, { id: "canonical-not-absolute", category: "canonical", severity: "low", path, evidence: canonical, message: "Canonical URL is not absolute.", recommendation: "Use an absolute https URL for canonical metadata." });
  else if (siteUrl && !canonical.startsWith(siteUrl.replace(/\/$/, ""))) addFinding(findings, { id: "canonical-site-mismatch", category: "canonical", severity: "low", path, evidence: canonical, message: "Canonical URL does not match the expected siteUrl.", recommendation: "Confirm the canonical domain matches the published demo domain." });

  if (!favicon) addFinding(findings, { id: "missing-favicon", category: "favicon", severity: "low", path, message: "Page is missing a favicon link.", recommendation: "Add a favicon or apple-touch-icon link for browser tabs and bookmarks." });
  if (!viewport) addFinding(findings, { id: "missing-viewport", category: "viewport", severity: "medium", path, message: "Page is missing responsive viewport metadata.", recommendation: "Add <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">." });
  if (robots && /\b(noindex|none)\b/i.test(robots)) addFinding(findings, { id: "robots-blocks-indexing", category: "robots", severity: "high", path, evidence: robots, message: "Robots metadata may block indexing.", recommendation: "Remove noindex/none for public published demos unless intentional." });
  if (!themeColor) addFinding(findings, { id: "missing-theme-color", category: "theme", severity: "low", path, message: "Page is missing theme-color metadata.", recommendation: "Add <meta name=\"theme-color\"> to improve mobile browser chrome and share polish." });

  for (const key of ["og:title", "og:description", "og:image", "og:url", "og:type"]) {
    if (!openGraph[key]) addFinding(findings, { id: `missing-${key.replace(":", "-")}`, category: "open-graph", severity: key === "og:image" ? "medium" : "low", path, message: `Open Graph metadata is missing ${key}.`, recommendation: "Add complete og:title, og:description, og:image, og:url, and og:type tags." });
  }
  if (openGraph["og:image"] && !isAbsoluteUrl(openGraph["og:image"])) addFinding(findings, { id: "og-image-not-absolute", category: "open-graph", severity: "low", path, evidence: openGraph["og:image"], message: "og:image is not an absolute URL.", recommendation: "Use an absolute https URL so social crawlers can fetch the image." });

  for (const key of ["twitter:card", "twitter:title", "twitter:description", "twitter:image"]) {
    if (!twitter[key]) addFinding(findings, { id: `missing-${key.replace(":", "-")}`, category: "twitter", severity: key === "twitter:card" || key === "twitter:image" ? "medium" : "low", path, message: `Twitter card metadata is missing ${key}.`, recommendation: "Add twitter:card, twitter:title, twitter:description, and twitter:image tags." });
  }
  if (twitter["twitter:card"] && !["summary", "summary_large_image", "app", "player"].includes(twitter["twitter:card"])) addFinding(findings, { id: "twitter-card-unknown", category: "twitter", severity: "low", path, evidence: twitter["twitter:card"], message: "Twitter card type is not a common supported value.", recommendation: "Use summary or summary_large_image for most demos." });
  if (twitter["twitter:image"] && !isAbsoluteUrl(twitter["twitter:image"])) addFinding(findings, { id: "twitter-image-not-absolute", category: "twitter", severity: "low", path, evidence: twitter["twitter:image"], message: "twitter:image is not an absolute URL.", recommendation: "Use an absolute https URL so social crawlers can fetch the image." });

  if (!sharePreview.title || !sharePreview.description || !sharePreview.image || !sharePreview.url || !sharePreview.card) {
    addFinding(findings, { id: "incomplete-share-preview", category: "share-preview", severity: "medium", path, message: "Share preview summary is incomplete.", recommendation: "Ensure title, description, image, URL, and card type are all available for social previews." });
  }

  return { summary, findings };
}

function readinessScore(findings: Finding[]): number {
  const penalty = findings.reduce((total, finding) => total + (finding.severity === "high" ? 18 : finding.severity === "medium" ? 9 : 3), 0);
  return Math.max(0, Math.min(100, 100 - penalty));
}

function markdown(report: { projectId: string; pageCount: number; score: number; pages: PageSummary[]; findings: Finding[] }) {
  const rows = report.findings.map((finding) => `| ${finding.severity} | ${finding.category} | ${finding.id} | ${finding.path} | ${finding.message.replaceAll("|", "\\|")} | ${finding.evidence?.replaceAll("|", "\\|") ?? ""} |`).join("\n");
  const previews = report.pages.map((page) => `### ${page.path}

- Title: ${page.sharePreview.title ?? "missing"}
- Description: ${page.sharePreview.description ?? "missing"}
- Image: ${page.sharePreview.image ?? "missing"}
- URL: ${page.sharePreview.url ?? "missing"}
- Card: ${page.sharePreview.card ?? "missing"}`).join("\n\n");
  return `# SEO and Social Meta Audit

- Project: \`${report.projectId}\`
- Pages: ${report.pageCount}
- Readiness score: ${report.score}/100
- Findings: ${report.findings.length}

## Share Preview Summary

${previews || "No HTML pages found."}

## Findings

| Severity | Category | ID | Path | Finding | Evidence |
| --- | --- | --- | --- | --- | --- |
${rows || "| low | share-preview | none | project | No SEO/social meta findings. | - |"}
`;
}

export const seoMetaAuditTools: ToolModule[] = [
  {
    definition: {
      name: "audit_seo_social_meta",
      description: "Audit static HTML pages for SEO and social sharing metadata including title, description, canonical URL, favicon, Open Graph, Twitter cards, viewport, robots, theme color, and share-preview readiness.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          paths: { type: "array", items: { type: "string" } },
          siteUrl: { type: "string" },
          outputJsonPath: { type: "string" },
          outputMarkdownPath: { type: "string" }
        },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: auditSeoSocialMetaInputSchema,
    handler: async (input, ctx) => {
      const parsed = auditSeoSocialMetaInputSchema.parse(input);
      const manifest = await getProjectManifest(ctx.projectRoot, parsed.projectId);
      const targetPaths = (parsed.paths?.length ? parsed.paths : manifest.files.map((file) => file.path))
        .filter((filePath) => /\.html?$/i.test(filePath));
      const pages: PageSummary[] = [];
      const findings: Finding[] = [];
      for (const filePath of targetPaths) {
        const source = await readProjectFile(ctx.projectRoot, parsed.projectId, filePath);
        const page = auditPage(filePath, source, parsed.siteUrl);
        pages.push(page.summary);
        findings.push(...page.findings);
      }
      if (!targetPaths.length) findings.push({ id: "no-html-pages", category: "share-preview", severity: "high", path: "project", message: "No HTML pages were found to audit.", recommendation: "Provide paths to published HTML entry files or add an HTML entry page." });
      const report = { projectId: parsed.projectId, pageCount: pages.length, score: readinessScore(findings), pages, findings };
      const jsonFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputJsonPath, `${JSON.stringify(report, null, 2)}\n`);
      const markdownFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputMarkdownPath, markdown(report));
      await appendProjectTaskHistory(ctx.projectRoot, parsed.projectId, { toolName: "audit_seo_social_meta", ok: findings.every((finding) => finding.severity !== "high"), summary: `SEO/social meta audit found ${findings.length} finding(s).`, details: { outputJsonPath: jsonFile.path, outputMarkdownPath: markdownFile.path, score: report.score, pageCount: report.pageCount } });
      return { ok: true, summary: `SEO/social meta audit found ${findings.length} finding(s).`, jobId: parsed.projectId, artifacts: [jsonFile.path, markdownFile.path], structuredContent: report, logs: [JSON.stringify(report, null, 2)], errors: [] };
    }
  }
];
