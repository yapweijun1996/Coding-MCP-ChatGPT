import { z } from "zod";
import { appendProjectTaskHistory, createProject, getProjectManifest, validateProject, writeProjectFile } from "../../projects/store.js";
import type { ToolModule } from "../types.js";

const DEFAULT_COMPONENTS = [
  "button",
  "card",
  "table",
  "modal",
  "sidebar",
  "topbar",
  "empty-state",
  "toast",
  "tabs",
  "form-field",
  "icon"
];

const componentLibrarySchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  title: z.string().min(1).max(120).default("Reusable UI Component Library"),
  summary: z.string().min(1).max(300).optional(),
  components: z.array(z.string().min(1).max(80)).max(40).optional().default(DEFAULT_COMPONENTS),
  outputDir: z.string().min(1).max(160).default("component-library"),
  tokens: z.object({
    primary: z.string().min(1).max(40).default("#2563eb"),
    accent: z.string().min(1).max(40).default("#f59e0b"),
    background: z.string().min(1).max(40).default("#f8fafc"),
    surface: z.string().min(1).max(40).default("#ffffff"),
    text: z.string().min(1).max(40).default("#111827"),
    muted: z.string().min(1).max(40).default("#6b7280"),
    border: z.string().min(1).max(40).default("#d1d5db"),
    success: z.string().min(1).max(40).default("#15803d"),
    warning: z.string().min(1).max(40).default("#b45309"),
    danger: z.string().min(1).max(40).default("#b91c1c"),
    radius: z.number().min(0).max(24).default(8),
    density: z.enum(["compact", "comfortable", "spacious"]).default("comfortable"),
    fontFamily: z.string().min(1).max(160).default("Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif")
  }).optional().default({}),
  includeStyleGuide: z.boolean().default(true),
  includeUsageExamples: z.boolean().default(true),
  validate: z.boolean().default(true)
});

type ComponentLibraryInput = z.infer<typeof componentLibrarySchema>;

function escapeHtml(value: string): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function safeSegment(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "component";
}

function uniqueComponents(items: string[]): string[] {
  const normalized = items.map(safeSegment).filter(Boolean);
  return [...new Set(normalized.length ? normalized : DEFAULT_COMPONENTS)].slice(0, 40);
}

function joinProjectPath(dir: string, file: string): string {
  const cleanDir = dir.split("/").map(safeSegment).filter(Boolean).join("/") || "component-library";
  return `${cleanDir}/${file}`;
}

function densityValues(density: ComponentLibraryInput["tokens"]["density"]) {
  if (density === "compact") return { gap: "8px", padY: "8px", padX: "10px", row: "36px" };
  if (density === "spacious") return { gap: "18px", padY: "14px", padX: "18px", row: "52px" };
  return { gap: "12px", padY: "10px", padX: "14px", row: "44px" };
}

function renderCss(input: ComponentLibraryInput, components: string[]): string {
  const tokens = input.tokens;
  const density = densityValues(tokens.density);
  return `:root {
  --ui-color-primary: ${tokens.primary};
  --ui-color-accent: ${tokens.accent};
  --ui-color-bg: ${tokens.background};
  --ui-color-surface: ${tokens.surface};
  --ui-color-text: ${tokens.text};
  --ui-color-muted: ${tokens.muted};
  --ui-color-border: ${tokens.border};
  --ui-color-success: ${tokens.success};
  --ui-color-warning: ${tokens.warning};
  --ui-color-danger: ${tokens.danger};
  --ui-radius: ${tokens.radius}px;
  --ui-gap: ${density.gap};
  --ui-pad-y: ${density.padY};
  --ui-pad-x: ${density.padX};
  --ui-row-height: ${density.row};
  --ui-font: ${tokens.fontFamily};
  --ui-shadow: 0 8px 24px rgb(15 23 42 / 0.10);
}

*, *::before, *::after { box-sizing: border-box; }
.ui-library { min-height: 100%; margin: 0; background: var(--ui-color-bg); color: var(--ui-color-text); font-family: var(--ui-font); line-height: 1.5; }
.ui-shell { display: grid; grid-template-columns: 240px minmax(0, 1fr); min-height: 100vh; }
.ui-sidebar { background: #111827; color: white; padding: 20px; }
.ui-sidebar a { display: block; color: #d1d5db; padding: 8px 0; text-decoration: none; }
.ui-sidebar a:focus-visible, .ui-sidebar a:hover { color: white; outline: none; }
.ui-main { width: min(100% - 32px, 1120px); margin: 0 auto; padding: 28px 0 48px; }
.ui-section { padding: 24px 0; border-bottom: 1px solid var(--ui-color-border); }
.ui-section h2 { margin: 0 0 14px; font-size: 22px; }
.ui-example-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--ui-gap); align-items: start; }
.ui-btn { min-height: var(--ui-row-height); border: 1px solid transparent; border-radius: var(--ui-radius); padding: var(--ui-pad-y) var(--ui-pad-x); font: inherit; font-weight: 650; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 8px; text-decoration: none; }
.ui-btn:focus-visible, .ui-input:focus-visible, .ui-select:focus-visible, .ui-tab:focus-visible { outline: 3px solid color-mix(in srgb, var(--ui-color-primary) 32%, white); outline-offset: 2px; }
.ui-btn-primary { background: var(--ui-color-primary); color: white; }
.ui-btn-secondary { background: var(--ui-color-surface); border-color: var(--ui-color-border); color: var(--ui-color-text); }
.ui-btn-danger { background: var(--ui-color-danger); color: white; }
.ui-card { background: var(--ui-color-surface); border: 1px solid var(--ui-color-border); border-radius: var(--ui-radius); padding: 18px; box-shadow: var(--ui-shadow); }
.ui-card h3 { margin: 0 0 6px; font-size: 18px; }
.ui-card p { color: var(--ui-color-muted); margin: 0; }
.ui-topbar { min-height: 60px; display: flex; align-items: center; justify-content: space-between; gap: var(--ui-gap); background: var(--ui-color-surface); border: 1px solid var(--ui-color-border); border-radius: var(--ui-radius); padding: 0 16px; }
.ui-table-wrap { overflow-x: auto; border: 1px solid var(--ui-color-border); border-radius: var(--ui-radius); background: var(--ui-color-surface); }
.ui-table { width: 100%; border-collapse: collapse; min-width: 560px; }
.ui-table th, .ui-table td { height: var(--ui-row-height); padding: 0 12px; border-bottom: 1px solid var(--ui-color-border); text-align: left; white-space: nowrap; }
.ui-table th { color: var(--ui-color-muted); font-size: 13px; background: color-mix(in srgb, var(--ui-color-bg) 70%, white); }
.ui-badge { display: inline-flex; align-items: center; min-height: 24px; border-radius: 999px; padding: 0 9px; font-size: 12px; font-weight: 700; }
.ui-badge-success { background: color-mix(in srgb, var(--ui-color-success) 15%, white); color: var(--ui-color-success); }
.ui-badge-warning { background: color-mix(in srgb, var(--ui-color-warning) 15%, white); color: var(--ui-color-warning); }
.ui-field { display: grid; gap: 6px; }
.ui-label { font-size: 13px; font-weight: 700; color: var(--ui-color-text); }
.ui-input, .ui-select { min-height: var(--ui-row-height); border: 1px solid var(--ui-color-border); border-radius: var(--ui-radius); padding: 0 12px; font: inherit; background: var(--ui-color-surface); color: var(--ui-color-text); }
.ui-empty { border: 1px dashed var(--ui-color-border); border-radius: var(--ui-radius); padding: 28px; text-align: center; background: var(--ui-color-surface); }
.ui-empty svg { width: 42px; height: 42px; color: var(--ui-color-muted); }
.ui-toast-region { position: fixed; right: 16px; bottom: 16px; display: grid; gap: 8px; z-index: 50; }
.ui-toast { width: min(360px, calc(100vw - 32px)); border-radius: var(--ui-radius); background: #111827; color: white; padding: 12px 14px; box-shadow: var(--ui-shadow); }
.ui-tabs { display: grid; gap: var(--ui-gap); }
.ui-tab-list { display: flex; gap: 4px; border-bottom: 1px solid var(--ui-color-border); }
.ui-tab { border: 0; background: transparent; padding: 10px 12px; font: inherit; cursor: pointer; color: var(--ui-color-muted); border-bottom: 3px solid transparent; }
.ui-tab[aria-selected="true"] { color: var(--ui-color-primary); border-bottom-color: var(--ui-color-primary); }
.ui-tab-panel[hidden] { display: none; }
.ui-modal-backdrop { position: fixed; inset: 0; background: rgb(17 24 39 / 0.55); display: none; place-items: center; padding: 16px; z-index: 60; }
.ui-modal-backdrop[data-open="true"] { display: grid; }
.ui-modal { width: min(520px, 100%); background: var(--ui-color-surface); border-radius: var(--ui-radius); box-shadow: var(--ui-shadow); padding: 20px; }
.ui-icon { width: 18px; height: 18px; flex: 0 0 auto; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.ui-component-note { color: var(--ui-color-muted); font-size: 13px; margin: 8px 0 0; }
${components.map((component) => `.ui-has-${component} { --ui-component-${component}: 1; }`).join("\n")}
@media (max-width: 820px) {
  .ui-shell { grid-template-columns: 1fr; }
  .ui-sidebar { position: static; }
  .ui-example-grid { grid-template-columns: 1fr; }
}
`;
}

function renderJs(): string {
  return `(() => {
  const closeModal = () => document.querySelectorAll('[data-ui-modal]').forEach((modal) => modal.dataset.open = 'false');
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-ui-action]');
    if (!target) return;
    const action = target.getAttribute('data-ui-action');
    if (action === 'open-modal') document.querySelector('[data-ui-modal]')?.setAttribute('data-open', 'true');
    if (action === 'close-modal') closeModal();
    if (action === 'show-toast') {
      const region = document.querySelector('[data-ui-toast-region]');
      if (!region) return;
      const toast = document.createElement('div');
      toast.className = 'ui-toast';
      toast.setAttribute('role', 'status');
      toast.textContent = target.getAttribute('data-ui-toast') || 'Action completed.';
      region.append(toast);
      setTimeout(() => toast.remove(), 3200);
    }
    if (action === 'tab') {
      const tab = target;
      const list = tab.closest('[role="tablist"]');
      const root = tab.closest('[data-ui-tabs]');
      if (!list || !root) return;
      list.querySelectorAll('[role="tab"]').forEach((item) => item.setAttribute('aria-selected', String(item === tab)));
      root.querySelectorAll('[role="tabpanel"]').forEach((panel) => panel.hidden = panel.id !== tab.getAttribute('aria-controls'));
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeModal();
  });
})();`;
}

function renderIconsSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">
  <symbol id="ui-icon-check" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></symbol>
  <symbol id="ui-icon-alert" viewBox="0 0 24 24"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></symbol>
  <symbol id="ui-icon-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></symbol>
  <symbol id="ui-icon-plus" viewBox="0 0 24 24"><path d="M12 5v14"/><path d="M5 12h14"/></symbol>
  <symbol id="ui-icon-settings" viewBox="0 0 24 24"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1A2 2 0 1 1 4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1A2 2 0 1 1 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 1 1 19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.1a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></symbol>
</svg>
`;
}

function renderStyleGuide(input: ComponentLibraryInput, components: string[]): string {
  const nav = components.map((component) => `<a href="#${component}">${escapeHtml(component.replaceAll("-", " "))}</a>`).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(input.title)}</title>
  <link rel="stylesheet" href="ui.css">
</head>
<body class="ui-library">
${renderIconsSvg()}
<div class="ui-shell">
  <aside class="ui-sidebar" aria-label="Component library navigation">
    <strong>${escapeHtml(input.title)}</strong>
    <nav>${nav}</nav>
  </aside>
  <main class="ui-main">
    <header class="ui-topbar">
      <div>
        <h1>${escapeHtml(input.title)}</h1>
        <p class="ui-component-note">${escapeHtml(input.summary ?? "Reusable components with shared design tokens, variants, accessibility defaults, and examples.")}</p>
      </div>
      <button class="ui-btn ui-btn-primary" data-ui-action="show-toast" data-ui-toast="Component library ready."><svg class="ui-icon"><use href="#ui-icon-check"></use></svg>Preview Toast</button>
    </header>
    ${components.map(renderComponentSection).join("\n")}
  </main>
</div>
<div class="ui-toast-region" data-ui-toast-region aria-live="polite"></div>
<div class="ui-modal-backdrop" data-ui-modal>
  <section class="ui-modal" role="dialog" aria-modal="true" aria-labelledby="demo-modal-title">
    <h2 id="demo-modal-title">Confirm action</h2>
    <p>This modal includes focus-visible styling, escape close behavior, and accessible dialog semantics.</p>
    <button class="ui-btn ui-btn-secondary" data-ui-action="close-modal">Close</button>
  </section>
</div>
<script src="ui.js"></script>
</body>
</html>
`;
}

function renderComponentSection(component: string): string {
  const title = escapeHtml(component.replaceAll("-", " "));
  return `<section id="${component}" class="ui-section ui-has-${component}" aria-labelledby="${component}-title">
  <h2 id="${component}-title">${title}</h2>
  <div class="ui-example-grid">${componentExample(component)}</div>
  <p class="ui-component-note">Use shared tokens for spacing, radius, typography, color, focus rings, and responsive constraints.</p>
</section>`;
}

function componentExample(component: string): string {
  if (component === "button") return `<button class="ui-btn ui-btn-primary"><svg class="ui-icon"><use href="#ui-icon-plus"></use></svg>Create</button><button class="ui-btn ui-btn-secondary">Secondary</button><button class="ui-btn ui-btn-danger">Delete</button>`;
  if (component === "card") return `<article class="ui-card"><h3>Pipeline Health</h3><p>Reusable card container for summaries, settings, and dashboards.</p></article>`;
  if (component === "table") return `<div class="ui-table-wrap"><table class="ui-table"><thead><tr><th>Name</th><th>Status</th><th>Owner</th></tr></thead><tbody><tr><td>Import job</td><td><span class="ui-badge ui-badge-success">Ready</span></td><td>Ops</td></tr><tr><td>Billing sync</td><td><span class="ui-badge ui-badge-warning">Review</span></td><td>Finance</td></tr></tbody></table></div>`;
  if (component === "modal") return `<button class="ui-btn ui-btn-primary" data-ui-action="open-modal">Open modal</button>`;
  if (component === "sidebar") return `<aside class="ui-sidebar"><strong>Workspace</strong><a href="#">Dashboard</a><a href="#">Reports</a><a href="#">Settings</a></aside>`;
  if (component === "topbar") return `<header class="ui-topbar"><strong>Admin Console</strong><button class="ui-btn ui-btn-secondary"><svg class="ui-icon"><use href="#ui-icon-settings"></use></svg>Settings</button></header>`;
  if (component === "empty-state") return `<section class="ui-empty"><svg class="ui-icon"><use href="#ui-icon-search"></use></svg><h3>No records found</h3><p>Adjust filters or create a new item.</p><button class="ui-btn ui-btn-primary">Create item</button></section>`;
  if (component === "toast") return `<button class="ui-btn ui-btn-secondary" data-ui-action="show-toast" data-ui-toast="Saved successfully.">Show toast</button>`;
  if (component === "tabs") return `<div class="ui-tabs" data-ui-tabs><div class="ui-tab-list" role="tablist"><button class="ui-tab" role="tab" aria-selected="true" aria-controls="tab-overview" data-ui-action="tab">Overview</button><button class="ui-tab" role="tab" aria-selected="false" aria-controls="tab-audit" data-ui-action="tab">Audit</button></div><section class="ui-tab-panel" id="tab-overview" role="tabpanel">Overview content</section><section class="ui-tab-panel" id="tab-audit" role="tabpanel" hidden>Audit content</section></div>`;
  if (component === "form-field") return `<label class="ui-field"><span class="ui-label">Project name</span><input class="ui-input" placeholder="Operations Console"></label><label class="ui-field"><span class="ui-label">Status</span><select class="ui-select"><option>Active</option><option>Paused</option></select></label>`;
  if (component === "icon") return `<p><svg class="ui-icon"><use href="#ui-icon-check"></use></svg> <svg class="ui-icon"><use href="#ui-icon-alert"></use></svg> <svg class="ui-icon"><use href="#ui-icon-search"></use></svg> <svg class="ui-icon"><use href="#ui-icon-settings"></use></svg></p>`;
  return `<article class="ui-card"><h3>${escapeHtml(component.replaceAll("-", " "))}</h3><p>Custom generated component placeholder with stable class hook <code>.ui-has-${escapeHtml(component)}</code>.</p></article>`;
}

function renderUsageMarkdown(input: ComponentLibraryInput, files: Record<string, string>, components: string[]): string {
  return `# ${input.title}

${input.summary ?? "Reusable UI component library generated for static project workflows."}

## Files

- \`${files.css}\`: design tokens and component CSS.
- \`${files.js}\`: modal, tabs, and toast behavior.
- \`${files.icons}\`: reusable SVG symbols.
- \`${files.manifest}\`: token, component, variant, and accessibility metadata.
${input.includeStyleGuide ? `- \`${files.styleGuide}\`: style guide with live examples.` : ""}

## Components

${components.map((component) => `- \`${component}\`: includes tokenized styling, example markup, and stable class hooks.`).join("\n")}

## Accessibility Defaults

- Buttons, tabs, modal, toast region, tables, forms, and navigation examples include semantic roles or native controls.
- Focus states use visible outlines and tokenized colors.
- Examples avoid hover-only affordances and keep mobile layouts responsive.
`;
}

function libraryManifest(input: ComponentLibraryInput, components: string[], files: Record<string, string>) {
  return {
    title: input.title,
    summary: input.summary ?? "Reusable UI components with tokens and examples.",
    components,
    tokens: input.tokens,
    variants: {
      button: ["primary", "secondary", "danger"],
      badge: ["success", "warning"],
      density: input.tokens.density
    },
    files,
    accessibilityDefaults: ["semantic HTML", "visible focus", "ARIA tabs", "ARIA modal", "live toast region", "responsive tables"],
    nextSteps: ["Import ui.css and ui.js into app pages.", "Copy examples from the style guide.", "Run accessibility and design-system audits after customization."]
  };
}

export const componentLibraryTools: ToolModule[] = [
  {
    definition: {
      name: "generate_component_library",
      description: "Generate a reusable UI component library with design tokens, common admin/demo components, variants, accessibility defaults, SVG icons, usage docs, manifest, and an optional style guide page.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          title: { type: "string" },
          summary: { type: "string" },
          components: { type: "array", items: { type: "string" } },
          outputDir: { type: "string" },
          tokens: { type: "object" },
          includeStyleGuide: { type: "boolean" },
          includeUsageExamples: { type: "boolean" },
          validate: { type: "boolean" }
        },
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: componentLibrarySchema,
    handler: async (input, ctx) => {
      const parsed = componentLibrarySchema.parse(input);
      const components = uniqueComponents(parsed.components);
      const projectId = parsed.projectId ?? (await createProject(ctx.projectRoot, {
          title: parsed.title,
          summary: parsed.summary ?? "Reusable UI component library with tokens, variants, examples, and accessibility defaults.",
          entryFile: joinProjectPath(parsed.outputDir, "style-guide.html"),
          createdByClientId: ctx.clientId
        })).id;
      if (parsed.projectId) await getProjectManifest(ctx.projectRoot, parsed.projectId);
      const files = {
        css: joinProjectPath(parsed.outputDir, "ui.css"),
        js: joinProjectPath(parsed.outputDir, "ui.js"),
        icons: joinProjectPath(parsed.outputDir, "icons.svg"),
        manifest: joinProjectPath(parsed.outputDir, "component-library.json"),
        usage: joinProjectPath(parsed.outputDir, "USAGE.md"),
        styleGuide: joinProjectPath(parsed.outputDir, "style-guide.html")
      };
      const manifest = libraryManifest(parsed, components, files);
      const written = [
        await writeProjectFile(ctx.projectRoot, projectId, files.css, renderCss(parsed, components)),
        await writeProjectFile(ctx.projectRoot, projectId, files.js, renderJs()),
        await writeProjectFile(ctx.projectRoot, projectId, files.icons, renderIconsSvg()),
        await writeProjectFile(ctx.projectRoot, projectId, files.manifest, `${JSON.stringify(manifest, null, 2)}\n`)
      ];
      if (parsed.includeUsageExamples) written.push(await writeProjectFile(ctx.projectRoot, projectId, files.usage, renderUsageMarkdown(parsed, files, components)));
      if (parsed.includeStyleGuide) written.push(await writeProjectFile(ctx.projectRoot, projectId, files.styleGuide, renderStyleGuide(parsed, components)));
      const validation = parsed.validate && parsed.includeStyleGuide ? await validateProject(ctx.projectRoot, projectId, files.styleGuide, "static_html") : undefined;
      const ok = validation ? validation.ok : true;
      await appendProjectTaskHistory(ctx.projectRoot, projectId, {
        toolName: "generate_component_library",
        ok,
        summary: `Generated reusable UI component library with ${components.length} component(s).`,
        details: { files, components, validation }
      });
      return {
        ok,
        summary: ok ? `Generated component library with ${components.length} component(s).` : "Generated component library, but style guide validation found issues.",
        jobId: projectId,
        artifacts: written.map((file) => file.path),
        structuredContent: { projectId, files, components, tokens: parsed.tokens, validation, manifest },
        logs: [JSON.stringify({ projectId, files, components, validation }, null, 2)],
        errors: validation?.errors ?? []
      };
    }
  }
];
