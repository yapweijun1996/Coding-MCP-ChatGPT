import { z } from "zod";
import {
  createProject,
  readProjectFile,
  validateProject,
  writeProjectFile
} from "../../projects/store.js";
import type { ToolContext, ToolModule } from "../types.js";

const templateCatalogPath = "templates/project-template-catalog.json";

const categoryEnum = z.enum(["admin-panel", "pwa-app", "dashboard", "game", "landing-page", "data-tool", "docs-site"]);
const complexityEnum = z.enum(["starter", "standard", "advanced"]);

const registerProjectTemplateSchema = z.object({
  projectId: z.string().min(8).max(80),
  template: z.object({
    id: z.string().min(3).max(80).regex(/^[a-zA-Z0-9_-]+$/),
    title: z.string().min(3).max(160),
    category: categoryEnum,
    summary: z.string().min(3).max(500),
    tags: z.array(z.string().min(1).max(60)).max(30).default([]),
    features: z.array(z.string().min(1).max(160)).min(1).max(30),
    recommendedFor: z.array(z.string().min(1).max(160)).max(20).default([]),
    files: z.array(z.string().min(1).max(240)).max(30).default(["index.html", "styles.css", "app.js"]),
    complexity: complexityEnum.default("starter")
  })
});

const listProjectTemplatesSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  category: categoryEnum.optional(),
  query: z.string().min(1).max(160).optional(),
  includeCustom: z.boolean().default(true)
});

const recommendProjectTemplatesSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  useCase: z.string().min(3).max(500),
  category: categoryEnum.optional(),
  desiredFeatures: z.array(z.string().min(1).max(120)).max(20).default([]),
  maxResults: z.number().int().min(1).max(20).default(5)
});

const createProjectFromTemplateSchema = z.object({
  sourceProjectId: z.string().min(8).max(80).optional(),
  templateId: z.string().min(3).max(80),
  title: z.string().min(3).max(160),
  summary: z.string().max(500).optional(),
  brandName: z.string().min(1).max(120).optional(),
  primaryAction: z.string().min(1).max(120).optional(),
  validate: z.boolean().default(true)
});

const exportProjectTemplateCatalogSchema = z.object({
  projectId: z.string().min(8).max(80),
  outputPath: z.string().min(1).max(240).default("templates/project-template-marketplace.md")
});

interface ProjectTemplate {
  id: string;
  title: string;
  category: z.infer<typeof categoryEnum>;
  summary: string;
  tags: string[];
  features: string[];
  recommendedFor: string[];
  files: string[];
  complexity: z.infer<typeof complexityEnum>;
  source: "builtin" | "custom";
}

interface TemplateCatalog {
  version: 1;
  templates: ProjectTemplate[];
}

const builtinTemplates: ProjectTemplate[] = [
  {
    id: "admin-ops-panel",
    title: "Admin Operations Panel",
    category: "admin-panel",
    summary: "Dense CRUD-style operations shell with sidebar navigation, KPI strip, filters, table rows, and action drawer.",
    tags: ["admin", "crud", "operations", "table"],
    features: ["Sidebar navigation", "KPI strip", "Filter toolbar", "Data table", "Action drawer", "Audit notes"],
    recommendedFor: ["ERP modules", "CRM operations", "inventory tools", "internal admin"],
    files: ["index.html", "styles.css", "app.js", "README.md"],
    complexity: "standard",
    source: "builtin"
  },
  {
    id: "offline-pwa-shell",
    title: "Offline PWA Shell",
    category: "pwa-app",
    summary: "Mobile-first app shell with install checklist, offline state, sync queue, settings, and persistent task cards.",
    tags: ["pwa", "offline", "mobile", "sync"],
    features: ["App shell", "Offline banner", "Sync queue", "Settings panel", "Task cards", "Install readiness checklist"],
    recommendedFor: ["field apps", "mobile utilities", "offline-first demos"],
    files: ["index.html", "styles.css", "app.js", "README.md"],
    complexity: "standard",
    source: "builtin"
  },
  {
    id: "metric-dashboard",
    title: "Metric Dashboard",
    category: "dashboard",
    summary: "Decision dashboard with KPI cards, trend panel, segment comparison, ranked drivers, and alert feed.",
    tags: ["dashboard", "metrics", "kpi", "analytics"],
    features: ["KPI cards", "Trend panel", "Segment comparison", "Driver ranking", "Alert feed"],
    recommendedFor: ["SaaS metrics", "business reporting", "executive scorecards"],
    files: ["index.html", "styles.css", "app.js", "README.md"],
    complexity: "starter",
    source: "builtin"
  },
  {
    id: "web-game-starter",
    title: "Web Game Starter",
    category: "game",
    summary: "Canvas game starter with HUD, controls, level panel, event log, and deterministic state update loop.",
    tags: ["game", "canvas", "hud", "levels"],
    features: ["Canvas scene", "HUD", "Keyboard controls", "Level list", "Event log", "Game loop"],
    recommendedFor: ["arcade prototypes", "educational games", "interactive demos"],
    files: ["index.html", "styles.css", "app.js", "README.md"],
    complexity: "starter",
    source: "builtin"
  },
  {
    id: "product-landing-page",
    title: "Product Landing Page",
    category: "landing-page",
    summary: "Conversion-focused landing page with first-viewport product signal, proof points, pricing, FAQ, and CTA band.",
    tags: ["landing", "marketing", "pricing", "conversion"],
    features: ["Hero section", "Proof points", "Feature grid", "Pricing summary", "FAQ", "CTA band"],
    recommendedFor: ["SaaS launches", "product pages", "campaign pages"],
    files: ["index.html", "styles.css", "app.js", "README.md"],
    complexity: "starter",
    source: "builtin"
  },
  {
    id: "data-tool-workbench",
    title: "Data Tool Workbench",
    category: "data-tool",
    summary: "Analytical workbench with upload placeholder, profiling summary, chart area, transformation steps, and export queue.",
    tags: ["data", "analysis", "charts", "workflow"],
    features: ["Dataset panel", "Quality summary", "Chart area", "Transform steps", "Export queue"],
    recommendedFor: ["CSV tools", "BI utilities", "analysis demos"],
    files: ["index.html", "styles.css", "app.js", "README.md"],
    complexity: "standard",
    source: "builtin"
  },
  {
    id: "documentation-site",
    title: "Documentation Site",
    category: "docs-site",
    summary: "Docs site with left navigation, search placeholder, article layout, callouts, changelog, and API reference blocks.",
    tags: ["docs", "documentation", "api", "knowledge-base"],
    features: ["Docs navigation", "Search placeholder", "Article layout", "Callouts", "Changelog", "API reference"],
    recommendedFor: ["developer docs", "product manuals", "knowledge bases"],
    files: ["index.html", "styles.css", "app.js", "README.md"],
    complexity: "starter",
    source: "builtin"
  }
];

function emptyCatalog(): TemplateCatalog {
  return { version: 1, templates: [] };
}

async function readCustomCatalog(ctx: ToolContext, projectId?: string): Promise<TemplateCatalog> {
  if (!projectId) return emptyCatalog();
  try {
    const raw = await readProjectFile(ctx.projectRoot, projectId, templateCatalogPath);
    const parsed = JSON.parse(raw) as TemplateCatalog;
    return { version: 1, templates: Array.isArray(parsed.templates) ? parsed.templates : [] };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") return emptyCatalog();
    throw error;
  }
}

async function writeCustomCatalog(ctx: ToolContext, projectId: string, catalog: TemplateCatalog) {
  return writeProjectFile(ctx.projectRoot, projectId, templateCatalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
}

async function allTemplates(ctx: ToolContext, projectId?: string, includeCustom = true): Promise<ProjectTemplate[]> {
  const custom = includeCustom ? (await readCustomCatalog(ctx, projectId)).templates : [];
  return [...builtinTemplates, ...custom.map((template) => ({ ...template, source: "custom" as const }))];
}

function matchesQuery(template: ProjectTemplate, query?: string): boolean {
  if (!query) return true;
  const haystack = [template.id, template.title, template.category, template.summary, ...template.tags, ...template.features, ...template.recommendedFor].join(" ").toLowerCase();
  return query.toLowerCase().split(/\s+/).every((token) => haystack.includes(token));
}

function scoreTemplate(template: ProjectTemplate, useCase: string, desiredFeatures: string[]): number {
  const text = [template.id, template.title, template.category, template.summary, ...template.tags, ...template.features, ...template.recommendedFor].join(" ").toLowerCase();
  const useCaseTokens = useCase.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const useCaseScore = useCaseTokens.reduce((score, token) => score + (text.includes(token) ? 2 : 0), 0);
  const featureScore = desiredFeatures.reduce((score, feature) => score + (text.includes(feature.toLowerCase()) ? 5 : 0), 0);
  const complexityScore = template.complexity === "starter" ? 1 : 0;
  return useCaseScore + featureScore + complexityScore;
}

function templateCard(template: ProjectTemplate) {
  return `${template.id} (${template.category}/${template.complexity}/${template.source}): ${template.title}`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function landingShellFor(template: ProjectTemplate, title: string, brandName: string, primaryAction: string) {
  const features = template.features.slice(0, 6);
  const proof = [
    ["48h", "from brief to launch-ready demo"],
    ["3x", "clearer first-viewport product signal"],
    ["100%", "static files ready for review"]
  ];
  const featureCards = features.map((feature) => `<article class="feature-card"><h3>${escapeHtml(feature)}</h3><p>${escapeHtml(template.summary)}</p></article>`).join("\n");
  const proofCards = proof.map(([value, label]) => `<div class="proof-card"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`).join("\n");
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body data-template="${escapeHtml(template.id)}" data-page-intent="landing-page">
  <header class="site-header">
    <a class="brand" href="#hero" aria-label="${escapeHtml(brandName)} home">${escapeHtml(brandName)}</a>
    <nav aria-label="Primary navigation">
      <a href="#proof">Proof</a>
      <a href="#features">Features</a>
      <a href="#pricing">Pricing</a>
      <a href="#faq">FAQ</a>
    </nav>
    <a class="nav-cta" href="#pricing">${escapeHtml(primaryAction)}</a>
  </header>
  <main>
    <section class="hero" id="hero" aria-labelledby="hero-title">
      <div class="hero-copy">
        <p class="eyebrow">Launch-ready product page</p>
        <h1 id="hero-title">${escapeHtml(title)}</h1>
        <p class="hero-lede">${escapeHtml(template.summary)}</p>
        <div class="hero-actions" aria-label="Hero calls to action">
          <a class="cta primary" href="#pricing">${escapeHtml(primaryAction)}</a>
          <a class="cta secondary" href="#features">See what is included</a>
        </div>
      </div>
      <aside class="hero-panel" aria-label="Product preview">
        <div class="panel-topline"><span></span><span></span><span></span></div>
        <strong>${escapeHtml(brandName)} growth page</strong>
        <p>Positioning, proof, features, pricing, and conversion copy in one focused first-pass site.</p>
        <div class="panel-meter"><span style="width:82%"></span></div>
      </aside>
    </section>
    <section class="proof" id="proof" aria-label="Proof points">${proofCards}</section>
    <section class="features" id="features" aria-labelledby="features-title">
      <p class="eyebrow">What visitors understand fast</p>
      <h2 id="features-title">A focused page structure for conversion</h2>
      <div class="feature-grid">${featureCards}</div>
    </section>
    <section class="pricing" id="pricing" aria-labelledby="pricing-title">
      <div>
        <p class="eyebrow">Simple next step</p>
        <h2 id="pricing-title">Start with a credible launch page</h2>
        <p>Use this starter as a polished base, then replace the copy, screenshots, metrics, and pricing details with production content.</p>
      </div>
      <a class="cta primary" href="mailto:hello@example.com">${escapeHtml(primaryAction)}</a>
    </section>
    <section class="faq" id="faq" aria-labelledby="faq-title">
      <h2 id="faq-title">FAQ</h2>
      <details open><summary>Is this ready to customize?</summary><p>Yes. The structure is intentionally complete enough for a first browser review.</p></details>
      <details><summary>What should be replaced first?</summary><p>Update the value proposition, proof metrics, screenshots, and CTA destination.</p></details>
    </section>
    <section class="final-cta" aria-label="Final call to action">
      <h2>Turn the first impression into a clear action.</h2>
      <a class="cta primary" href="#pricing">${escapeHtml(primaryAction)}</a>
    </section>
  </main>
  <script src="app.js"></script>
</body>
</html>
`;
  const css = `:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#10201d;background:#f6f3ec;--ink:#10201d;--muted:#5d6c65;--accent:#0f766e;--accent-dark:#0b4f49;--card:#fffaf0;--line:#dfd6c8}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% 0%,#d6f2ec 0,#f6f3ec 34%,#f9f7f1 100%);color:var(--ink)}.site-header{position:sticky;top:0;z-index:10;display:flex;align-items:center;justify-content:space-between;gap:24px;padding:18px clamp(20px,5vw,72px);background:rgba(246,243,236,.88);backdrop-filter:blur(14px);border-bottom:1px solid rgba(16,32,29,.08)}.brand{font-weight:900;color:var(--ink);text-decoration:none;letter-spacing:-.02em}.site-header nav{display:flex;gap:18px;flex-wrap:wrap}.site-header a{color:var(--ink);text-decoration:none}.nav-cta,.cta{display:inline-flex;align-items:center;justify-content:center;border-radius:999px;font-weight:800;text-decoration:none}.nav-cta{background:var(--ink);color:white!important;padding:10px 16px}.hero{min-height:88vh;display:grid;grid-template-columns:minmax(0,1.1fr) minmax(320px,.9fr);gap:clamp(28px,6vw,88px);align-items:center;padding:clamp(56px,8vw,104px) clamp(20px,5vw,72px)}.eyebrow{margin:0 0 14px;text-transform:uppercase;letter-spacing:.16em;font-size:12px;font-weight:900;color:var(--accent-dark)}h1,h2,p{margin-top:0}h1{font-size:clamp(44px,7vw,86px);line-height:.96;letter-spacing:-.06em;margin-bottom:24px}h2{font-size:clamp(30px,4vw,54px);line-height:1;letter-spacing:-.04em}.hero-lede,.pricing p,.feature-card p,.hero-panel p,.faq p{color:var(--muted);font-size:18px;line-height:1.6}.hero-actions{display:flex;gap:14px;flex-wrap:wrap;margin-top:30px}.cta{padding:14px 20px}.cta.primary{background:var(--accent);color:white;box-shadow:0 16px 34px rgba(15,118,110,.24)}.cta.secondary{border:1px solid var(--line);color:var(--ink);background:rgba(255,255,255,.7)}.hero-panel{border:1px solid rgba(16,32,29,.1);border-radius:32px;background:linear-gradient(145deg,#fffaf0,#dff8f2);box-shadow:0 30px 90px rgba(16,32,29,.18);padding:28px;min-height:360px;display:grid;align-content:center;gap:18px}.panel-topline{display:flex;gap:8px}.panel-topline span{width:12px;height:12px;border-radius:50%;background:var(--accent)}.hero-panel strong{font-size:32px;line-height:1}.panel-meter{height:12px;border-radius:999px;background:white;overflow:hidden}.panel-meter span{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--accent),#f5b971)}.proof,.features,.pricing,.faq,.final-cta{padding:clamp(42px,7vw,88px) clamp(20px,5vw,72px)}.proof{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.proof-card,.feature-card,.pricing,.faq details{background:rgba(255,250,240,.82);border:1px solid var(--line);border-radius:24px;padding:24px}.proof-card strong{display:block;font-size:40px}.proof-card span{color:var(--muted)}.features{background:#10201d;color:white}.features .eyebrow,.features h2{color:white}.feature-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:16px;margin-top:28px}.feature-card{background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.16)}.feature-card p{color:#cbd8d3}.pricing{display:flex;align-items:center;justify-content:space-between;gap:24px}.faq{display:grid;gap:16px}.faq details{max-width:900px}.faq summary{cursor:pointer;font-weight:800}.final-cta{text-align:center;background:var(--accent-dark);color:white}.final-cta h2{max-width:760px;margin:0 auto 22px}@media(max-width:820px){.site-header{position:static;align-items:flex-start;flex-direction:column}.hero{grid-template-columns:1fr;min-height:auto}.proof{grid-template-columns:1fr}.pricing{align-items:flex-start;flex-direction:column}h1{font-size:42px}}`;
  const js = `document.querySelectorAll(".cta").forEach((link)=>link.addEventListener("click",()=>document.documentElement.dataset.lastCta=link.textContent?.trim()||"cta"));\n`;
  const readme = `# ${title}

Template: ${template.title} (${template.id})

## Included

${template.features.map((feature) => `- ${feature}`).join("\n")}

## Next Steps

- Replace placeholder copy with project-specific content.
- Add product screenshots, real proof metrics, and a live CTA destination.
- Run validation, browser QA, and screenshot review before publishing.
`;
  return [
    { path: "index.html", content: html },
    { path: "styles.css", content: css },
    { path: "app.js", content: js },
    { path: "README.md", content: readme }
  ];
}

function shellFor(template: ProjectTemplate, title: string, brandName: string, primaryAction: string) {
  if (template.category === "landing-page") return landingShellFor(template, title, brandName, primaryAction);
  const features = template.features.slice(0, 6);
  const nav = features.slice(0, 5);
  const cards = features.map((feature, index) => `<article class="card"><span>${String(index + 1).padStart(2, "0")}</span><h3>${escapeHtml(feature)}</h3><p>${escapeHtml(template.summary)}</p></article>`).join("\n");
  const tableRows = features.slice(0, 5).map((feature, index) => `<tr><td>${escapeHtml(feature)}</td><td>${index % 2 ? "Ready" : "Planned"}</td><td>${index + 2} checks</td></tr>`).join("\n");
  const isGame = template.category === "game";
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body data-template="${escapeHtml(template.id)}">
  <aside class="sidebar">
    <strong>${escapeHtml(brandName)}</strong>
    <nav>${nav.map((item) => `<a href="#${escapeHtml(item.toLowerCase().replace(/[^a-z0-9]+/g, "-"))}">${escapeHtml(item)}</a>`).join("")}</nav>
  </aside>
  <main>
    <section class="hero">
      <p>${escapeHtml(template.category.replace("-", " "))} template</p>
      <h1>${escapeHtml(title)}</h1>
      <span>${escapeHtml(template.summary)}</span>
      <button type="button">${escapeHtml(primaryAction)}</button>
    </section>
    <section class="grid">${cards}</section>
    ${isGame ? '<canvas id="demo-canvas" width="720" height="320" aria-label="Game starter canvas"></canvas>' : `<section class="panel"><h2>Operational Snapshot</h2><table><tbody>${tableRows}</tbody></table></section>`}
  </main>
  <script src="app.js"></script>
</body>
</html>
`;
  const css = `:root{font-family:Inter,system-ui,sans-serif;color:#18202a;background:#f5f7fb}*{box-sizing:border-box}body{margin:0;display:grid;grid-template-columns:240px minmax(0,1fr);min-height:100vh}.sidebar{background:#101826;color:#fff;padding:24px;display:flex;flex-direction:column;gap:24px}.sidebar strong{font-size:18px}.sidebar nav{display:grid;gap:8px}.sidebar a{color:#dbeafe;text-decoration:none;padding:8px 0}main{padding:32px;display:grid;gap:22px}.hero{background:#fff;border:1px solid #d8dee9;border-radius:8px;padding:28px;display:grid;gap:12px}.hero p{margin:0;color:#475569;text-transform:uppercase;font-size:12px;font-weight:700}.hero h1{margin:0;font-size:36px;line-height:1.05;letter-spacing:0}.hero span{max-width:760px;color:#475569}.hero button{justify-self:start;border:0;border-radius:6px;background:#0f766e;color:white;padding:10px 14px;font-weight:700}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}.card,.panel{background:#fff;border:1px solid #d8dee9;border-radius:8px;padding:18px}.card span{font-size:12px;color:#64748b}.card h3{margin:6px 0}.card p{color:#475569}table{width:100%;border-collapse:collapse}td{border-top:1px solid #e2e8f0;padding:12px;text-align:left}canvas{width:100%;max-width:900px;background:#111827;border-radius:8px}@media(max-width:760px){body{grid-template-columns:1fr}.sidebar{position:static}.hero h1{font-size:28px}main{padding:18px}}`;
  const js = isGame
    ? `const canvas=document.querySelector("#demo-canvas");const ctx=canvas.getContext("2d");let x=40;function draw(){ctx.clearRect(0,0,canvas.width,canvas.height);ctx.fillStyle="#38bdf8";ctx.fillRect(x,140,42,42);ctx.fillStyle="#facc15";ctx.fillRect(620,120,34,72);x=(x+2)%canvas.width;requestAnimationFrame(draw)}draw();`
    : `document.querySelectorAll(".card").forEach((card)=>card.addEventListener("click",()=>card.classList.toggle("selected")));`;
  const readme = `# ${title}

Template: ${template.title} (${template.id})

## Included

${template.features.map((feature) => `- ${feature}`).join("\n")}

## Next Steps

- Replace placeholder copy with project-specific content.
- Wire real data and interactions.
- Run validation and browser QA before publishing.
`;
  return [
    { path: "index.html", content: html },
    { path: "styles.css", content: css },
    { path: "app.js", content: js },
    { path: "README.md", content: readme }
  ];
}

function renderCatalogMarkdown(projectId: string, templates: ProjectTemplate[]) {
  const rows = templates.map((template) => `| ${template.id} | ${template.title.replaceAll("|", "\\|")} | ${template.category} | ${template.complexity} | ${template.source} | ${template.features.slice(0, 4).join(", ").replaceAll("|", "\\|")} |`).join("\n");
  return `# Project Template Marketplace

- Project: \`${projectId}\`
- Templates: ${templates.length}

| ID | Title | Category | Complexity | Source | Features |
| --- | --- | --- | --- | --- | --- |
${rows || "| - | - | - | - | - | - |"}
`;
}

export const projectTemplateTools: ToolModule[] = [
  {
    definition: {
      name: "register_project_template",
      description: "Register a reusable custom project template in a project-local template marketplace catalog.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, template: { type: "object" } }, required: ["projectId", "template"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: registerProjectTemplateSchema,
    handler: async (input, ctx) => {
      const parsed = registerProjectTemplateSchema.parse(input);
      const catalog = await readCustomCatalog(ctx, parsed.projectId);
      const template: ProjectTemplate = { ...parsed.template, source: "custom" };
      catalog.templates = [...catalog.templates.filter((item) => item.id !== template.id), template];
      const file = await writeCustomCatalog(ctx, parsed.projectId, catalog);
      return { ok: true, summary: `Registered project template ${template.id}.`, jobId: parsed.projectId, artifacts: [file.path, template.id], structuredContent: { projectId: parsed.projectId, template }, logs: [templateCard(template)], errors: [] };
    }
  },
  {
    definition: {
      name: "list_project_templates",
      description: "List built-in and optional project-local templates for admin panels, PWA apps, dashboards, games, landing pages, data tools, and documentation sites.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, category: { type: "string", enum: ["admin-panel", "pwa-app", "dashboard", "game", "landing-page", "data-tool", "docs-site"] }, query: { type: "string" }, includeCustom: { type: "boolean" } }, additionalProperties: false }
    },
    enabledByDefault: true,
    schema: listProjectTemplatesSchema,
    handler: async (input, ctx) => {
      const parsed = listProjectTemplatesSchema.parse(input);
      const templates = (await allTemplates(ctx, parsed.projectId, parsed.includeCustom))
        .filter((template) => !parsed.category || template.category === parsed.category)
        .filter((template) => matchesQuery(template, parsed.query));
      return { ok: true, summary: `${templates.length} project template(s) returned.`, jobId: parsed.projectId, artifacts: [], structuredContent: { projectId: parsed.projectId, templates }, logs: templates.map(templateCard), errors: [] };
    }
  },
  {
    definition: {
      name: "recommend_project_templates",
      description: "Rank project templates for a use case using category, tags, recommended scenarios, and desired features.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, useCase: { type: "string" }, category: { type: "string", enum: ["admin-panel", "pwa-app", "dashboard", "game", "landing-page", "data-tool", "docs-site"] }, desiredFeatures: { type: "array", items: { type: "string" } }, maxResults: { type: "number" } }, required: ["useCase"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: recommendProjectTemplatesSchema,
    handler: async (input, ctx) => {
      const parsed = recommendProjectTemplatesSchema.parse(input);
      const ranked = (await allTemplates(ctx, parsed.projectId, true))
        .filter((template) => !parsed.category || template.category === parsed.category)
        .map((template) => ({ template, score: scoreTemplate(template, parsed.useCase, parsed.desiredFeatures) }))
        .sort((left, right) => right.score - left.score || left.template.title.localeCompare(right.template.title))
        .slice(0, parsed.maxResults);
      return { ok: true, summary: `Recommended ${ranked.length} project template(s).`, jobId: parsed.projectId, artifacts: ranked.map((item) => item.template.id), structuredContent: { projectId: parsed.projectId, recommendations: ranked }, logs: ranked.map((item) => `${item.score}: ${templateCard(item.template)}`), errors: [] };
    }
  },
  {
    definition: {
      name: "create_project_from_template",
      description: "Create a new static project from a built-in or project-local template marketplace entry and validate the starter files.",
      inputSchema: { type: "object", properties: { sourceProjectId: { type: "string" }, templateId: { type: "string" }, title: { type: "string" }, summary: { type: "string" }, brandName: { type: "string" }, primaryAction: { type: "string" }, validate: { type: "boolean" } }, required: ["templateId", "title"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: createProjectFromTemplateSchema,
    handler: async (input, ctx) => {
      const parsed = createProjectFromTemplateSchema.parse(input);
      const template = (await allTemplates(ctx, parsed.sourceProjectId, true)).find((item) => item.id === parsed.templateId);
      if (!template) throw new Error(`Project template ${parsed.templateId} not found.`);
      const project = await createProject(ctx.projectRoot, { title: parsed.title, summary: parsed.summary ?? template.summary, entryFile: "index.html", createdByClientId: ctx.clientId });
      const files = [];
      for (const file of shellFor(template, parsed.title, parsed.brandName ?? parsed.title, parsed.primaryAction ?? "Open workspace")) {
        files.push(await writeProjectFile(ctx.projectRoot, project.id, file.path, file.content));
      }
      const validation = parsed.validate ? await validateProject(ctx.projectRoot, project.id, "index.html") : undefined;
      return { ok: validation ? validation.ok : true, summary: `Created project ${project.id} from template ${template.id}${validation ? `; validation ${validation.ok ? "passed" : "failed"}.` : "."}`, jobId: project.id, artifacts: [project.id, ...files.map((file) => file.path)], structuredContent: { projectId: project.id, template, files, validation }, logs: [JSON.stringify({ projectId: project.id, templateId: template.id, files: files.map((file) => file.path), validation }, null, 2)], errors: validation?.errors ?? [] };
    }
  },
  {
    definition: {
      name: "export_project_template_catalog",
      description: "Export the built-in and project-local template marketplace catalog as a Markdown handoff document.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, outputPath: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: exportProjectTemplateCatalogSchema,
    handler: async (input, ctx) => {
      const parsed = exportProjectTemplateCatalogSchema.parse(input);
      const templates = await allTemplates(ctx, parsed.projectId, true);
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, renderCatalogMarkdown(parsed.projectId, templates));
      return { ok: true, summary: `Exported project template marketplace with ${templates.length} template(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { projectId: parsed.projectId, outputPath: file.path, templateCount: templates.length }, logs: [file.path], errors: [] };
    }
  }
];
