import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { gitChildEnv } from "../child-env.js";
import type { ToolContext, ToolModule } from "../types.js";
import { legacyDelegatedTools } from "./legacy-delegate.js";
import { resolveProjectGitPath, runProjectGitCommand } from "./project-dev.js";

const execFileAsync = promisify(execFile);
const maxLogBytes = 60000;

const gitStatusSchema = z.object({
  projectId: z.string().min(8).max(80).optional()
});

const gitDiffSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  path: z.string().min(1).max(500).optional(),
  cached: z.boolean().optional().default(false),
  stat: z.boolean().optional().default(false)
});

const gitCommitSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  message: z.string().min(1).max(5000).optional(),
  all: z.boolean().optional().default(false),
  amend: z.boolean().optional().default(false),
  allowEmpty: z.boolean().optional().default(false),
  path: z.string().min(1).max(500).optional()
});

// A leading dash lets a value masquerade as a git option (e.g.
// `--receive-pack=<cmd>`/`--upload-pack=<cmd>`), which is argument injection
// reaching command execution. These are positional args with no `--` guard,
// so reject any leading-dash value at the schema boundary.
const noLeadingDash = (label: string, max: number) =>
  z.string().min(1).max(max).refine((v) => !v.startsWith("-"), { message: `${label} must not start with '-'.` });

const gitPushSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  remote: noLeadingDash("remote", 120).optional(),
  source: noLeadingDash("source", 240).optional(),
  setUpstream: z.boolean().optional().default(false),
  forceWithLease: z.boolean().optional().default(false),
  all: z.boolean().optional().default(false)
});

function trimOutput(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= maxLogBytes) return normalized;
  return `${normalized.slice(0, maxLogBytes)}... [truncated]`;
}

async function runGit(ctx: ToolContext, projectId: string | undefined, args: string[]): Promise<{ stdout: string; stderr: string; cwd: string }> {
  if (projectId) return runProjectGitCommand(ctx, projectId, args);
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd: ctx.workspaceRoot,
    timeout: ctx.commandTimeoutMs,
    maxBuffer: 1024 * 1024,
    env: gitChildEnv()
  });
  return { stdout, stderr, cwd: ctx.workspaceRoot };
}

async function resolveGitPath(ctx: ToolContext, projectId: string | undefined, relativePath: string): Promise<string> {
  if (projectId) return resolveProjectGitPath(ctx, projectId, relativePath);
  if (path.isAbsolute(relativePath)) throw new Error("Absolute git paths are not allowed.");
  if (relativePath.split(/[\\/]/).includes("..")) throw new Error("Path traversal is not allowed.");
  const resolvedRoot = await realpath(ctx.workspaceRoot);
  const candidate = path.resolve(resolvedRoot, relativePath);
  // Resolve symlinks on the deepest existing component before the containment check
  // so a symlink inside the workspace can't redirect a git pathspec outside it
  // (lexical startsWith alone would miss this, unlike the project branch).
  let existing = candidate;
  const missing: string[] = [];
  while (existing !== resolvedRoot) {
    try {
      await stat(existing);
      break;
    } catch {
      missing.unshift(path.basename(existing));
      existing = path.dirname(existing);
    }
  }
  const resolvedExisting = await realpath(existing);
  const resolved = missing.length ? path.join(resolvedExisting, ...missing) : resolvedExisting;
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Path is outside the workspace.");
  }
  return path.relative(resolvedRoot, resolved).replaceAll("\\", "/");
}

function gitResult(summary: string, cwd: string, stdout: string, stderr: string) {
  return {
    ok: true,
    summary,
    artifacts: [],
    structuredContent: { cwd },
    logs: [trimOutput(stdout), trimOutput(stderr)].filter(Boolean),
    errors: []
  };
}

const projectAwareGitTools: ToolModule[] = [
  {
    definition: {
      name: "git_status",
      description: "Show git status in the configured workspace or in a project-bound Git repository.",
      inputSchema: { type: "object", properties: { projectId: { type: "string", description: "Optional projectId bound with bind_project_workspace." } }, additionalProperties: false }
    },
    enabledByDefault: true,
    schema: gitStatusSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof gitStatusSchema>;
      const { stdout, stderr, cwd } = await runGit(ctx, parsed.projectId, ["status", "--short"]);
      return gitResult("Ran git status.", cwd, stdout || "(clean)", stderr);
    }
  },
  {
    definition: {
      name: "git_diff",
      description: "Show git diff in the configured workspace or a project-bound Git repository.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Optional projectId bound with bind_project_workspace." },
          path: { type: "string", description: "Optional repository-relative path." },
          cached: { type: "boolean", description: "Show staged diff only." },
          stat: { type: "boolean", description: "Show diff stat instead of patch." }
        },
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: gitDiffSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof gitDiffSchema>;
      const args = ["diff"];
      if (parsed.cached) args.push("--cached");
      if (parsed.stat) args.push("--stat");
      if (parsed.path) args.push("--", await resolveGitPath(ctx, parsed.projectId, parsed.path));
      const { stdout, stderr, cwd } = await runGit(ctx, parsed.projectId, args);
      return gitResult("Ran git diff.", cwd, stdout || "(no diff)", stderr);
    }
  },
  {
    definition: {
      name: "git_commit",
      description: "Create or amend a commit in the configured workspace or a project-bound Git repository.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Optional projectId bound with bind_project_workspace." },
          message: { type: "string" },
          all: { type: "boolean" },
          amend: { type: "boolean" },
          allowEmpty: { type: "boolean" },
          path: { type: "string" }
        },
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: gitCommitSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof gitCommitSchema>;
      if (!parsed.amend && !parsed.message) throw new Error("message is required unless amend is true.");
      const args = ["commit"];
      if (parsed.all) args.push("-a");
      if (parsed.allowEmpty) args.push("--allow-empty");
      if (parsed.amend) {
        args.push("--amend");
        if (parsed.message) args.push("-m", parsed.message);
        else args.push("--no-edit");
      } else if (parsed.message) {
        args.push("-m", parsed.message);
      }
      if (parsed.path) args.push("--only", "--", await resolveGitPath(ctx, parsed.projectId, parsed.path));
      const { stdout, stderr, cwd } = await runGit(ctx, parsed.projectId, args);
      return gitResult(parsed.amend ? "Amended git commit." : "Created git commit.", cwd, stdout, stderr);
    }
  },
  {
    definition: {
      name: "git_push",
      description: "Push from the configured workspace or a project-bound Git repository.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Optional projectId bound with bind_project_workspace." },
          remote: { type: "string" },
          source: { type: "string" },
          setUpstream: { type: "boolean" },
          forceWithLease: { type: "boolean" },
          all: { type: "boolean" }
        },
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: gitPushSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof gitPushSchema>;
      const args = ["push"];
      if (parsed.forceWithLease) args.push("--force-with-lease");
      if (parsed.setUpstream) args.push("--set-upstream");
      if (parsed.all) args.push("--all");
      else {
        if (parsed.remote) args.push(parsed.remote);
        if (parsed.source) args.push(parsed.source);
      }
      const { stdout, stderr, cwd } = await runGit(ctx, parsed.projectId, args);
      return gitResult("Ran git push.", cwd, stdout, stderr);
    }
  }
];

const legacyGitToolNames = [
  "git_show",
  "git_blame",
  "git_checkout",
  "git_branch",
  "git_stash",
  "git_tag",
  "git_add",
  "git_reset",
  "git_rebase",
  "git_bisect",
  "git_cherry_pick",
  "git_ls_files",
  "git_submodule",
  "git_notes",
  "git_worktree",
  "git_config",
  "git_archive",
  "git_diff_staged",
  "git_merge_base",
  "git_count_objects",
  "git_verify_pack",
  "git_fsck",
  "git_reflog",
  "git_maintenance",
  "git_prune",
  "git_repack",
  "git_show_ref",
  "git_symbolic_ref",
  "git_for_each_ref",
  "git_update_ref",
  "git_gc",
  "git_name_rev",
  "git_cat_file",
  "git_check_ref_format",
  "git_rev_parse",
  "git_lfs",
  "git_clean",
  "git_clone",
  "git_init",
  "git_revert",
  "git_stash_apply",
  "git_stash_pop",
  "git_fetch",
  "git_merge",
  "git_pull",
  "git_remote",
  "git_log"
] as const;

export const gitTools = [
  ...projectAwareGitTools,
  ...legacyDelegatedTools(legacyGitToolNames)
];
