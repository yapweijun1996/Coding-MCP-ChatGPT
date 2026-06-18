import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderMarkdown } from "../src/blog/markdown.js";
import { initializeBlogStore, upsertBlogPost, getBlogPostBySlug, listBlogPosts, deleteBlogPost, setBlogTheme, slugify } from "../src/blog/store.js";
import { blogTools } from "../src/mcp/tools/blog.js";

const root = await mkdtemp(path.join(os.tmpdir(), "coding-mcp-blog-"));
process.env.ADMIN_PASSCODE = "test-admin-passcode";
process.env.ADMIN_EMAIL = "admin@example.test";
process.env.ADMIN_PASSWORD = "test-admin-password";
process.env.PUBLIC_BASE_URL = "https://example.test";
process.env.WORKSPACE_ROOT = path.join(root, "workspace");
process.env.SHARE_ROOT = path.join(root, "shares");
process.env.ARTIFACT_ROOT = path.join(root, "artifacts");
process.env.PROJECT_ROOT = path.join(root, "projects");
process.env.USERS_ROOT = path.join(root, "users");
process.env.USER_STATE_PATH = path.join(root, "state", "users-state.json");
process.env.SKILL_STATE_PATH = path.join(root, "state", "skill-state.json");
process.env.SITE_STATE_PATH = path.join(root, "state", "site-state.json");
process.env.BLOG_STATE_PATH = path.join(root, "state", "blog-state.json");
process.env.OAUTH_STATE_PATH = path.join(root, "state", "oauth-state.json");
process.env.ADMIN_UI_DIST = path.join(root, "missing-admin-dist");

const { app } = await import("../src/server.js");
const { getUserById } = await import("../src/user-store.js");

async function withServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("markdown renderer escapes HTML and renders a safe subset", () => {
  const html = renderMarkdown("# Title\n\nHello **bold** and `code`.\n\n- one\n- two\n\n[link](https://ok.test) and [bad](javascript:alert(1))");
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<a href="https:\/\/ok\.test"/);
  // javascript: URLs are neutralized to #
  assert.match(html, /<a href="#"/);
  // raw HTML in source must be escaped, never emitted as a tag
  const xss = renderMarkdown("<script>alert(1)</script>");
  assert.doesNotMatch(xss, /<script>/);
  assert.match(xss, /&lt;script&gt;/);
});

test("slugify produces url-safe slugs", () => {
  assert.equal(slugify("Hello, World! 2026"), "hello-world-2026");
  assert.ok(slugify("@@@").startsWith("post-"));
});

test("blog store upserts, lists, fetches, and deletes posts (file mode)", async () => {
  await initializeBlogStore({ statePath: path.join(root, "state", "blog-unit.json") });
  const created = await upsertBlogPost({ title: "First Post", content: "# Hi\n\nBody", tags: ["news"] });
  assert.equal(created.slug, "first-post");
  assert.equal(created.status, "published");
  assert.ok(created.publishedAt);

  const updated = await upsertBlogPost({ title: "First Post", content: "# Hi\n\nUpdated body", excerpt: "Summary" });
  assert.equal(updated.id, created.id, "upsert by slug keeps the same id");
  assert.equal(updated.excerpt, "Summary");

  const draft = await upsertBlogPost({ title: "Draft One", content: "x", status: "draft" });
  assert.equal(draft.publishedAt, null);

  const published = await listBlogPosts({ status: "published" });
  assert.equal(published.length, 1);
  assert.equal((await listBlogPosts()).length, 2);

  const fetched = await getBlogPostBySlug("first-post");
  assert.equal(fetched?.content, "# Hi\n\nUpdated body");

  assert.equal(await deleteBlogPost("first-post"), true);
  assert.equal(await getBlogPostBySlug("first-post"), undefined);
});

test("blog routes render index and post, and gate writes to admins", async () => {
  await initializeBlogStore({ statePath: process.env.BLOG_STATE_PATH! });
  await setBlogTheme({ title: "Acme Blog" });

  const publishTool = blogTools.find((tool) => tool.definition.name === "publish_blog_post");
  assert.ok(publishTool);
  const ctxBase = { publicBaseUrl: "https://example.test", workspaceRoot: root, commandTimeoutMs: 1000, shareRoot: root, artifactRoot: root, projectRoot: root, clientId: "test" };

  // non-admin (no userId) is rejected
  const denied = await publishTool.handler({ title: "Nope", content: "x" }, { ...ctxBase, userId: undefined });
  assert.equal(denied.ok, false);

  await withServer(async (baseUrl) => {
    // find the admin user id via the admin API session
    const login = await fetch(`${baseUrl}/admin/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin@example.test", password: "test-admin-password" }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const session = await (await fetch(`${baseUrl}/admin/api/session`, { headers: { Cookie: cookie } })).json() as { user?: { id?: string } };
    const adminId = session.user?.id;
    assert.ok(adminId);
    assert.equal((await getUserById(adminId)).role, "admin");

    const created = await publishTool.handler({ title: "Hello Blog", content: "# Heading\n\nThis is **markdown**." }, { ...ctxBase, userId: adminId });
    assert.equal(created.ok, true);

    const index = await fetch(`${baseUrl}/blog/`);
    assert.equal(index.status, 200);
    const indexHtml = await index.text();
    assert.match(indexHtml, /Acme Blog/);
    assert.match(indexHtml, /Hello Blog/);
    assert.match(indexHtml, /href="\/blog\/hello-blog"/);

    const postRes = await fetch(`${baseUrl}/blog/hello-blog`);
    assert.equal(postRes.status, 200);
    const postHtml = await postRes.text();
    assert.match(postHtml, /<h1>Heading<\/h1>/);
    assert.match(postHtml, /<strong>markdown<\/strong>/);
    assert.ok((postRes.headers.get("content-security-policy") ?? "").includes("default-src"));

    const missing = await fetch(`${baseUrl}/blog/does-not-exist`);
    assert.equal(missing.status, 404);

    // RSS feed lists the published post.
    const rss = await fetch(`${baseUrl}/blog/rss.xml`);
    assert.equal(rss.status, 200);
    assert.match(rss.headers.get("content-type") ?? "", /rss\+xml/);
    const rssBody = await rss.text();
    assert.match(rssBody, /<rss version="2.0">/);
    assert.match(rssBody, /<link>https:\/\/example\.test\/blog\/hello-blog<\/link>/);

    // Default landing links to the blog.
    assert.match(await (await fetch(`${baseUrl}/`)).text(), /href="\/blog\/"/);
  });
});

test("admin API lists, deletes blog posts and saves the theme", async () => {
  await initializeBlogStore({ statePath: process.env.BLOG_STATE_PATH! });
  await upsertBlogPost({ title: "Admin Managed", content: "body", tags: ["ops"] });
  await withServer(async (baseUrl) => {
    const login = await fetch(`${baseUrl}/admin/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin@example.test", password: "test-admin-password" }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const csrf = (await login.json() as { csrfToken: string }).csrfToken;
    const headers = { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf };

    const list = await (await fetch(`${baseUrl}/admin/api/blog/posts`, { headers: { Cookie: cookie } })).json() as { posts: Array<{ slug: string }> };
    assert.ok(list.posts.some((post) => post.slug === "admin-managed"));

    // Saving the theme requires CSRF.
    const noCsrf = await fetch(`${baseUrl}/admin/api/blog/theme`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ title: "X" }) });
    assert.equal(noCsrf.status, 403);

    const themeRes = await fetch(`${baseUrl}/admin/api/blog/theme`, { method: "POST", headers, body: JSON.stringify({ title: "Ops Blog" }) });
    assert.equal(themeRes.status, 200);
    assert.equal((await themeRes.json() as { theme: { title: string } }).theme.title, "Ops Blog");

    const del = await fetch(`${baseUrl}/admin/api/blog/posts/admin-managed`, { method: "DELETE", headers });
    assert.equal(del.status, 200);
    const after = await (await fetch(`${baseUrl}/admin/api/blog/posts`, { headers: { Cookie: cookie } })).json() as { posts: Array<{ slug: string }> };
    assert.ok(!after.posts.some((post) => post.slug === "admin-managed"));
  });
});
