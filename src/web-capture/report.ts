import type { WebpageCapture } from "./capture.js";

export type WebpageAnalysis = {
  analysisId: string;
  captureId: string;
  analyzedAt: string;
  focus: string[];
  findings: Array<{ category: string; severity: "info" | "warning" | "error"; message: string }>;
  recommendations: string[];
};

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function renderCaptureReport(capture: WebpageCapture): string {
  const pageSections = capture.pages.map((page) => {
    const headings = page.headings.map((heading) => `<li>H${heading.level}: ${escapeHtml(heading.text)}</li>`).join("");
    const resources = page.resources.slice(0, 24).map((resource) => `<li>${escapeHtml(resource.type)} ${resource.status ?? ""} ${escapeHtml(resource.url)}</li>`).join("");
    const forms = page.forms.map((form) => `<li>${escapeHtml(form.method)} ${escapeHtml(form.action || "(same page)")} · ${form.fields.length} field(s)</li>`).join("");
    return `<section>
      <h2>${escapeHtml(page.viewport)} · ${escapeHtml(page.finalUrl)}</h2>
      <dl>
        <div><dt>Title</dt><dd>${escapeHtml(page.title || "(empty)")}</dd></div>
        <div><dt>Description</dt><dd>${escapeHtml(page.metaDescription || "(missing)")}</dd></div>
        <div><dt>Links</dt><dd>${page.links.length}</dd></div>
        <div><dt>Images</dt><dd>${page.images.length}</dd></div>
        <div><dt>Forms</dt><dd>${page.forms.length}</dd></div>
        <div><dt>Network records</dt><dd>${page.resources.length}</dd></div>
      </dl>
      ${page.screenshotDataUrl ? `<img src="${page.screenshotDataUrl}" alt="${escapeHtml(page.viewport)} screenshot">` : ""}
      <h3>Headings</h3>
      <ul>${headings || "<li>No headings captured.</li>"}</ul>
      <h3>Forms</h3>
      <ul>${forms || "<li>No forms captured.</li>"}</ul>
      <h3>Network Sample</h3>
      <ul>${resources || "<li>No network sample captured.</li>"}</ul>
    </section>`;
  }).join("");
  const issues = capture.issues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join("");
  const warnings = capture.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Webpage Capture Report</title>
  <style>
    :root { color-scheme: light; --ink:#18201d; --muted:#617069; --line:#d8dfdc; --paper:#f5f7f2; --panel:#fff; --accent:#0d6759; }
    body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--paper); color:var(--ink); }
    main { width:min(1120px, calc(100vw - 32px)); margin:32px auto; }
    header, section { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:18px; margin:16px 0; }
    h1 { margin:0 0 8px; font-size:28px; letter-spacing:0; }
    h2 { margin:0 0 12px; font-size:20px; overflow-wrap:anywhere; }
    h3 { margin:16px 0 8px; font-size:15px; }
    p, dt { color:var(--muted); }
    dl { display:grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap:10px; }
    dd { margin:3px 0 0; overflow-wrap:anywhere; }
    img { display:block; width:100%; max-width:760px; border:1px solid var(--line); border-radius:6px; background:white; }
    li { margin:7px 0; overflow-wrap:anywhere; }
    @media (max-width: 720px) { dl { grid-template-columns:1fr; } main { width:min(100vw - 20px, 1120px); margin:20px auto; } }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Webpage Capture Report</h1>
      <p>${escapeHtml(capture.sourceUrl)} · ${capture.pages.length} viewport page capture(s) · ${escapeHtml(capture.capturedAt)}</p>
      <h3>Warnings</h3>
      <ul>${warnings || "<li>No capture warnings.</li>"}</ul>
      <h3>Issues</h3>
      <ul>${issues || "<li>No obvious capture issues.</li>"}</ul>
    </header>
    ${pageSections}
  </main>
</body>
</html>`;
}

export function renderAnalysisReport(capture: WebpageCapture, analysis: WebpageAnalysis): string {
  const findings = analysis.findings.map((finding) => `<li><strong>${escapeHtml(finding.severity)} / ${escapeHtml(finding.category)}:</strong> ${escapeHtml(finding.message)}</li>`).join("");
  const recommendations = analysis.recommendations.map((recommendation) => `<li>${escapeHtml(recommendation)}</li>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Webpage Analysis Report</title>
  <style>
    :root { --ink:#18201d; --muted:#617069; --line:#d8dfdc; --paper:#f7f7f1; --panel:#fff; }
    body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--paper); color:var(--ink); }
    main { width:min(980px, calc(100vw - 32px)); margin:32px auto; }
    section, header { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:18px; margin:16px 0; }
    h1 { margin:0 0 8px; font-size:28px; letter-spacing:0; }
    p { color:var(--muted); overflow-wrap:anywhere; }
    li { margin:9px 0; line-height:1.45; }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Webpage Analysis Report</h1>
      <p>${escapeHtml(capture.sourceUrl)} · ${escapeHtml(analysis.analyzedAt)}</p>
    </header>
    <section>
      <h2>Findings</h2>
      <ul>${findings || "<li>No findings for selected focus areas.</li>"}</ul>
    </section>
    <section>
      <h2>Recommendations</h2>
      <ul>${recommendations || "<li>No recommendations generated.</li>"}</ul>
    </section>
  </main>
</body>
</html>`;
}
