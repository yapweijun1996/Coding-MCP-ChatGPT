// Pure SEO generators: sitemap.xml, robots.txt, and the <head> tag blocks (Open Graph,
// Twitter cards, JSON-LD) injected into blog pages and the homepage. No I/O — callers pass
// already-resolved absolute URLs and metadata so every function is unit-testable in isolation.

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function escapeAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// JSON-LD lives inside a <script> element, so escape "<" to "<" — otherwise a "</script>"
// in any field would break out of the element. JSON.stringify already handles quoting.
function jsonLdScript(data: Record<string, unknown>): string {
  return `<script type="application/ld+json">${JSON.stringify(data).replaceAll("<", "\\u003c")}</script>`;
}

export interface SitemapEntry {
  loc: string;
  lastmod?: string;
  changefreq?: string;
  priority?: string;
}

export function buildSitemapXml(entries: SitemapEntry[]): string {
  const urls = entries.map((entry) => {
    const parts = [`    <loc>${escapeXml(entry.loc)}</loc>`];
    if (entry.lastmod) parts.push(`    <lastmod>${escapeXml(entry.lastmod)}</lastmod>`);
    if (entry.changefreq) parts.push(`    <changefreq>${escapeXml(entry.changefreq)}</changefreq>`);
    if (entry.priority) parts.push(`    <priority>${escapeXml(entry.priority)}</priority>`);
    return `  <url>\n${parts.join("\n")}\n  </url>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export function buildRobotsTxt(sitemapUrl: string, disallow: string[] = []): string {
  return ["User-agent: *", "Allow: /", ...disallow.map((path) => `Disallow: ${path}`), `Sitemap: ${sitemapUrl}`].join("\n") + "\n";
}

export interface BlogPostSeoInput {
  title: string;
  description?: string;
  url: string;
  imageUrl?: string;
  publishedAt?: string | null;
  modifiedAt?: string | null;
  siteName?: string;
}

export function buildBlogPostHead(input: BlogPostSeoInput): string {
  const tags = [
    `<link rel="canonical" href="${escapeAttr(input.url)}">`,
    `<meta property="og:type" content="article">`,
    `<meta property="og:title" content="${escapeAttr(input.title)}">`,
    `<meta property="og:url" content="${escapeAttr(input.url)}">`
  ];
  if (input.siteName) tags.push(`<meta property="og:site_name" content="${escapeAttr(input.siteName)}">`);
  if (input.description) tags.push(`<meta property="og:description" content="${escapeAttr(input.description)}">`);
  if (input.imageUrl) tags.push(`<meta property="og:image" content="${escapeAttr(input.imageUrl)}">`);
  if (input.publishedAt) tags.push(`<meta property="article:published_time" content="${escapeAttr(input.publishedAt)}">`);
  if (input.modifiedAt) tags.push(`<meta property="article:modified_time" content="${escapeAttr(input.modifiedAt)}">`);
  tags.push(`<meta name="twitter:card" content="${input.imageUrl ? "summary_large_image" : "summary"}">`);
  tags.push(`<meta name="twitter:title" content="${escapeAttr(input.title)}">`);
  if (input.description) tags.push(`<meta name="twitter:description" content="${escapeAttr(input.description)}">`);
  if (input.imageUrl) tags.push(`<meta name="twitter:image" content="${escapeAttr(input.imageUrl)}">`);
  const jsonLd: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: input.title,
    mainEntityOfPage: input.url,
    url: input.url
  };
  if (input.description) jsonLd.description = input.description;
  if (input.imageUrl) jsonLd.image = input.imageUrl;
  if (input.publishedAt) jsonLd.datePublished = input.publishedAt;
  if (input.modifiedAt) jsonLd.dateModified = input.modifiedAt;
  if (input.siteName) jsonLd.publisher = { "@type": "Organization", name: input.siteName };
  tags.push(jsonLdScript(jsonLd));
  return tags.join("\n");
}

// Index emits social/discovery meta but no JSON-LD <script>, so the blog index stays script-free
// (the theme sanitizer guarantees this) — the WebSite entity is carried by the homepage instead.
export function buildBlogIndexHead(input: { title: string; url: string; description?: string }): string {
  const tags = [
    `<link rel="canonical" href="${escapeAttr(input.url)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${escapeAttr(input.title)}">`,
    `<meta property="og:url" content="${escapeAttr(input.url)}">`
  ];
  if (input.description) tags.push(`<meta property="og:description" content="${escapeAttr(input.description)}">`);
  tags.push(`<meta name="twitter:card" content="summary">`);
  return tags.join("\n");
}

// Homepage HTML is arbitrary agent-authored content, so source OG values from project METADATA
// (title/summary), never by parsing the body, and inject each kind only when the page lacks it —
// the author's own tags always win.
export function buildHomepageSeoTags(html: string, input: { title: string; description?: string; url: string }): string {
  const tags: string[] = [];
  if (!/<link\s+[^>]*rel=["']canonical["']/i.test(html)) tags.push(`<link rel="canonical" href="${escapeAttr(input.url)}">`);
  if (!/<meta\s+[^>]*property=["']og:/i.test(html)) {
    tags.push(`<meta property="og:type" content="website">`);
    tags.push(`<meta property="og:title" content="${escapeAttr(input.title)}">`);
    if (input.description) tags.push(`<meta property="og:description" content="${escapeAttr(input.description)}">`);
    tags.push(`<meta property="og:url" content="${escapeAttr(input.url)}">`);
    tags.push(`<meta name="twitter:card" content="summary_large_image">`);
  }
  if (!/<script\s+[^>]*type=["']application\/ld\+json["']/i.test(html)) {
    tags.push(jsonLdScript({ "@context": "https://schema.org", "@type": "WebSite", name: input.title, url: input.url }));
  }
  return tags.join("\n");
}

// Insert a tag block at the end of <head> (or prepend if there is no head), mirroring the
// existing canonical-link injection.
export function injectHeadHtml(html: string, tagsBlock: string): string {
  if (!tagsBlock) return html;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${tagsBlock}\n</head>`);
  return `${tagsBlock}\n${html}`;
}
