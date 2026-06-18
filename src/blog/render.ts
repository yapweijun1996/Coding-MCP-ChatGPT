import type { BlogPost, BlogTheme } from "./store.js";
import { renderMarkdown, escapeBlogHtml as escapeHtml } from "./markdown.js";

const baseCss = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; line-height: 1.65; color: #1a201c; background: #fafbfa; }
  .blog-wrap { width: min(760px, calc(100vw - 32px)); margin: 0 auto; padding: 48px 0 80px; }
  .blog-header { margin-bottom: 40px; }
  .blog-header a { color: inherit; text-decoration: none; }
  .blog-title { font-size: clamp(28px, 5vw, 40px); margin: 0; }
  article.post-card { padding: 24px 0; border-bottom: 1px solid #e3e8e2; }
  article.post-card h2 { margin: 0 0 6px; font-size: 22px; }
  article.post-card h2 a { color: #16615a; text-decoration: none; }
  .post-meta { color: #6b756c; font-size: 14px; margin: 0 0 10px; }
  .post-excerpt { margin: 0; color: #2c352e; }
  .post-body img { max-width: 100%; height: auto; }
  .post-body pre { background: #f0f3ef; padding: 14px; border-radius: 8px; overflow-x: auto; }
  .post-body code { background: #eef1eb; padding: 2px 5px; border-radius: 4px; }
  .post-body pre code { background: none; padding: 0; }
  .post-body blockquote { margin: 16px 0; padding: 8px 16px; border-left: 3px solid #16615a; color: #41504a; }
  .blog-back { display: inline-block; margin-bottom: 20px; color: #16615a; text-decoration: none; font-weight: 650; }
  .blog-empty { color: #6b756c; }
`;

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function shell(theme: BlogTheme, bodyInner: string, pageTitle: string, metaDescription?: string): string {
  const title = escapeHtml(theme.title || "Blog");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(pageTitle)}</title>
${metaDescription ? `<meta name="description" content="${escapeHtml(metaDescription)}">` : ""}
<style>${baseCss}\n${theme.css || ""}</style>
</head>
<body>
<div class="blog-wrap">
<header class="blog-header">${theme.headerHtml || `<a href="/blog/"><h1 class="blog-title">${title}</h1></a>`}</header>
${bodyInner}
${theme.footerHtml ? `<footer class="blog-footer">${theme.footerHtml}</footer>` : ""}
</div>
</body>
</html>`;
}

export function renderBlogIndex(posts: BlogPost[], theme: BlogTheme): string {
  const cards = posts.length === 0
    ? `<p class="blog-empty">No posts published yet.</p>`
    : posts.map((post) => `
      <article class="post-card">
        <h2><a href="/blog/${escapeHtml(post.slug)}">${escapeHtml(post.title)}</a></h2>
        <p class="post-meta">${formatDate(post.publishedAt ?? post.createdAt)}${post.tags.length ? ` · ${post.tags.map((tag) => escapeHtml(tag)).join(", ")}` : ""}</p>
        ${post.excerpt ? `<p class="post-excerpt">${escapeHtml(post.excerpt)}</p>` : ""}
      </article>`).join("");
  return shell(theme, cards, theme.title || "Blog");
}

export function renderBlogPost(post: BlogPost, theme: BlogTheme): string {
  const body = `
    <a class="blog-back" href="/blog/">← All posts</a>
    <article class="post-full">
      <h1>${escapeHtml(post.title)}</h1>
      <p class="post-meta">${formatDate(post.publishedAt ?? post.createdAt)}${post.tags.length ? ` · ${post.tags.map((tag) => escapeHtml(tag)).join(", ")}` : ""}</p>
      <div class="post-body">${renderMarkdown(post.content)}</div>
    </article>`;
  return shell(theme, body, `${post.title} — ${theme.title || "Blog"}`, post.seoDescription ?? post.excerpt ?? undefined);
}
