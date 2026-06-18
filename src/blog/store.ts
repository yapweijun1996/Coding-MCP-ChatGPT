import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

export type BlogPostStatus = "draft" | "published";
export type BlogPostFormat = "markdown" | "html";

export interface BlogPost {
  id: string;
  slug: string;
  title: string;
  content: string; // markdown source or sanitized-on-render HTML, per `format`
  format: BlogPostFormat;
  excerpt: string;
  coverImageUrl: string | null;
  tags: string[];
  seoDescription: string | null;
  authorUserId: string | null;
  status: BlogPostStatus;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

export interface BlogTheme {
  title: string;
  css: string;
  headerHtml: string;
  footerHtml: string;
}

export interface BlogUpsertInput {
  title: string;
  content: string;
  format?: BlogPostFormat;
  slug?: string;
  excerpt?: string;
  coverImageUrl?: string | null;
  tags?: string[];
  seoDescription?: string | null;
  authorUserId?: string | null;
  status?: BlogPostStatus;
}

interface BlogStateFile {
  version: 1;
  posts: BlogPost[];
  theme: BlogTheme;
}

const defaultTheme: BlogTheme = { title: "Blog", css: "", headerHtml: "", footerHtml: "" };

let pool: pg.Pool | undefined;
let statePath = path.join(process.cwd(), ".state", "blog-state.json");
let memory: BlogStateFile = { version: 1, posts: [], theme: { ...defaultTheme } };
let loaded = false;

function nowIso(): string {
  return new Date().toISOString();
}

export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return base || `post-${randomUUID().slice(0, 8)}`;
}

async function loadFileState(): Promise<void> {
  if (loaded) return;
  memory = { version: 1, posts: [], theme: { ...defaultTheme } };
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as Partial<BlogStateFile>;
    if (parsed && typeof parsed === "object") {
      memory.posts = Array.isArray(parsed.posts) ? parsed.posts as BlogPost[] : [];
      memory.theme = { ...defaultTheme, ...(parsed.theme ?? {}) };
    }
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
    if (code !== "ENOENT") throw error;
  }
  loaded = true;
}

async function persistFileState(): Promise<void> {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(memory, null, 2)}\n`, "utf8");
}

function mapRow(row: Record<string, unknown>): BlogPost {
  return {
    id: String(row.id),
    slug: String(row.slug),
    title: String(row.title),
    content: String(row.content),
    format: row.format === "html" ? "html" : "markdown",
    excerpt: String(row.excerpt ?? ""),
    coverImageUrl: row.cover_image_url ? String(row.cover_image_url) : null,
    tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
    seoDescription: row.seo_description ? String(row.seo_description) : null,
    authorUserId: row.author_user_id ? String(row.author_user_id) : null,
    status: row.status === "published" ? "published" : "draft",
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    publishedAt: row.published_at ? (row.published_at instanceof Date ? row.published_at.toISOString() : String(row.published_at)) : null
  };
}

export async function initializeBlogStore(input: { databaseUrl?: string; statePath: string }): Promise<void> {
  statePath = input.statePath;
  loaded = false;
  if (input.databaseUrl) {
    pool = new pg.Pool({ connectionString: input.databaseUrl });
    await pool.query(`
      create table if not exists blog_posts (
        id text primary key,
        slug text not null unique,
        title text not null,
        content text not null,
        excerpt text not null default '',
        cover_image_url text,
        tags text[] not null default '{}',
        seo_description text,
        author_user_id text,
        status text not null check (status in ('draft', 'published')),
        created_at timestamptz not null,
        updated_at timestamptz not null,
        published_at timestamptz
      );
    `);
    // Backward-compatible column add for databases created before `format` existed.
    await pool.query("alter table blog_posts add column if not exists format text not null default 'markdown'");
  } else {
    pool = undefined;
    await loadFileState();
  }
  // Theme always lives in the JSON config file (small, set-rarely config).
  await loadFileState();
}

export async function listBlogPosts(options: { status?: BlogPostStatus } = {}): Promise<BlogPost[]> {
  if (pool) {
    const params: unknown[] = [];
    let where = "";
    if (options.status) { where = "where status = $1"; params.push(options.status); }
    const result = await pool.query(`select * from blog_posts ${where} order by coalesce(published_at, created_at) desc`, params);
    return result.rows.map(mapRow);
  }
  await loadFileState();
  const posts = options.status ? memory.posts.filter((post) => post.status === options.status) : memory.posts;
  return [...posts].sort((a, b) => (b.publishedAt ?? b.createdAt).localeCompare(a.publishedAt ?? a.createdAt));
}

export async function getBlogPostBySlug(slug: string): Promise<BlogPost | undefined> {
  if (pool) {
    const result = await pool.query("select * from blog_posts where slug = $1", [slug]);
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }
  await loadFileState();
  return memory.posts.find((post) => post.slug === slug);
}

export async function upsertBlogPost(input: BlogUpsertInput): Promise<BlogPost> {
  const slug = slugify(input.slug || input.title);
  const status: BlogPostStatus = input.status === "draft" ? "draft" : "published";
  const existing = await getBlogPostBySlug(slug);
  const now = nowIso();
  const post: BlogPost = {
    id: existing?.id ?? randomUUID(),
    slug,
    title: input.title,
    content: input.content,
    format: input.format ?? existing?.format ?? "markdown",
    excerpt: input.excerpt ?? existing?.excerpt ?? "",
    coverImageUrl: input.coverImageUrl ?? existing?.coverImageUrl ?? null,
    tags: input.tags ?? existing?.tags ?? [],
    seoDescription: input.seoDescription ?? existing?.seoDescription ?? null,
    authorUserId: input.authorUserId ?? existing?.authorUserId ?? null,
    status,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    publishedAt: status === "published" ? (existing?.publishedAt ?? now) : null
  };

  if (pool) {
    await pool.query(`
      insert into blog_posts (id, slug, title, content, format, excerpt, cover_image_url, tags, seo_description, author_user_id, status, created_at, updated_at, published_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      on conflict (slug) do update set
        title = excluded.title, content = excluded.content, format = excluded.format, excerpt = excluded.excerpt,
        cover_image_url = excluded.cover_image_url, tags = excluded.tags, seo_description = excluded.seo_description,
        status = excluded.status, updated_at = excluded.updated_at, published_at = excluded.published_at
    `, [post.id, post.slug, post.title, post.content, post.format, post.excerpt, post.coverImageUrl, post.tags, post.seoDescription, post.authorUserId, post.status, post.createdAt, post.updatedAt, post.publishedAt]);
    return post;
  }

  await loadFileState();
  const index = memory.posts.findIndex((candidate) => candidate.slug === slug);
  if (index >= 0) memory.posts[index] = post;
  else memory.posts.push(post);
  await persistFileState();
  return post;
}

export async function deleteBlogPost(slug: string): Promise<boolean> {
  if (pool) {
    const result = await pool.query("delete from blog_posts where slug = $1", [slug]);
    return (result.rowCount ?? 0) > 0;
  }
  await loadFileState();
  const before = memory.posts.length;
  memory.posts = memory.posts.filter((post) => post.slug !== slug);
  const changed = memory.posts.length !== before;
  if (changed) await persistFileState();
  return changed;
}

export async function getBlogTheme(): Promise<BlogTheme> {
  await loadFileState();
  return { ...memory.theme };
}

export async function setBlogTheme(input: Partial<BlogTheme>): Promise<BlogTheme> {
  await loadFileState();
  memory.theme = {
    title: input.title ?? memory.theme.title,
    css: input.css ?? memory.theme.css,
    headerHtml: input.headerHtml ?? memory.theme.headerHtml,
    footerHtml: input.footerHtml ?? memory.theme.footerHtml
  };
  await persistFileState();
  return { ...memory.theme };
}
