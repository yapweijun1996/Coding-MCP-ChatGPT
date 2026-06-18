import { z } from "zod";
import type { ToolModule, ToolContext, ToolResult } from "../types.js";
import { getUserById } from "../../user-store.js";
import { deleteBlogPost, getBlogPostBySlug, listBlogPosts, setBlogTheme, upsertBlogPost } from "../../blog/store.js";

const publishSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(200000),
  format: z.enum(["markdown", "html"]).optional(),
  slug: z.string().min(1).max(120).optional(),
  excerpt: z.string().max(500).optional(),
  coverImageUrl: z.string().url().max(1000).optional(),
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
  seoDescription: z.string().max(300).optional(),
  status: z.enum(["draft", "published"]).optional()
});
const slugSchema = z.object({ slug: z.string().min(1).max(120) });
const listSchema = z.object({ status: z.enum(["draft", "published"]).optional() });
const themeSchema = z.object({
  title: z.string().max(120).optional(),
  css: z.string().max(60000).optional(),
  headerHtml: z.string().max(20000).optional(),
  footerHtml: z.string().max(20000).optional()
}).refine((value) => Object.keys(value).length > 0, { message: "Provide at least one theme field." });
const emptySchema = z.object({}).strip();

function blogUrl(ctx: ToolContext, slug?: string): string {
  const base = `${ctx.publicBaseUrl.replace(/\/$/, "")}/blog/`;
  return slug ? `${base}${slug}` : base;
}

async function requireAdmin(ctx: ToolContext): Promise<ToolResult | undefined> {
  const user = ctx.userId ? await getUserById(ctx.userId) : undefined;
  if (!user || user.role !== "admin") {
    return { ok: false, summary: "Only admins can manage the blog.", artifacts: [], logs: [], errors: ["Forbidden: admin role required."] };
  }
  return undefined;
}

export const blogTools: ToolModule[] = [
  {
    definition: {
      name: "publish_blog_post",
      description: "Create or update a blog post (Markdown content) stored in the database. Upserts by slug. Admin only.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Post title." },
          content: { type: "string", description: "Post body. Markdown by default, or HTML when format=html." },
          format: { type: "string", enum: ["markdown", "html"], description: "Content format. Defaults to markdown. HTML is sanitized on render (scripts/event handlers/unsafe URLs are stripped)." },
          slug: { type: "string", description: "URL slug; auto-generated from the title if omitted." },
          excerpt: { type: "string", description: "Short summary shown on the blog index." },
          coverImageUrl: { type: "string", description: "Optional cover image URL." },
          tags: { type: "array", items: { type: "string" }, description: "Optional tags." },
          seoDescription: { type: "string", description: "Optional meta description for SEO." },
          status: { type: "string", enum: ["draft", "published"], description: "Defaults to published." }
        },
        required: ["title", "content"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: publishSchema,
    handler: async (input, ctx) => {
      const denied = await requireAdmin(ctx);
      if (denied) return denied;
      const parsed = input as z.infer<typeof publishSchema>;
      const post = await upsertBlogPost({ ...parsed, authorUserId: ctx.userId ?? null });
      const url = blogUrl(ctx, post.slug);
      return { ok: true, summary: `Saved blog post "${post.title}" (${post.status}).`, previewUrl: post.status === "published" ? url : undefined, shareUrl: post.status === "published" ? url : undefined, artifacts: [], logs: [`Slug: ${post.slug}`, `URL: ${url}`], errors: [] };
    }
  },
  {
    definition: {
      name: "list_blog_posts",
      description: "List blog posts with their slugs, titles, and status.",
      inputSchema: { type: "object", properties: { status: { type: "string", enum: ["draft", "published"] } }, additionalProperties: false }
    },
    enabledByDefault: true,
    schema: listSchema,
    handler: async (input, _ctx) => {
      const { status } = input as z.infer<typeof listSchema>;
      const posts = await listBlogPosts({ status });
      const rows = posts.map((post) => ({ slug: post.slug, title: post.title, status: post.status, publishedAt: post.publishedAt, tags: post.tags }));
      return { ok: true, summary: `${posts.length} blog post(s).`, artifacts: [], logs: [JSON.stringify(rows, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "get_blog_post",
      description: "Get a single blog post (including its Markdown content) by slug.",
      inputSchema: { type: "object", properties: { slug: { type: "string" } }, required: ["slug"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: slugSchema,
    handler: async (input, _ctx) => {
      const { slug } = input as z.infer<typeof slugSchema>;
      const post = await getBlogPostBySlug(slug);
      if (!post) return { ok: false, summary: `No blog post with slug "${slug}".`, artifacts: [], logs: [], errors: ["Not found."] };
      return { ok: true, summary: `Loaded blog post "${post.title}".`, artifacts: [], logs: [JSON.stringify(post, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "delete_blog_post",
      description: "Delete a blog post by slug. Admin only.",
      inputSchema: { type: "object", properties: { slug: { type: "string" } }, required: ["slug"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: slugSchema,
    handler: async (input, ctx) => {
      const denied = await requireAdmin(ctx);
      if (denied) return denied;
      const { slug } = input as z.infer<typeof slugSchema>;
      const removed = await deleteBlogPost(slug);
      return { ok: removed, summary: removed ? `Deleted blog post "${slug}".` : `No blog post with slug "${slug}".`, artifacts: [], logs: [], errors: removed ? [] : ["Not found."] };
    }
  },
  {
    definition: {
      name: "set_blog_theme",
      description: "Customize the blog's appearance (title, CSS, header/footer HTML). The blog index and post pages are rendered into this theme. Admin only.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Blog title shown in the header." },
          css: { type: "string", description: "Custom CSS appended to the base stylesheet." },
          headerHtml: { type: "string", description: "Custom header HTML." },
          footerHtml: { type: "string", description: "Custom footer HTML." }
        },
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: themeSchema,
    handler: async (input, ctx) => {
      const denied = await requireAdmin(ctx);
      if (denied) return denied;
      const theme = await setBlogTheme(input as z.infer<typeof themeSchema>);
      return { ok: true, summary: "Blog theme updated.", previewUrl: blogUrl(ctx), artifacts: [], logs: [JSON.stringify(theme, null, 2)], errors: [] };
    }
  }
];
