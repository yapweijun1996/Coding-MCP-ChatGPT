import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, open, readFile, readlink, readdir, rename as renameFile, stat, unlink, writeFile } from "node:fs/promises";
import { createReadStream, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { saveJob } from "../jobs/store.js";
import {
  createProject,
  deleteProject,
  deleteProjectFile,
  getProjectWithFiles,
  listProjects,
  publishProject,
  readProjectFile,
  writeProjectFile
} from "../projects/store.js";
import { createShareArtifact } from "../share/store.js";
import { childEnv, gitChildEnv } from "./child-env.js";

const execFileAsync = promisify(execFile);

// Files that control script execution. Writing/replacing them turns a benign
// "write a file" capability into code execution via run_tests/run_build, so they
// are not writable through the workspace tools. NOTE: this only blocks the trivial
// write_file path — a cloned repo can still carry a poisoned package.json, so the
// real isolation guarantee comes from the scrubbed child env (no secrets), with
// full sandboxing (container/nsjail) as the complete fix.
const PROTECTED_WORKSPACE_BASENAMES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  ".npmrc",
]);

function assertWritableWorkspacePath(relativePath: string): void {
  const base = relativePath.split(/[\\/]+/).filter(Boolean).pop()?.toLowerCase() ?? "";
  if (PROTECTED_WORKSPACE_BASENAMES.has(base)) {
    throw new Error(`Refusing to modify protected file '${base}': it controls script execution and is not writable through workspace tools.`);
  }
}

// git config keys that may be written via git_config. Anything outside this set
// (core.pager, core.sshCommand, core.hooksPath, alias.*, credential.helper, …) can
// be coerced into command execution on the next git invocation, so writes are
// restricted to this safe allowlist. Reads (get/list) are unrestricted but forced
// to --local scope.
const WRITABLE_GIT_CONFIG_KEYS = new Set([
  "user.name",
  "user.email",
  "user.username",
  "init.defaultbranch",
  "commit.gpgsign",
  "tag.gpgsign",
  "pull.rebase",
  "push.default",
  "push.autosetupremote",
  "fetch.prune",
  "merge.ff",
  "rebase.autostash",
  "core.autocrlf",
  "core.safecrlf",
  "core.ignorecase",
  "core.filemode",
]);

export interface ToolResult {
  ok: boolean;
  summary: string;
  jobId?: string;
  previewUrl?: string;
  shareUrl?: string;
  artifacts: string[];
  logs: string[];
  errors: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolContext {
  publicBaseUrl: string;
  workspaceRoot: string;
  commandTimeoutMs: number;
  shareRoot: string;
  projectRoot: string;
  clientId: string;
  userId?: string;
  publicShareBasePath?: string;
}

export const toolDefinitions: ToolDefinition[] = [
  {
    name: "ping",
    description: "Check that the Coding MCP server is reachable.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Optional message to echo." }
      },
      additionalProperties: false
    }
  },
  {
    name: "create_preview",
    description: "Create a demo preview result and return an outcome URL.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        summary: { type: "string" }
      },
      required: ["title", "summary"],
      additionalProperties: false
    }
  },
  {
    name: "write_file",
    description: "Write a UTF-8 text file inside the configured workspace only.",
    inputSchema: {
      type: "object",
      properties: {
        relativePath: { type: "string", description: "Workspace-relative path. No absolute paths, dotfiles, or parent traversal." },
        content: { type: "string", description: "UTF-8 text content. Max 256 KiB." }
      },
      required: ["relativePath", "content"],
      additionalProperties: false
    }
  },
  {
    name: "list_dir",
    description: "List workspace files and folders under a relative path.",
    inputSchema: {
      type: "object",
      properties: {
        relativePath: { type: "string", description: "Workspace-relative path. No absolute paths, dotfiles, or parent traversal." },
        recursive: { type: "boolean", description: "Include nested children." },
        maxDepth: {
          type: "number",
          minimum: 1,
          maximum: 6,
          description: "Maximum recursion depth when recursive is true."
        },
        includeHidden: { type: "boolean", description: "Include dot-prefixed files/folders." }
      },
      required: ["relativePath"],
      additionalProperties: false
    }
  },
  {
    name: "read_file",
    description: "Read a UTF-8 text file from the configured workspace.",
    inputSchema: {
      type: "object",
      properties: {
        relativePath: { type: "string", description: "Workspace-relative path. No absolute paths, dotfiles, or parent traversal." },
        maxBytes: { type: "number", minimum: 1, maximum: 131072, description: "Max bytes to read." }
      },
      required: ["relativePath"],
      additionalProperties: false
    }
  },
  {
    name: "search_files",
    description: "Search workspace text files for a plain string or regex pattern.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query text or regex pattern." },
        path: { type: "string", description: "Workspace-relative path to search under." },
        useRegex: { type: "boolean", description: "Whether query should be treated as a regular expression." },
        caseSensitive: { type: "boolean", description: "Case-sensitive search." },
        maxResults: { type: "number", minimum: 1, maximum: 200, description: "Maximum matches to return." },
        maxDepth: { type: "number", minimum: 1, maximum: 6, description: "Maximum recursion depth." },
        includeHidden: { type: "boolean", description: "Include dot-prefixed files/folders." }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "run_command",
    description: "Run a whitelisted npm command in the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          enum: ["npm test", "npm run build", "npm run typecheck"]
        }
      },
      required: ["command"],
      additionalProperties: false
    }
  },
  {
    name: "git_status",
    description: "Show git status in the configured workspace.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "git_diff",
    description: "Show git diff in the configured workspace, optionally scoped to a file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Optional workspace-relative path." },
        cached: { type: "boolean", description: "Show staged diff only." }
      },
      additionalProperties: false
    }
  },
  {
    name: "replace_in_file",
    description: "Replace text in a UTF-8 file inside the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        relativePath: { type: "string", description: "Workspace-relative path. No absolute paths, dotfiles, or parent traversal." },
        find: { type: "string", description: "Text to find." },
        replace: { type: "string", description: "Replacement text." },
        all: { type: "boolean", description: "Replace all occurrences (default: false)." }
      },
      required: ["relativePath", "find", "replace"],
      additionalProperties: false
    }
  },
  {
    name: "create_directory",
    description: "Create one or more directories inside the configured workspace.",
    inputSchema: {
      type: "object",
      properties: {
        relativePath: { type: "string", description: "Workspace-relative path. No absolute paths, dotfiles, or parent traversal." },
        recursive: { type: "boolean", description: "Create parent directories as needed." }
      },
      required: ["relativePath"],
      additionalProperties: false
    }
  },
  {
    name: "copy_file",
    description: "Copy a UTF-8 file inside the configured workspace.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Source workspace-relative path." },
        to: { type: "string", description: "Destination workspace-relative path." },
        overwrite: { type: "boolean", description: "Overwrite destination if it already exists." }
      },
      required: ["from", "to"],
      additionalProperties: false
    }
  },
  {
    name: "file_exists",
    description: "Check whether a path exists in the configured workspace.",
    inputSchema: {
      type: "object",
      properties: {
        relativePath: { type: "string", description: "Workspace-relative path. No absolute paths, dotfiles, or parent traversal." }
      },
      required: ["relativePath"],
      additionalProperties: false
    }
  },
  {
    name: "symlink_info",
    description: "Get symlink metadata for a workspace path.",
    inputSchema: {
      type: "object",
      properties: {
        relativePath: { type: "string", description: "Workspace-relative path. No absolute paths, dotfiles, or parent traversal." }
      },
      required: ["relativePath"],
      additionalProperties: false
    }
  },
  {
    name: "git_show",
    description: "Show the diff or content for a git reference in the configured workspace.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Commit hash, tag, branch, or HEAD~n reference." },
        path: { type: "string", description: "Optional workspace-relative path limit." }
      },
      required: ["ref"],
      additionalProperties: false
    }
  },
  {
    name: "git_blame",
    description: "Show git blame for a workspace file.",
    inputSchema: {
      type: "object",
      properties: {
        relativePath: { type: "string", description: "Workspace-relative file path." },
        ref: { type: "string", description: "Optional commit, tag, or branch to anchor blame." },
        lineStart: { type: "number", description: "Optional start line for a range." },
        lineEnd: { type: "number", description: "Optional end line for a range." }
      },
      required: ["relativePath"],
      additionalProperties: false
    }
  },
  {
    name: "chmod_mode",
    description: "Read or set permission mode for a workspace path.",
    inputSchema: {
      type: "object",
      properties: {
        relativePath: { type: "string", description: "Workspace-relative path. No absolute paths, dotfiles, or parent traversal." },
        mode: { type: "string", description: "Optional octal file mode, e.g. 755 or 0644." }
      },
      required: ["relativePath"],
      additionalProperties: false
    }
  },
  {
    name: "git_checkout",
    description: "Checkout an existing branch/ref or create-and-checkout a new branch.",
    inputSchema: {
      type: "object",
      properties: {
        branch: { type: "string", description: "Branch or ref to checkout." },
        create: { type: "boolean", description: "Create a new branch when true." },
        source: { type: "string", description: "Optional source for new branch creation (commit/tag/branch)." }
      },
      required: ["branch"],
      additionalProperties: false
    }
  },
  {
    name: "git_branch",
    description: "Manage local git branches.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "One of: list, create, delete, rename, current." },
        branch: { type: "string", description: "Branch name for create/delete/rename." },
        newName: { type: "string", description: "New branch name for rename." },
        startPoint: { type: "string", description: "Commit/ref/branch for create action." },
        force: { type: "boolean", description: "Force mode for delete/rename." },
        all: { type: "boolean", description: "Include remote branches when listing." }
      },
      required: ["action"],
      additionalProperties: false
    }
  },
  {
    name: "git_stash",
    description: "Run common git stash operations.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "One of: list, push, pop, apply, drop, clear." },
        message: { type: "string", description: "Optional stash message (push action)." },
        ref: { type: "string", description: "Optional stash ref (e.g., stash@{0}) for pop/apply/drop." },
        path: { type: "string", description: "Optional workspace-relative path for push action." }
      },
      required: ["action"],
      additionalProperties: false
    }
  },
  {
    name: "git_tag",
    description: "Manage git tags in the workspace repository.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "One of: list, create, delete, show, current." },
        name: { type: "string", description: "Tag name for create/delete/show." },
        target: { type: "string", description: "Commit/ref/branch to tag for create action." },
        message: { type: "string", description: "Tag annotation message for create action." },
        force: { type: "boolean", description: "Force mode for create/delete." }
      },
      required: ["action"],
      additionalProperties: false
    }
  },
  {
    name: "git_add",
    description: "Stage changes in the workspace git repository.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Optional workspace-relative path to add." },
        all: { type: "boolean", description: "Use --all to stage all changes." },
        update: { type: "boolean", description: "Use -u to stage tracked file updates only." }
      },
      required: [],
      additionalProperties: false
    }
  },
  {
    name: "git_reset",
    description: "Reset HEAD/index/working tree with optional target and path scope.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Optional commit/ref or HEAD~N target." },
        mode: { type: "string", description: "Reset mode: soft/mixed/hard." },
        path: { type: "string", description: "Optional workspace-relative path for path-scoped reset." }
      },
      required: [],
      additionalProperties: false
    }
  },
  {
    name: "git_rebase",
    description: "Run git rebase operations.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "One of: start, continue, abort, skip." },
        upstream: { type: "string", description: "Base branch/ref for start action (e.g., origin/main)." },
        onto: { type: "string", description: "Optional --onto target for start action." }
      },
      required: ["action"],
      additionalProperties: false
    }
  },
  {
    name: "git_bisect",
    description: "Run git bisect to locate faulty commits.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "One of: start, bad, good, skip, reset, log." },
        bad: { type: "string", description: "Commit ref to mark as bad (start or bad action)." },
        good: { type: "string", description: "Commit ref to mark as good (start or good action)." },
        commit: { type: "string", description: "Commit ref to mark in bad/good/skip action." },
        resetRef: { type: "string", description: "Ref to reset to for action=reset (default: --abort behavior omitted)." }
      },
      required: ["action"],
      additionalProperties: false
    }
  },
  {
    name: "git_cherry_pick",
    description: "Apply existing commits by hash, or operate on ongoing cherry-pick state.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "One of: pick, continue, abort, skip." },
        commit: { type: "string", description: "Commit hash/ref to pick (required for pick)." },
        noCommit: { type: "boolean", description: "Use --no-commit for pick action." },
        signoff: { type: "boolean", description: "Add Signed-off-by line for pick action." },
        mainline: { type: "number", description: "Use --mainline for merge commits." },
        noVerify: { type: "boolean", description: "Pass --no-verify for pick action." }
      },
      required: ["action"],
      additionalProperties: false
    }
  },
  {
    name: "git_ls_files",
    description: "List tracked/untracked/ignored files in the workspace git repository.",
    inputSchema: {
      type: "object",
      properties: {
        stage: { type: "boolean", description: "Show staged mode output with -s." },
        untracked: { type: "boolean", description: "Include untracked files with -o." },
        ignored: { type: "boolean", description: "Show ignored files with -i." },
        modified: { type: "boolean", description: "Show modified files with -m." },
        deleted: { type: "boolean", description: "Show deleted files with -d." },
        excludeStandard: { type: "boolean", description: "Apply --exclude-standard for -o mode." },
        path: { type: "string", description: "Optional workspace-relative pathspec filter." }
      },
      required: [],
      additionalProperties: false
    }
  },
  {
    name: "git_submodule",
    description: "Manage git submodules in the workspace repository.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "One of: init, status, update, sync, add, deinit." },
        path: { type: "string", description: "Submodule path for status/update/sync/deinit/add." },
        url: { type: "string", description: "Submodule URL for add action." },
        remote: { type: "boolean", description: "Use --remote for update." },
        recursive: { type: "boolean", description: "Use --recursive for status/update/sync/deinit." },
        force: { type: "boolean", description: "Use --force for deinit/add operations." }
      },
      required: ["action"],
      additionalProperties: false
    }
  },
  {
    name: "git_notes",
    description: "Manage Git notes on commits.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "One of: add, list, show, remove." },
        commit: { type: "string", description: "Commit hash/ref for add/show/remove." },
        message: { type: "string", description: "Note message for add action." },
        namespace: { type: "string", description: "Optional notes namespace." },
        scope: { type: "string", description: "Optional notes scope." }
      },
      required: ["action"],
      additionalProperties: false
    }
  },
  {
    name: "git_worktree",
    description: "Manage git worktrees in the workspace repository.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "One of: add, list, remove, move, lock, unlock, prune." },
        path: { type: "string", description: "Worktree path for add/remove/move/lock/unlock actions." },
        commit: { type: "string", description: "Commit/ref to checkout when adding." },
        branch: { type: "string", description: "Optional branch name for git worktree add." },
        force: { type: "boolean", description: "Force mode for add/remove." },
        noCheckout: { type: "boolean", description: "Use --no-checkout for add action." },
        newPath: { type: "string", description: "Target path for move action." }
      },
      required: ["action"],
      additionalProperties: false
    }
  },
  {
    name: "git_config",
    description: "Read and write git configuration values.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "One of: get, set, add, unset, list." },
        key: { type: "string", description: "Configuration key, required for get/set/add/unset." },
        value: { type: "string", description: "Configuration value, required for set/add." },
        scope: { type: "string", description: "One of: global, local, system. Optional for list too." }
      },
      required: ["action"],
      additionalProperties: false
    }
  },
  {
    name: "git_archive",
    description: "Create or list git archives for the repository.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "One of: create, list." },
        treeish: { type: "string", description: "Commit/ref/branch to archive (default: HEAD)." },
        format: { type: "string", description: "Archive format, e.g. tar or zip." },
        output: { type: "string", description: "Output file path for create action." },
        prefix: { type: "string", description: "Optional archive path prefix." },
        path: { type: "string", description: "Optional pathspec to limit archive content." }
      },
      required: ["action"],
      additionalProperties: false
    }
  },
  {
    name: "git_diff_staged",
    description: "Show staged (index) diff in the workspace repository.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Optional workspace-relative path." },
        stat: { type: "boolean", description: "Show stat summary instead of patch." }
      },
      required: [],
      additionalProperties: false
    }
  },
  {
    name: "git_merge_base",
    description: "Find merge base(s) between commits/branches.",
    inputSchema: {
      type: "object",
      properties: {
        commit: { type: "string", description: "Primary commit/ref (default: HEAD)." },
        other: { type: "string", description: "Second commit/ref to compare." },
        all: { type: "boolean", description: "List all merge bases with --all." },
        forkPoint: { type: "boolean", description: "Use --fork-point to restrict to fork-point semantics." }
      },
      required: [],
      additionalProperties: false
    }
  },
  {
    name: "git_count_objects",
    description: "Inspect repository object storage and packfile info.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "One of: count, size-pack." },
        verbose: { type: "boolean", description: "Use --verbose for detailed output." },
        humanReadable: { type: "boolean", description: "Use --human-readable when action=size-pack." },
        prune: { type: "boolean", description: "Prune loose objects before collecting size stats (size-pack only)." }
      },
      required: ["action"],
      additionalProperties: false
    }
  },
  {
    name: "git_verify_pack",
    description: "Verify a git pack file and optionally show per-object details.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "One of: verify, stats." },
        pack: { type: "string", description: "Path to .pack file (e.g., .git/objects/pack/pack-xxxxx.pack)." },
        verbose: { type: "boolean", description: "Show verbose object details for verify action." },
        all: { type: "boolean", description: "List all dangling objects with --all." },
        hashAlgo: { type: "string", description: "Optional hash algorithm suffix (sha1/sha256 in modern repos)." }
      },
      required: ["action", "pack"],
      additionalProperties: false
    }
  },
  {
    name: "git_fsck",
    description: "Run git fsck checks on repository object database.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "One of: check, full, connectivity, prune." },
        strict: { type: "boolean", description: "Use --strict mode." },
        verbose: { type: "boolean", description: "Use -v for verbose output." },
        pruneDate: { type: "string", description: "Optional date argument for --prune=<date> when action=prune." }
      },
      required: ["action"],
      additionalProperties: false
    }
  },
  {
    name: "git_reflog",
    description: "Inspect or expire git reflog entries.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "One of: show, expire, delete." },
        ref: { type: "string", description: "Reflog ref, e.g., HEAD or branch@{0}." },
        maxAge: { type: "string", description: "Expire cutoff timestamp or relative time for expire action." },
        all: { type: "boolean", description: "Use --all for expire action." },
        staleOnly: { type: "boolean", description: "Use --stale-fix for expire action." },
        rewrite: { type: "boolean", description: "Use --rewrite for delete action." },
        updateref: { type: "boolean", description: "Use --updateref for delete action." }
      },
      required: ["action"],
      additionalProperties: false
    }
  },
  {
    name: "git_maintenance",
    description: "Run or manage git maintenance tasks.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "One of: run, start, stop, status." },
        task: { type: "string", description: "Optional task for run action (eg: gc, commit-graph, loose-objects, incremental-repack, pack-refs)." },
        tasks: { type: "array", description: "Optional ordered task list for run action.", items: { type: "string" } }
      },
      required: ["action"],
      additionalProperties: false
    }
  },
  {
    name: "git_prune",
    description: "Prune unreachable objects from the git repository.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "One of: prune, dry-run." },
        expire: { type: "string", description: "Passed to --expire for prune action." },
        expireUnreachable: { type: "string", description: "Passed to --expire-unreachable for prune action." },
        progress: { type: "boolean", description: "Show progress with --progress." },
        verbose: { type: "boolean", description: "Show verbose output with -v." },
        includeAll: { type: "boolean", description: "Use --all for prune action." }
      },
      required: ["action"],
      additionalProperties: false
    }
  },
  {
    name: "git_repack",
    description: "Repack Git objects with optional pruning and compression controls.",
    inputSchema: {
      type: "object",
      properties: {
        all: { type: "boolean", description: "Use --all to repack all reachable objects." },
        window: { type: "number", description: "Sliding window size (integer)." },
        depth: { type: "number", description: "Maximum depth for delta compression." },
        aggressive: { type: "boolean", description: "Enable --aggressive repack." },
        noGc: { type: "boolean", description: "Use --no-gc to skip automatic gc." },
        keepPack: { type: "boolean", description: "Preserve old pack by using --keep-pack." },
        noPrune: { type: "boolean", description: "Use --no-prune for repack." },
        local: { type: "boolean", description: "Use --local for local objects only." },
        writeBitmapIndex: { type: "boolean", description: "Use --write-bitmap-index." },
        maxPackSize: { type: "string", description: "Pack file size limit for --max-pack-size." }
      },
      required: [],
      additionalProperties: false
    }
  },
  {
    name: "git_show_ref",
    description: "Show git refs and peeled ref values.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "One of: list, heads, tags." },
        dereference: { type: "boolean", description: "Show dereferenced targets with --dereference." },
        all: { type: "boolean", description: "Show all refs with --all." },
        heads: { type: "boolean", description: "Shorthand for heads action." },
        tags: { type: "boolean", description: "Shorthand for tags action." },
        quiet: { type: "boolean", description: "Use --quiet output mode." },
        abbrev: { type: "number", description: "Abbrev hash length with --abbrev." }
      },
      required: ["action"],
      additionalProperties: false
    }
  },
  {
    name: "git_symbolic_ref",
    description: "Read or update symbolic refs in the repository.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "One of: get, set, short, delete." },
        ref: { type: "string", description: "Symbolic ref name (e.g., HEAD)." },
        newRef: { type: "string", description: "Target ref when setting symbolic ref." },
        log: { type: "boolean", description: "Use --log for set/get output." },
        short: { type: "boolean", description: "Use --short for short output." },
        quiet: { type: "boolean", description: "Suppress message output for delete." }
      },
      required: ["action"],
      additionalProperties: false
    }
  },
  {
    name: "git_for_each_ref",
    description: "Iterate and filter refs with git for-each-ref.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "One of: heads, tags, remotes, all, pattern." },
        pattern: { type: "string", description: "Ref pattern when action=pattern (e.g., refs/heads/feature*)." },
        format: { type: "string", description: "Output format template for each ref." },
        sort: { type: "string", description: "Sort key for refs, e.g., committerdate." },
        count: { type: "number", description: "Limit number of returned refs." },
        contains: { type: "string", description: "Only refs containing this commit." },
        merged: { type: "string", description: "Only refs reachable from given commit/branch." },
        pointsAt: { type: "string", description: "Only refs pointing at object." },
        abbrev: { type: "number", description: "Abbrev hash length in output format." }
      },
      required: ["action"],
      additionalProperties: false
    }
  },
  {
    name: "git_update_ref",
    description: "Update, create, or delete refs directly.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "One of: create, update, delete, list." },
        ref: { type: "string", description: "Ref name to update/create/delete." },
        newValue: { type: "string", description: "New object id for create/update actions." },
        oldValue: { type: "string", description: "Expected old object id for CAS update." },
        reason: { type: "string", description: "Reason for reflog entry." },
        noDeref: { type: "boolean", description: "Use --no-deref." },
        noDerefFrom: { type: "boolean", description: "Use --no-deref-from." },
        force: { type: "boolean", description: "Use --no-deref?"}
      },
      required: ["action"],
      additionalProperties: false
    }
  },
  {
    name: "git_gc",
    description: "Run Git garbage collection tasks.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "One of: auto, prune, aggressive, rerere." },
        prune: { type: "string", description: "Prune older than (e.g., now, 1.day.ago)." },
        aggressive: { type: "boolean", description: "Enable --aggressive." },
        force: { type: "boolean", description: "Enable --force." }
      },
      required: ["action"],
      additionalProperties: false
    }
  },
  {
    name: "git_name_rev",
    description: "Resolve object name to a ref name using git name-rev.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "One of: resolve, all." },
        target: { type: "string", description: "Commit/object id for resolve action." },
        nameOnly: { type: "boolean", description: "Use --name-only." },
        tags: { type: "boolean", description: "Use --tags." },
        refs: { type: "boolean", description: "Use --refs." },
        noReflog: { type: "boolean", description: "Use --no-reflog." },
        all: { type: "boolean", description: "Use --all with all action." }
      },
      required: ["action"],
      additionalProperties: false
    }
  },
  {
    name: "git_cat_file",
    description: "Inspect Git object metadata and content with git cat-file.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "One of: type, size, pretty, exists." },
        object: { type: "string", description: "Object SHA or ref to inspect." }
      },
      required: ["action", "object"],
      additionalProperties: false
    }
  },
  {
    name: "git_check_ref_format",
    description: "Check and/or normalize a Git ref name format.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Ref name to validate or normalize." },
        normalize: { type: "boolean", description: "Return a normalized version with --normalize." },
        allowOneLevel: { type: "boolean", description: "Allow one-level ref names with --allow-onelevel." },
        branch: { type: "boolean", description: "Validate as a branch name with --branch." },
        noReflog: { type: "boolean", description: "Disallow reflog-like names with --no-reflog." }
      },
      required: ["ref"],
      additionalProperties: false
    }
  },
  {
    name: "git_rev_parse",
    description: "Resolve revision information with git rev-parse.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "One of: show-ref, is-inside-work-tree, is-bare-repository, short-sha, verify, default-branch." },
        value: { type: "string", description: "Object/ref value to parse." },
        short: { type: "number", minimum: 1, maximum: 64, description: "Output short SHA length with --short." },
        always: { type: "boolean", description: "Enable --quiet for verify action." }
      },
      required: ["action"],
      additionalProperties: false
    }
  },
  {
    name: "git_lfs",
    description: "Run Git LFS commands such as install, track, untrack, status, pull, push, fetch.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "One of: install, track, untrack, status, track-list, fetch, pull, push." },
        pattern: { type: "string", description: "File pattern for track/untrack actions." },
        remote: { type: "string", description: "Remote name for pull/push/fetch." },
        all: { type: "boolean", description: "Apply --all for pull/push/fetch." },
        include: { type: "string", description: "Include filter for fetch/pull/push commands." },
        exclude: { type: "string", description: "Exclude filter for fetch/pull/push commands." },
        verbose: { type: "boolean", description: "Verbose output when available." }
      },
      required: ["action"],
      additionalProperties: false
    }
  },
  {
    name: "git_clean",
    description: "Clean untracked files and/or directories in the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "One of: list, clean, clean-dirs, clean-ignored, clean-ignored-only." },
        pathspec: { type: "string", description: "Optional pathspec to limit cleaning." },
        force: { type: "boolean", description: "Force deletion (adds -f)." },
        includeIgnored: { type: "boolean", description: "Include ignored files with -x for clean action variants." },
        dryRun: { type: "boolean", description: "Alias for list preview; keeps no changes." },
        interactive: { type: "boolean", description: "Enable interactive prompt with -i." }
      },
      required: ["action"],
      additionalProperties: false
    }
  },
  {
    name: "git_clone",
    description: "Clone a remote git repository.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository URL or local path to clone." },
        branch: { type: "string", description: "Optional branch name to clone." },
        depth: { type: "number", description: "Shallow clone depth." },
        bare: { type: "boolean", description: "Create a bare repository." },
        singleBranch: { type: "boolean", description: "Use --single-branch." },
        noCheckout: { type: "boolean", description: "Do not checkout working tree." },
        outputDir: { type: "string", description: "Optional target directory for clone." }
      },
      required: ["repo"],
      additionalProperties: false
    }
  },
  {
    name: "git_init",
    description: "Create a new Git repository.",
    inputSchema: {
      type: "object",
      properties: {
        initDir: { type: "string", description: "Path where to initialize repo (default workspace root)." },
        bare: { type: "boolean", description: "Create a bare repository." },
        shared: { type: "boolean", description: "Enable shared repository mode." },
        initialBranch: { type: "string", description: "Initial branch name." }
      },
      required: [],
      additionalProperties: false
    }
  },
  {
    name: "git_revert",
    description: "Create new commits that revert specified commits.",
    inputSchema: {
      type: "object",
      properties: {
        commit: { type: "string", description: "Commit hash or range endpoint to revert." },
        mainline: { type: "number", description: "Mainline parent number for reverting merges." },
        noEdit: { type: "boolean", description: "Use --no-edit." },
        noCommit: { type: "boolean", description: "Apply changes without creating commit." }
      },
      required: ["commit"],
      additionalProperties: false
    }
  },
  {
    name: "git_stash_apply",
    description: "Apply a stash entry to the working tree.",
    inputSchema: {
      type: "object",
      properties: {
        stash: { type: "string", description: "Stash ref like stash@{0}. If omitted, defaults to stash@{0}." },
        index: { type: "boolean", description: "Apply staged changes from the index too." },
        keepIndex: { type: "boolean", description: "Deprecated alias for index, kept for compatibility." }
      },
      required: [],
      additionalProperties: false
    }
  },
  {
    name: "git_stash_pop",
    description: "Apply a stash entry and drop it from the stash list.",
    inputSchema: {
      type: "object",
      properties: {
        stash: { type: "string", description: "Stash ref like stash@{0}. If omitted, defaults to stash@{0}." },
        index: { type: "boolean", description: "Apply staged changes from the index too (--index)." },
        quiet: { type: "boolean", description: "Suppress informational output." },
        keepIndex: { type: "boolean", description: "Deprecated alias for index, kept for compatibility." }
      },
      required: [],
      additionalProperties: false
    }
  },
  {
    name: "git_fetch",
    description: "Fetch remote refs for the workspace git repository.",
    inputSchema: {
      type: "object",
      properties: {
        remote: { type: "string", description: "Remote name to fetch (default: origin)." },
        all: { type: "boolean", description: "Fetch all remotes when true." },
        prune: { type: "boolean", description: "Prune stale remote-tracking branches." },
        depth: { type: "number", minimum: 1, description: "Optional shallow fetch depth." }
      },
      required: [],
      additionalProperties: false
    }
  },
  {
    name: "git_merge",
    description: "Merge a branch/ref into the current branch.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Branch or commit to merge into current branch." },
        noFF: { type: "boolean", description: "Prefer --no-ff." },
        abort: { type: "boolean", description: "Abort an in-progress merge." }
      },
      required: [],
      additionalProperties: false
    }
  },
  {
    name: "git_pull",
    description: "Pull remote updates into the current branch.",
    inputSchema: {
      type: "object",
      properties: {
        remote: { type: "string", description: "Optional remote name." },
        source: { type: "string", description: "Optional source branch/ref (e.g., main)." },
        rebase: { type: "boolean", description: "Use --rebase." },
        ffOnly: { type: "boolean", description: "Use --ff-only." },
        all: { type: "boolean", description: "Fetch and merge all remotes before pulling (uses --all)." },
        prune: { type: "boolean", description: "Prune stale remote-tracking branches." },
        depth: { type: "number", minimum: 1, description: "Optional shallow fetch depth." }
      },
      required: [],
      additionalProperties: false
    }
  },
  {
    name: "git_push",
    description: "Push commits to a remote branch.",
    inputSchema: {
      type: "object",
      properties: {
        remote: { type: "string", description: "Remote name (default: origin)." },
        source: { type: "string", description: "Source branch/ref." },
        forceWithLease: { type: "boolean", description: "Use --force-with-lease." },
        setUpstream: { type: "boolean", description: "Use --set-upstream." },
        all: { type: "boolean", description: "Push all branches." }
      },
      required: [],
      additionalProperties: false
    }
  },
  {
    name: "git_remote",
    description: "Manage git remotes for the workspace repository.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "One of: list, show, add, remove, rename, get-url, set-url, prune." },
        name: { type: "string", description: "Remote name for show/remove/rename/get-url/set-url/prune." },
        url: { type: "string", description: "Remote URL for add or set-url." },
        newName: { type: "string", description: "New remote name for rename." }
      },
      required: ["action"],
      additionalProperties: false
    }
  },
  {
    name: "git_commit",
    description: "Create a git commit in the configured repository.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Commit message. Optional for amend (uses --no-edit by default)." },
        all: { type: "boolean", description: "Stage all tracked changes before commit." },
        amend: { type: "boolean", description: "Amend HEAD commit." },
        allowEmpty: { type: "boolean", description: "Allow creating an empty commit." },
        path: { type: "string", description: "Optional workspace-relative path to include with --only." }
      },
      required: [],
      additionalProperties: false
    }
  },
  {
    name: "tail_file",
    description: "Read tail lines from a UTF-8 text file in the configured workspace.",
    inputSchema: {
      type: "object",
      properties: {
        relativePath: { type: "string", description: "Workspace-relative path. No absolute paths, dotfiles, or parent traversal." },
        maxLines: { type: "number", minimum: 1, maximum: 500, description: "Maximum lines to return from file tail." },
        maxBytes: { type: "number", minimum: 1, maximum: 262144, description: "Maximum bytes to read before selecting tail." }
      },
      required: ["relativePath"],
      additionalProperties: false
    }
  },
  {
    name: "delete_file",
    description: "Delete a UTF-8 file inside the configured workspace.",
    inputSchema: {
      type: "object",
      properties: {
        relativePath: { type: "string", description: "Workspace-relative path. No absolute paths, dotfiles, or parent traversal." },
        confirm: { type: "boolean", description: "Set true to confirm delete." }
      },
      required: ["relativePath", "confirm"],
      additionalProperties: false
    }
  },
  {
    name: "rename_file",
    description: "Rename or move a file inside the configured workspace.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Current workspace-relative path." },
        to: { type: "string", description: "Destination workspace-relative path." },
        overwrite: { type: "boolean", description: "Overwrite destination if it already exists." }
      },
      required: ["from", "to"],
      additionalProperties: false
    }
  },
  {
    name: "file_info",
    description: "Get file metadata inside the configured workspace.",
    inputSchema: {
      type: "object",
      properties: {
        relativePath: { type: "string", description: "Workspace-relative path. No absolute paths, dotfiles, or parent traversal." }
      },
      required: ["relativePath"],
      additionalProperties: false
    }
  },
  {
    name: "file_hash",
    description: "Compute a SHA-256 hash for a workspace file.",
    inputSchema: {
      type: "object",
      properties: {
        relativePath: { type: "string", description: "Workspace-relative path. No absolute paths, dotfiles, or parent traversal." },
        algorithm: { type: "string", description: "Hash algorithm. Default: sha256.", enum: ["sha256"] }
      },
      required: ["relativePath"],
      additionalProperties: false
    }
  },
  {
    name: "folder_size",
    description: "Compute aggregate size/counts for a workspace directory.",
    inputSchema: {
      type: "object",
      properties: {
        relativePath: { type: "string", description: "Workspace-relative directory path." },
        maxDepth: { type: "number", minimum: 1, maximum: 8, description: "Maximum recursion depth when counting directory size." },
        includeHidden: { type: "boolean", description: "Include dot-prefixed files/folders." },
        recursive: { type: "boolean", description: "Include nested directories." }
      },
      required: ["relativePath"],
      additionalProperties: false
    }
  },
  {
    name: "git_log",
    description: "Show recent git commits for the configured workspace.",
    inputSchema: {
      type: "object",
      properties: {
        maxCount: { type: "number", minimum: 1, maximum: 100, description: "Maximum number of commits to return." },
        path: { type: "string", description: "Optional workspace-relative path." }
      },
      additionalProperties: false
    }
  },
  {
    name: "create_project",
    description: "Create a persistent coding project and return its projectId.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Project title." },
        summary: { type: "string", description: "Short project summary." },
        entryFile: { type: "string", description: "Entry file, default index.html." }
      },
      required: ["title"],
      additionalProperties: false
    }
  },
  {
    name: "list_projects",
    description: "List persistent coding projects created through this MCP.",
    inputSchema: {
      type: "object",
      properties: {
        includeDeleted: { type: "boolean", description: "Include soft-deleted projects." }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_project",
    description: "Get project metadata, file list, and published URL if available.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" }
      },
      required: ["projectId"],
      additionalProperties: false
    }
  },
  {
    name: "write_project_file",
    description: "Write a UTF-8 file inside a persistent project.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        relativePath: { type: "string", description: "Project-relative path. No absolute paths, dotfiles, or parent traversal." },
        content: { type: "string", description: "UTF-8 text content. Max 1 MiB." }
      },
      required: ["projectId", "relativePath", "content"],
      additionalProperties: false
    }
  },
  {
    name: "read_project_file",
    description: "Read a UTF-8 file from a persistent project.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        relativePath: { type: "string" },
        maxBytes: { type: "number", minimum: 1, maximum: 1048576 }
      },
      required: ["projectId", "relativePath"],
      additionalProperties: false
    }
  },
  {
    name: "delete_project_file",
    description: "Delete one file from a persistent project.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        relativePath: { type: "string" },
        confirm: { type: "boolean", description: "Set true to confirm delete." }
      },
      required: ["projectId", "relativePath", "confirm"],
      additionalProperties: false
    }
  },
  {
    name: "publish_project",
    description: "Publish a project entry file and return a public share URL.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        entryFile: { type: "string", description: "Entry file to publish. Defaults to project entryFile." }
      },
      required: ["projectId"],
      additionalProperties: false
    }
  },
  {
    name: "delete_project",
    description: "Soft-delete a persistent project. Disabled by default in admin tool access.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        confirm: { type: "boolean", description: "Set true to confirm delete." }
      },
      required: ["projectId", "confirm"],
      additionalProperties: false
    }
  },
  {
    name: "create_share",
    description: "Publish a standalone HTML artifact and return a public share URL.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        summary: { type: "string" },
        filename: { type: "string", description: "Simple .html filename, for example index.html or report.html." },
        html: { type: "string", description: "Complete standalone HTML document. Max 1 MiB." }
      },
      required: ["title", "summary", "filename", "html"],
      additionalProperties: false
    }
  }
];

const pingInputSchema = z.object({
  message: z.string().optional()
});

const previewInputSchema = z.object({
  title: z.string().min(1).max(160),
  summary: z.string().min(1).max(2000)
});

const writeFileInputSchema = z.object({
  relativePath: z.string().min(1).max(240),
  content: z.string().max(256 * 1024)
});

const listDirInputSchema = z.object({
  relativePath: z.string().min(1).max(240),
  recursive: z.boolean().optional().default(false),
  maxDepth: z.number().int().min(1).max(6).optional().default(2),
  includeHidden: z.boolean().optional().default(false)
});

const readFileInputSchema = z.object({
  relativePath: z.string().min(1).max(240),
  maxBytes: z.number().int().min(1).max(131072).optional().default(65536)
});

const searchFilesInputSchema = z.object({
  query: z.string().trim().min(2),
  path: z.string().min(1).max(240).optional().default("."),
  useRegex: z.boolean().optional().default(false),
  caseSensitive: z.boolean().optional().default(false),
  maxResults: z.number().int().min(1).max(200).optional().default(100),
  maxDepth: z.number().int().min(1).max(6).optional().default(4),
  includeHidden: z.boolean().optional().default(false)
});

const runCommandInputSchema = z.object({
  command: z.enum(["npm test", "npm run build", "npm run typecheck"])
});

const gitStatusInputSchema = z.object({});

const gitDiffInputSchema = z.object({
  path: z.string().min(1).max(240).optional(),
  cached: z.boolean().optional().default(false)
});

const replaceInFileInputSchema = z.object({
  relativePath: z.string().min(1).max(240),
  find: z.string().min(1),
  replace: z.string(),
  all: z.boolean().optional().default(false)
});

const deleteFileInputSchema = z.object({
  relativePath: z.string().min(1).max(240),
  confirm: z.boolean().refine((value) => value === true, { message: "Deletion requires confirm=true." })
});

const renameFileInputSchema = z.object({
  from: z.string().min(1).max(240),
  to: z.string().min(1).max(240),
  overwrite: z.boolean().optional().default(false)
});

const copyFileInputSchema = z.object({
  from: z.string().min(1).max(240),
  to: z.string().min(1).max(240),
  overwrite: z.boolean().optional().default(false)
});

const createDirectoryInputSchema = z.object({
  relativePath: z.string().min(1).max(240),
  recursive: z.boolean().optional().default(true)
});

const fileExistsInputSchema = z.object({
  relativePath: z.string().min(1).max(240)
});

const symlinkInfoInputSchema = z.object({
  relativePath: z.string().min(1).max(240)
});

const gitShowInputSchema = z.object({
  ref: z.string().min(1).max(160),
  path: z.string().min(1).max(240).optional()
});

const gitBlameInputSchema = z.object({
  relativePath: z.string().min(1).max(240),
  ref: z.string().min(1).max(160).optional(),
  lineStart: z.number().int().min(1).optional(),
  lineEnd: z.number().int().min(1).optional()
});

const gitStashInputSchema = z.object({
  action: z.enum(["list", "push", "pop", "apply", "drop", "clear"]),
  message: z.string().max(160).optional(),
  ref: z.string().min(1).max(160).optional(),
  path: z.string().min(1).max(240).optional()
});

const gitAddInputSchema = z.object({
  path: z.string().min(1).max(240).optional(),
  all: z.boolean().optional().default(false),
  update: z.boolean().optional().default(false)
});

const gitResetInputSchema = z.object({
  target: z.string().min(1).max(160).optional(),
  mode: z.enum(["soft", "mixed", "hard"]).optional().default("mixed"),
  path: z.string().min(1).max(240).optional()
});

const gitRebaseInputSchema = z.object({
  action: z.enum(["start", "continue", "abort", "skip"]),
  upstream: z.string().min(1).max(160).optional(),
  onto: z.string().min(1).max(160).optional()
});

const gitBisectInputSchema = z.object({
  action: z.enum(["start", "bad", "good", "skip", "reset", "log"]),
  bad: z.string().min(1).max(160).optional(),
  good: z.string().min(1).max(160).optional(),
  commit: z.string().min(1).max(160).optional(),
  resetRef: z.string().min(1).max(160).optional()
});

const gitCherryPickInputSchema = z.object({
  action: z.enum(["pick", "continue", "abort", "skip"]),
  commit: z.string().min(1).max(160).optional(),
  noCommit: z.boolean().optional().default(false),
  signoff: z.boolean().optional().default(false),
  mainline: z.number().int().optional(),
  noVerify: z.boolean().optional().default(false)
});

const gitLsFilesInputSchema = z.object({
  stage: z.boolean().optional().default(false),
  untracked: z.boolean().optional().default(false),
  ignored: z.boolean().optional().default(false),
  modified: z.boolean().optional().default(false),
  deleted: z.boolean().optional().default(false),
  excludeStandard: z.boolean().optional().default(false),
  path: z.string().min(1).max(240).optional()
});

const gitSubmoduleInputSchema = z.object({
  action: z.enum(["init", "status", "update", "sync", "add", "deinit"]),
  path: z.string().min(1).max(240).optional(),
  url: z.string().min(1).max(2048).optional(),
  remote: z.boolean().optional().default(false),
  recursive: z.boolean().optional().default(false),
  force: z.boolean().optional().default(false)
});

const gitNotesInputSchema = z.object({
  action: z.enum(["add", "list", "show", "remove"]),
  commit: z.string().min(1).max(160).optional(),
  message: z.string().min(1).max(4000).optional(),
  namespace: z.string().min(1).max(80).optional(),
  scope: z.string().min(1).max(80).optional()
});

const gitWorktreeInputSchema = z.object({
  action: z.enum(["add", "list", "remove", "move", "lock", "unlock", "prune"]),
  path: z.string().min(1).max(240).optional(),
  commit: z.string().min(1).max(160).optional(),
  branch: z.string().min(1).max(160).optional(),
  force: z.boolean().optional().default(false),
  noCheckout: z.boolean().optional().default(false),
  newPath: z.string().min(1).max(240).optional()
});

const gitConfigInputSchema = z.object({
  action: z.enum(["get", "set", "add", "unset", "list"]),
  key: z.string().min(1).max(160).optional(),
  value: z.string().min(0).max(2048).optional(),
  scope: z.enum(["global", "local", "system"]).optional()
});

const gitArchiveInputSchema = z.object({
  action: z.enum(["create", "list"]),
  treeish: z.string().min(1).max(160).optional(),
  format: z.string().min(1).max(40).optional().default("tar"),
  output: z.string().min(1).max(240).optional(),
  prefix: z.string().min(1).max(120).optional(),
  path: z.string().min(1).max(240).optional()
});

const gitDiffStagedInputSchema = z.object({
  path: z.string().min(1).max(240).optional(),
  stat: z.boolean().optional().default(false)
});

const gitMergeBaseInputSchema = z.object({
  commit: z.string().min(1).max(160).optional(),
  other: z.string().min(1).max(160).optional(),
  all: z.boolean().optional().default(false),
  forkPoint: z.boolean().optional().default(false)
});

const gitCountObjectsInputSchema = z.object({
  action: z.enum(["count", "size-pack"]),
  verbose: z.boolean().optional().default(false),
  humanReadable: z.boolean().optional().default(false),
  prune: z.boolean().optional().default(false)
});

const gitVerifyPackInputSchema = z.object({
  action: z.enum(["verify", "stats"]),
  pack: z.string().min(1).max(320),
  verbose: z.boolean().optional().default(false),
  all: z.boolean().optional().default(false),
  hashAlgo: z.string().min(2).max(20).optional()
});

const gitFsckInputSchema = z.object({
  action: z.enum(["check", "full", "connectivity", "prune"]),
  strict: z.boolean().optional().default(false),
  verbose: z.boolean().optional().default(false),
  pruneDate: z.string().min(1).max(120).optional()
});

const gitReflogInputSchema = z.object({
  action: z.enum(["show", "expire", "delete"]),
  ref: z.string().min(1).max(160).optional(),
  maxAge: z.string().min(1).max(120).optional(),
  all: z.boolean().optional().default(false),
  staleOnly: z.boolean().optional().default(false),
  rewrite: z.boolean().optional().default(false),
  updateref: z.boolean().optional().default(false)
});

const gitMaintenanceInputSchema = z.object({
  action: z.enum(["run", "start", "stop", "status"]),
  task: z.string().min(1).max(80).optional(),
  tasks: z.array(z.string().min(1).max(80)).max(10).optional()
});

const gitPruneInputSchema = z.object({
  action: z.enum(["prune", "dry-run"]),
  expire: z.string().min(1).max(120).optional(),
  expireUnreachable: z.string().min(1).max(120).optional(),
  progress: z.boolean().optional().default(false),
  verbose: z.boolean().optional().default(false),
  includeAll: z.boolean().optional().default(false)
});

const gitRepackInputSchema = z.object({
  all: z.boolean().optional().default(false),
  window: z.number().int().min(1).max(8192).optional(),
  depth: z.number().int().min(1).max(8192).optional(),
  aggressive: z.boolean().optional().default(false),
  noGc: z.boolean().optional().default(false),
  keepPack: z.boolean().optional().default(false),
  noPrune: z.boolean().optional().default(false),
  local: z.boolean().optional().default(false),
  writeBitmapIndex: z.boolean().optional().default(false),
  maxPackSize: z.string().min(1).max(120).optional()
});

const gitShowRefInputSchema = z.object({
  action: z.enum(["list", "heads", "tags"]),
  dereference: z.boolean().optional().default(false),
  all: z.boolean().optional().default(false),
  heads: z.boolean().optional().default(false),
  tags: z.boolean().optional().default(false),
  quiet: z.boolean().optional().default(false),
  abbrev: z.number().int().min(0).max(40).optional()
});

const gitSymbolicRefInputSchema = z.object({
  action: z.enum(["get", "set", "short", "delete"]),
  ref: z.string().min(1).max(160).optional(),
  newRef: z.string().min(1).max(160).optional(),
  log: z.boolean().optional().default(false),
  short: z.boolean().optional().default(false),
  quiet: z.boolean().optional().default(false)
});

const gitForEachRefInputSchema = z.object({
  action: z.enum(["heads", "tags", "remotes", "all", "pattern"]),
  pattern: z.string().min(1).max(240).optional(),
  format: z.string().min(1).max(240).optional(),
  sort: z.string().min(1).max(80).optional(),
  count: z.number().int().min(1).max(500).optional(),
  contains: z.string().min(1).max(160).optional(),
  merged: z.string().min(1).max(160).optional(),
  pointsAt: z.string().min(1).max(160).optional(),
  abbrev: z.number().int().min(0).max(40).optional()
});

const gitUpdateRefInputSchema = z.object({
  action: z.enum(["create", "update", "delete", "list"]),
  ref: z.string().min(1).max(160).optional(),
  newValue: z.string().min(1).max(120).optional(),
  oldValue: z.string().min(1).max(120).optional(),
  reason: z.string().min(1).max(200).optional(),
  noDeref: z.boolean().optional().default(false),
  noDerefFrom: z.boolean().optional().default(false),
  force: z.boolean().optional().default(false)
});

const gitGcInputSchema = z.object({
  action: z.enum(["auto", "prune", "aggressive", "rerere"]),
  prune: z.string().min(1).max(120).optional(),
  aggressive: z.boolean().optional().default(false),
  force: z.boolean().optional().default(false)
});

const gitNameRevInputSchema = z.object({
  action: z.enum(["resolve", "all"]),
  target: z.string().min(1).max(160).optional(),
  nameOnly: z.boolean().optional().default(false),
  tags: z.boolean().optional().default(false),
  refs: z.boolean().optional().default(false),
  noReflog: z.boolean().optional().default(false),
  all: z.boolean().optional().default(false)
});

const gitCatFileInputSchema = z.object({
  action: z.enum(["type", "size", "pretty", "exists"]),
  object: z.string().min(1).max(160)
});

const gitCheckRefFormatInputSchema = z.object({
  ref: z.string().min(1).max(160),
  normalize: z.boolean().optional().default(false),
  allowOneLevel: z.boolean().optional().default(false),
  branch: z.boolean().optional().default(false),
  noReflog: z.boolean().optional().default(false)
});

const gitRevParseInputSchema = z.object({
  action: z.enum(["show-ref", "is-inside-work-tree", "is-bare-repository", "short-sha", "verify", "default-branch"]),
  value: z.string().min(1).max(160).optional(),
  short: z.number().int().min(1).max(64).optional(),
  always: z.boolean().optional().default(false)
});

const gitCleanInputSchema = z.object({
  action: z.enum(["list", "clean", "clean-dirs", "clean-ignored", "clean-ignored-only"]),
  pathspec: z.string().min(1).max(200).optional(),
  force: z.boolean().optional().default(false),
  includeIgnored: z.boolean().optional().default(false),
  dryRun: z.boolean().optional().default(false),
  interactive: z.boolean().optional().default(false)
});

const gitCloneInputSchema = z.object({
  repo: z.string().min(1).max(260),
  branch: z.string().min(1).max(120).optional(),
  depth: z.number().int().min(1).max(64).optional(),
  bare: z.boolean().optional().default(false),
  singleBranch: z.boolean().optional().default(false),
  noCheckout: z.boolean().optional().default(false),
  outputDir: z.string().min(1).max(200).optional()
});

const gitRevertInputSchema = z.object({
  commit: z.string().min(1).max(200),
  mainline: z.number().int().min(1).max(8).optional(),
  noEdit: z.boolean().optional().default(false),
  noCommit: z.boolean().optional().default(false)
});

const gitStashApplyInputSchema = z.object({
  stash: z.string().min(1).max(80).optional(),
  index: z.boolean().optional().default(false),
  keepIndex: z.boolean().optional().default(false)
});

const gitStashPopInputSchema = z.object({
  stash: z.string().min(1).max(80).optional(),
  index: z.boolean().optional().default(false),
  quiet: z.boolean().optional().default(false),
  keepIndex: z.boolean().optional().default(false)
});

const gitLfsInputSchema = z.object({
  action: z.enum(["install", "track", "untrack", "status", "track-list", "fetch", "pull", "push"]),
  pattern: z.string().min(1).max(200).optional(),
  remote: z.string().min(1).max(80).optional(),
  all: z.boolean().optional().default(false),
  include: z.string().min(1).max(200).optional(),
  exclude: z.string().min(1).max(200).optional(),
  verbose: z.boolean().optional().default(false)
});

const gitInitInputSchema = z.object({
  initDir: z.string().min(1).max(200).optional(),
  bare: z.boolean().optional().default(false),
  shared: z.boolean().optional().default(false),
  initialBranch: z.string().min(1).max(80).optional()
});

const gitFetchInputSchema = z.object({
  remote: z.string().min(1).max(80).optional(),
  all: z.boolean().optional().default(false),
  prune: z.boolean().optional().default(false),
  depth: z.number().int().min(1).max(64).optional()
});

const gitPullInputSchema = z.object({
  remote: z.string().min(1).max(80).optional(),
  source: z.string().min(1).max(160).optional(),
  rebase: z.boolean().optional().default(false),
  ffOnly: z.boolean().optional().default(false),
  all: z.boolean().optional().default(false),
  prune: z.boolean().optional().default(false),
  depth: z.number().int().min(1).max(64).optional()
});

const gitPushInputSchema = z.object({
  remote: z.string().min(1).max(80).optional(),
  source: z.string().min(1).max(160).optional(),
  forceWithLease: z.boolean().optional().default(false),
  setUpstream: z.boolean().optional().default(false),
  all: z.boolean().optional().default(false)
});

const gitRemoteInputSchema = z.object({
  action: z.enum(["list", "show", "add", "remove", "rename", "get-url", "set-url", "prune"]),
  name: z.string().min(1).max(80).optional(),
  url: z.string().min(1).max(2048).optional(),
  newName: z.string().min(1).max(80).optional()
});

const gitMergeInputSchema = z.object({
  source: z.string().min(1).max(160).optional(),
  noFF: z.boolean().optional().default(false),
  abort: z.boolean().optional().default(false)
});

const gitCommitInputSchema = z.object({
  message: z.string().min(1).max(2000).optional(),
  all: z.boolean().optional().default(false),
  amend: z.boolean().optional().default(false),
  allowEmpty: z.boolean().optional().default(false),
  path: z.string().min(1).max(240).optional()
});

const chmodModeInputSchema = z.object({
  relativePath: z.string().min(1).max(240),
  mode: z.string().regex(/^[0-7]{3,4}$/).optional()
});

const gitCheckoutInputSchema = z.object({
  branch: z.string().min(1).max(160),
  create: z.boolean().optional().default(false),
  source: z.string().min(1).max(160).optional()
});

const gitBranchInputSchema = z.object({
  action: z.enum(["list", "create", "delete", "rename", "current"]),
  branch: z.string().min(1).max(160).optional(),
  newName: z.string().min(1).max(160).optional(),
  startPoint: z.string().min(1).max(160).optional(),
  force: z.boolean().optional().default(false),
  all: z.boolean().optional().default(false)
});

const gitTagInputSchema = z.object({
  action: z.enum(["list", "create", "delete", "show", "current"]),
  name: z.string().min(1).max(160).optional(),
  target: z.string().min(1).max(160).optional(),
  message: z.string().min(1).max(2000).optional(),
  force: z.boolean().optional().default(false)
});

const fileHashInputSchema = z.object({
  relativePath: z.string().min(1).max(240),
  algorithm: z.enum(["sha256"]).optional().default("sha256")
});

const folderSizeInputSchema = z.object({
  relativePath: z.string().min(1).max(240),
  recursive: z.boolean().optional().default(true),
  maxDepth: z.number().int().min(1).max(8).optional().default(4),
  includeHidden: z.boolean().optional().default(false)
});

const fileInfoInputSchema = z.object({
  relativePath: z.string().min(1).max(240)
});

const tailFileInputSchema = z.object({
  relativePath: z.string().min(1).max(240),
  maxLines: z.number().int().min(1).max(500).optional().default(80),
  maxBytes: z.number().int().min(1).max(262144).optional().default(65536)
});

const gitLogInputSchema = z.object({
  maxCount: z.number().int().min(1).max(100).optional().default(20),
  path: z.string().min(1).max(240).optional()
});

const createProjectInputSchema = z.object({
  title: z.string().min(1).max(160),
  summary: z.string().max(2000).optional().default(""),
  entryFile: z.string().min(1).max(240).optional().default("index.html")
});

const listProjectsInputSchema = z.object({
  includeDeleted: z.boolean().optional().default(false)
});

const projectIdInputSchema = z.object({
  projectId: z.string().min(8).max(80)
});

const writeProjectFileInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  relativePath: z.string().min(1).max(240),
  content: z.string().max(1024 * 1024)
});

const readProjectFileInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  relativePath: z.string().min(1).max(240),
  maxBytes: z.number().int().min(1).max(1024 * 1024).optional().default(65536)
});

const deleteProjectFileInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  relativePath: z.string().min(1).max(240),
  confirm: z.boolean().refine((value) => value === true, { message: "Deletion requires confirm=true." })
});

const publishProjectInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  entryFile: z.string().min(1).max(240).optional()
});

const deleteProjectInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  confirm: z.boolean().refine((value) => value === true, { message: "Deletion requires confirm=true." })
});

const createShareInputSchema = z.object({
  title: z.string().min(1).max(160),
  summary: z.string().min(1).max(2000),
  filename: z.string().min(6).max(86),
  html: z.string().min(1).max(1024 * 1024)
});

function makePreviewUrl(publicBaseUrl: string, jobId: string): string {
  return `${publicBaseUrl.replace(/\/$/, "")}/outcome/${jobId}`;
}

function makeShareUrl(publicBaseUrl: string, shareId: string, filename: string): string {
  return `${publicBaseUrl.replace(/\/$/, "")}/share/${shareId}/${filename}`;
}

async function computeFileHash(filePath: string, algorithm: string): Promise<string> {
  const hash = createHash(algorithm);
  const stream = createReadStream(filePath);
  try {
    for await (const chunk of stream) {
      hash.update(chunk);
    }
    return hash.digest("hex");
  } finally {
    stream.destroy();
  }
}

interface FolderSizeResult {
  totalBytes: number;
  files: number;
  directories: number;
  symlinks: number;
}

async function computeFolderSize(
  basePath: string,
  recursive: boolean,
  maxDepth: number,
  includeHidden: boolean,
  currentDepth = 0
): Promise<FolderSizeResult> {
  const entries = await readdir(basePath, { withFileTypes: true });
  let totalBytes = 0;
  let files = 0;
  let directories = 0;
  let symlinks = 0;

  for (const entry of entries) {
    if (!includeHidden && entry.name.startsWith(".")) continue;
    const fullPath = path.join(basePath, entry.name);

    if (entry.isSymbolicLink()) {
      const linkStats = await lstat(fullPath);
      symlinks += 1;
      totalBytes += linkStats.size;
      continue;
    }

    if (entry.isDirectory()) {
      directories += 1;
      if (!recursive || currentDepth >= maxDepth) {
        continue;
      }
      const child = await computeFolderSize(fullPath, recursive, maxDepth, includeHidden, currentDepth + 1);
      totalBytes += child.totalBytes;
      files += child.files;
      directories += child.directories;
      symlinks += child.symlinks;
      continue;
    }

    const info = await stat(fullPath);
    if (info.isFile()) {
      files += 1;
      totalBytes += info.size;
      continue;
    }

    files += 1;
    totalBytes += info.size;
  }

  return { totalBytes, files, directories, symlinks };
}

function createJobResult(ctx: ToolContext, title: string, summary: string, logs: string[], artifacts: string[] = []): ToolResult {
  const id = randomUUID();
  saveJob({
    id,
    status: "success",
    title,
    summary,
    logs,
    artifacts,
    errors: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  return {
    ok: true,
    summary,
    jobId: id,
    previewUrl: makePreviewUrl(ctx.publicBaseUrl, id),
    artifacts,
    logs,
    errors: []
  };
}

interface DirectoryEntry {
  name: string;
  kind: "file" | "directory";
  size: number;
  modifiedAt: string;
}

interface SearchMatch {
  file: string;
  line: number;
  column: number;
  text: string;
}

function resolveSafeWorkspacePath(workspaceRoot: string, relativePath: string, includeHidden = false): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error("Absolute paths are not allowed.");
  }

  const parts = relativePath.split(/[\\/]+/).filter(Boolean);
  if (parts.some((part) => part === ".." || (!includeHidden && part.startsWith(".")))) {
    throw new Error("Parent traversal and hidden path segments are not allowed.");
  }

  const resolved = path.resolve(workspaceRoot, relativePath);
  const normalizedRoot = path.resolve(workspaceRoot);
  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error("Resolved path is outside the workspace.");
  }

  // Symlink-escape guard: the lexical check above passes for a path with no "..", but an
  // in-workspace symlink component can still redirect the file op outside the root. Resolve
  // symlinks on the deepest path component that exists and assert it is still inside the
  // realpath'd root. Returns the original lexical path unchanged when safe (callers unaffected).
  let realRoot: string;
  try {
    realRoot = realpathSync(normalizedRoot);
  } catch {
    return resolved;
  }
  let existing = resolved;
  while (existing !== normalizedRoot) {
    try {
      statSync(existing);
      break;
    } catch {
      existing = path.dirname(existing);
    }
  }
  let realExisting: string;
  try {
    realExisting = realpathSync(existing);
  } catch {
    realExisting = existing;
  }
  if (realExisting !== realRoot && !realExisting.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error("Resolved path escapes the workspace via a symlink.");
  }

  return resolved;
}

function formatPathForWorkspace(workspaceRoot: string, targetPath: string): string {
  return path.relative(workspaceRoot, targetPath).replaceAll("\\", "/");
}

function hasSuspiciousControlChars(value: string): boolean {
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value);
}

function safePreview(value: string, maxBytes = 12000): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  return `${value.slice(0, Math.max(2000, Math.floor(maxBytes / 4)))}...`;
}

async function readTailTextFromFile(filePath: string, maxLines: number, maxBytes: number): Promise<string[]> {
  const fileInfo = await stat(filePath);
  if (fileInfo.size === 0) return [];

  const start = Math.max(0, fileInfo.size - maxBytes);
  const toRead = fileInfo.size - start;
  const fileHandle = await open(filePath, "r");
  try {
    const chunkBuffer = Buffer.alloc(toRead);
    const { bytesRead } = await fileHandle.read(chunkBuffer, 0, toRead, start);
    const rawChunk = chunkBuffer.slice(0, bytesRead).toString("utf8");
    const content = start > 0 && rawChunk.includes("\n")
      ? rawChunk.slice(rawChunk.indexOf("\n") + 1)
      : rawChunk;

    if (hasSuspiciousControlChars(content) && !content.includes("\n")) {
      throw new Error("File contains binary-like or unsafe control characters.");
    }

    return content.split(/\r?\n/).slice(-maxLines);
  } finally {
    await fileHandle.close();
  }
}

function gitCommand(workspaceRoot: string, timeoutMs: number, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, {
    cwd: workspaceRoot,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    env: gitChildEnv()
  });
}

async function listDirectoryRecursive(
  workspaceRoot: string,
  baseDir: string,
  recursive: boolean,
  maxDepth: number,
  includeHidden: boolean,
  currentDepth = 0
): Promise<DirectoryEntry[]> {
  const target = resolveSafeWorkspacePath(workspaceRoot, baseDir, includeHidden);
  const entries = await readdir(target, { withFileTypes: true });
  const out: DirectoryEntry[] = [];
  const nextDepth = currentDepth + 1;

  for (const entry of entries) {
    if (!includeHidden && entry.name.startsWith(".")) continue;
    const fullPath = path.join(target, entry.name);
    const statInfo = await stat(fullPath);
    const isDirectory = entry.isDirectory();
    const kind: DirectoryEntry["kind"] = isDirectory ? "directory" : "file";
    out.push({
      name: formatPathForWorkspace(workspaceRoot, fullPath),
      kind,
      size: statInfo.size,
      modifiedAt: statInfo.mtime.toISOString()
    });

    if (isDirectory && recursive && currentDepth < maxDepth) {
      const nestedBase = baseDir === "." ? entry.name : `${baseDir}/${entry.name}`;
      out.push(...await listDirectoryRecursive(workspaceRoot, nestedBase, recursive, maxDepth, includeHidden, nextDepth));
    }
  }

  return out;
}

async function searchFilesRecursive(
  workspaceRoot: string,
  basePath: string,
  matcher: (line: string) => number[],
  maxResults: number,
  maxDepth: number,
  includeHidden: boolean,
  currentDepth = 0,
  accumulator: SearchMatch[] = []
): Promise<SearchMatch[]> {
  const target = resolveSafeWorkspacePath(workspaceRoot, basePath, includeHidden);
  const entries = await readdir(target, { withFileTypes: true });
  const nextDepth = currentDepth + 1;

  for (const entry of entries) {
    if (!includeHidden && entry.name.startsWith(".")) continue;
    const fullPath = path.join(target, entry.name);

    if (entry.isDirectory()) {
      if (currentDepth < maxDepth) {
        const nestedBase = basePath === "." ? entry.name : `${basePath}/${entry.name}`;
        await searchFilesRecursive(workspaceRoot, nestedBase, matcher, maxResults, maxDepth, includeHidden, nextDepth, accumulator);
      }
      continue;
    }

    const fileStat = await stat(fullPath);
    if (!fileStat.isFile() || fileStat.size > 1024 * 1024) continue;

    let content = "";
    try {
      content = await readFile(fullPath, "utf8");
    } catch {
      continue;
    }
    if (hasSuspiciousControlChars(content) && !content.includes("\n")) {
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length && accumulator.length < maxResults; i++) {
      const line = lines[i];
      for (const offset of matcher(line)) {
        accumulator.push({
          file: formatPathForWorkspace(workspaceRoot, fullPath),
          line: i + 1,
          column: offset + 1,
          text: line
        });
        if (accumulator.length >= maxResults) break;
      }
      if (accumulator.length >= maxResults) break;
    }

    if (accumulator.length >= maxResults) break;
  }

  return accumulator.slice(0, maxResults);
}

function commandToExecArgs(command: "npm test" | "npm run build" | "npm run typecheck"): [string, string[]] {
  switch (command) {
    case "npm test":
      return ["npm", ["test"]];
    case "npm run build":
      return ["npm", ["run", "build"]];
    case "npm run typecheck":
      return ["npm", ["run", "typecheck"]];
  }
}

export async function callTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
  try {
    if (name === "ping") {
      const input = pingInputSchema.parse(rawInput ?? {});
      return {
        ok: true,
        summary: "Coding MCP server is reachable.",
        artifacts: [],
        logs: [input.message ? `Echo: ${input.message}` : "pong"],
        errors: []
      };
    }

    if (name === "create_preview") {
      const input = previewInputSchema.parse(rawInput);
      return createJobResult(ctx, input.title, input.summary, ["Preview job created."], []);
    }

    if (name === "write_file") {
      const input = writeFileInputSchema.parse(rawInput);
      assertWritableWorkspacePath(input.relativePath);
      const target = resolveSafeWorkspacePath(ctx.workspaceRoot, input.relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, input.content, "utf8");
      return createJobResult(ctx, `Wrote ${input.relativePath}`, `Created or updated ${input.relativePath}.`, [`Wrote ${input.content.length} bytes.`], [input.relativePath]);
    }

    if (name === "list_dir") {
      const input = listDirInputSchema.parse(rawInput);
      const entries = await listDirectoryRecursive(
        ctx.workspaceRoot,
        input.relativePath,
        input.recursive,
        input.maxDepth,
        input.includeHidden
      );
      return {
        ok: true,
        summary: `Listed ${entries.length} workspace entry(s) under ${input.relativePath}.`,
        artifacts: [],
        logs: entries.map((entry) => `${entry.kind}: ${entry.name} (${entry.size} bytes)`),
        errors: []
      };
    }

    if (name === "read_file") {
      const input = readFileInputSchema.parse(rawInput);
      const target = resolveSafeWorkspacePath(ctx.workspaceRoot, input.relativePath);
      const fileContent = await readFile(target, "utf8");
      if (Buffer.byteLength(fileContent, "utf8") > input.maxBytes) {
        throw new Error(`File exceeds maxBytes (${input.maxBytes}).`);
      }
      if (hasSuspiciousControlChars(fileContent)) {
        throw new Error("File contains binary-like or unsafe control characters.");
      }
      return {
        ok: true,
        summary: `Read file ${input.relativePath}.`,
        artifacts: [input.relativePath],
        logs: [fileContent],
        errors: []
      };
    }

    if (name === "search_files") {
      const input = searchFilesInputSchema.parse(rawInput);
      const matcher = input.useRegex
        ? (line: string) => {
            const regex = new RegExp(input.query, `${input.caseSensitive ? "" : "i"}g`);
            const offsets: number[] = [];
            const matches = line.matchAll(regex);
            for (const match of matches) {
              const index = match.index;
              if (index === undefined) continue;
              offsets.push(index);
            }
            return offsets;
          }
        : (line: string) => {
            const haystack = input.caseSensitive ? line : line.toLowerCase();
            const needle = input.caseSensitive ? input.query : input.query.toLowerCase();
            const offsets: number[] = [];
            let index = 0;
            while (true) {
              const found = haystack.indexOf(needle, index);
              if (found === -1) break;
              offsets.push(found);
              index = found + Math.max(1, needle.length);
            }
            return offsets;
          };

      const matches = await searchFilesRecursive(
        ctx.workspaceRoot,
        input.path,
        matcher,
        input.maxResults,
        input.maxDepth,
        input.includeHidden
      );
      return {
        ok: true,
        summary: `Search matched ${matches.length} time(s).`,
        artifacts: [],
        logs: matches.map((match) => `${match.file}:${match.line}:${match.column} ${match.text}`),
        errors: []
      };
    }

    if (name === "run_command") {
      const input = runCommandInputSchema.parse(rawInput);
      const [file, args] = commandToExecArgs(input.command);
      const { stdout, stderr } = await execFileAsync(file, args, {
        cwd: ctx.workspaceRoot,
        timeout: ctx.commandTimeoutMs,
        maxBuffer: 1024 * 1024,
        env: childEnv()
      });
      return createJobResult(ctx, `Ran ${input.command}`, `${input.command} completed successfully.`, [stdout.trim(), stderr.trim()].filter(Boolean), []);
    }

    if (name === "git_status") {
      gitStatusInputSchema.parse(rawInput);
      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, ["status", "--short"]);
      return {
        ok: true,
        summary: "Read git status.",
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_diff") {
      const input = gitDiffInputSchema.parse(rawInput);
      const args = ["diff", input.cached ? "--cached" : ""].filter(Boolean);
      if (input.path) {
        const targetPath = resolveSafeWorkspacePath(ctx.workspaceRoot, input.path);
        args.push(formatPathForWorkspace(ctx.workspaceRoot, targetPath));
      }
      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: "Read git diff.",
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "replace_in_file") {
      const input = replaceInFileInputSchema.parse(rawInput);
      const target = resolveSafeWorkspacePath(ctx.workspaceRoot, input.relativePath);
      const current = await readFile(target, "utf8");
      if (hasSuspiciousControlChars(current) && !current.includes("\n")) {
        throw new Error("File contains binary-like or unsafe control characters.");
      }

      if (!current.includes(input.find)) {
        return {
          ok: true,
          summary: "No occurrences found.",
          artifacts: [input.relativePath],
          logs: [`No changes: did not find text "${input.find}" in ${input.relativePath}.`],
          errors: []
        };
      }

      const nextContent = input.all
        ? current.split(input.find).join(input.replace)
        : (() => {
            const start = current.indexOf(input.find);
            if (start === -1) return current;
            const end = start + input.find.length;
            return `${current.slice(0, start)}${input.replace}${current.slice(end)}`;
          })();

      await writeFile(target, nextContent, "utf8");
      return createJobResult(ctx, `Updated ${input.relativePath}`, `Replaced text in ${input.relativePath}.`, [`Replaced "${input.find}" with "${input.replace}"`, `all: ${input.all}`], [input.relativePath]);
    }

    if (name === "create_directory") {
      const input = createDirectoryInputSchema.parse(rawInput);
      const target = resolveSafeWorkspacePath(ctx.workspaceRoot, input.relativePath);
      await mkdir(target, { recursive: input.recursive });
      return createJobResult(ctx, `Created directory ${input.relativePath}`, `Created directory ${input.relativePath}.`, [`Created directory ${input.relativePath}`]);
    }

    if (name === "tail_file") {
      const input = tailFileInputSchema.parse(rawInput);
      const target = resolveSafeWorkspacePath(ctx.workspaceRoot, input.relativePath);
      const tail = await readTailTextFromFile(target, input.maxLines, input.maxBytes);
      return {
        ok: true,
        summary: `Read last ${tail.length} line(s) from ${input.relativePath}.`,
        artifacts: [input.relativePath],
        logs: tail,
        errors: []
      };
    }

    if (name === "delete_file") {
      const input = deleteFileInputSchema.parse(rawInput);
      const target = resolveSafeWorkspacePath(ctx.workspaceRoot, input.relativePath);
      await unlink(target);
      return createJobResult(ctx, `Deleted ${input.relativePath}`, `Deleted file ${input.relativePath}.`, [`Deleted ${input.relativePath}`], [input.relativePath]);
    }

    if (name === "rename_file") {
      const input = renameFileInputSchema.parse(rawInput);
      assertWritableWorkspacePath(input.to);
      const source = resolveSafeWorkspacePath(ctx.workspaceRoot, input.from);
      const destination = resolveSafeWorkspacePath(ctx.workspaceRoot, input.to);
      if (source === destination) {
        return {
          ok: true,
          summary: "No-op rename.",
          artifacts: [input.from],
          logs: [`Source and destination are the same: ${input.from}`],
          errors: []
        };
      }

      if (!input.overwrite) {
        const exists = await stat(destination).then(() => true).catch(() => false);
        if (exists) {
          throw new Error(`Destination already exists: ${input.to}. Set overwrite=true to replace.`);
        }
      }
      await mkdir(path.dirname(destination), { recursive: true });
      await renameFile(source, destination);
      return createJobResult(ctx, `Renamed ${input.from}`, `Renamed ${input.from} -> ${input.to}.`, [`Renamed ${input.from} -> ${input.to}`], [input.to]);
    }

    if (name === "copy_file") {
      const input = copyFileInputSchema.parse(rawInput);
      const source = resolveSafeWorkspacePath(ctx.workspaceRoot, input.from);
      const destination = resolveSafeWorkspacePath(ctx.workspaceRoot, input.to);
      if (source === destination) {
        return {
          ok: true,
          summary: "No-op copy.",
          artifacts: [input.to],
          logs: [`Source and destination are the same: ${input.from}`],
          errors: []
        };
      }

      if (!input.overwrite) {
        const exists = await stat(destination).then(() => true).catch(() => false);
        if (exists) {
          throw new Error(`Destination already exists: ${input.to}. Set overwrite=true to replace.`);
        }
      }

      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination);
      return createJobResult(ctx, `Copied ${input.from}`, `Copied file ${input.from} -> ${input.to}.`, [`Copied ${input.from} -> ${input.to}`], [input.to]);
    }

    if (name === "file_exists") {
      const input = fileExistsInputSchema.parse(rawInput);
      const target = resolveSafeWorkspacePath(ctx.workspaceRoot, input.relativePath);
      const exists = await stat(target).then(() => true).catch(() => false);
      if (!exists) {
        return {
          ok: true,
          summary: `Path does not exist: ${input.relativePath}`,
          artifacts: [],
          logs: [`exists=false`, `path=${input.relativePath}`],
          errors: []
        };
      }

      const statInfo = await stat(target);
      return {
        ok: true,
        summary: `Path exists: ${input.relativePath}`,
        artifacts: [input.relativePath],
        logs: [
          `exists=true`,
          `path=${input.relativePath}`,
          `kind=${statInfo.isDirectory() ? "directory" : "file"}`,
          `size=${statInfo.size}`,
          `modifiedAt=${statInfo.mtime.toISOString()}`
        ],
        errors: []
      };
    }

    if (name === "symlink_info") {
      const input = symlinkInfoInputSchema.parse(rawInput);
      const target = resolveSafeWorkspacePath(ctx.workspaceRoot, input.relativePath);
      const stats = await lstat(target);
      const logs = [
        `path=${input.relativePath}`,
        `kind=${stats.isSymbolicLink() ? "symlink" : (stats.isDirectory() ? "directory" : "file")}`,
        `size=${stats.size}`,
        `modifiedAt=${stats.mtime.toISOString()}`
      ];

      if (stats.isSymbolicLink()) {
        const linkedTo = await readlink(target);
        logs.push(`symlinkTarget=${linkedTo}`);
      } else {
        logs.push("isSymlink=false");
      }

      return {
        ok: true,
        summary: `${input.relativePath} is ${stats.isSymbolicLink() ? "a symlink" : "not a symlink"}.`,
        artifacts: [input.relativePath],
        logs,
        errors: []
      };
    }

    if (name === "git_show") {
      const input = gitShowInputSchema.parse(rawInput);
      const args = ["show", input.ref];
      if (input.path) {
        const targetPath = resolveSafeWorkspacePath(ctx.workspaceRoot, input.path);
        args.push("--", formatPathForWorkspace(ctx.workspaceRoot, targetPath));
      }
      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: `Read git show for ${input.ref}.`,
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_blame") {
      const input = gitBlameInputSchema.parse(rawInput);
      const targetPath = resolveSafeWorkspacePath(ctx.workspaceRoot, input.relativePath);

      const normalizedPath = formatPathForWorkspace(ctx.workspaceRoot, targetPath);
      const args = ["blame", "--line-porcelain"];

      if (input.lineStart !== undefined && input.lineEnd !== undefined) {
        if (input.lineStart > input.lineEnd) {
          throw new Error("lineStart must be less than or equal to lineEnd.");
        }
        args.push("-L", `${input.lineStart},${input.lineEnd}`);
      } else if (input.lineStart !== undefined) {
        args.push("-L", `${input.lineStart},+1`);
      }

      if (input.ref) args.push(input.ref);
      args.push("--", normalizedPath);

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: `Read git blame for ${input.relativePath}.`,
        artifacts: [input.relativePath],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_checkout") {
      const input = gitCheckoutInputSchema.parse(rawInput);
      const args = ["checkout"];
      if (input.create) {
        args.push("-b", input.branch);
        if (input.source) args.push(input.source);
      } else {
        args.push(input.branch);
      }

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: `Checked out ${input.create ? "new branch " : ""}${input.branch}.`,
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_branch") {
      const input = gitBranchInputSchema.parse(rawInput);
      const args = ["branch"];

      if (input.action === "list") {
        if (input.all) args.push("-a");
      } else if (input.action === "current") {
        const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, ["rev-parse", "--abbrev-ref", "HEAD"]);
        return {
          ok: true,
          summary: "Read current branch.",
          artifacts: [],
          logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
          errors: []
        };
      } else if (input.action === "create") {
        args.push(input.branch ? input.branch : "");
        if (input.startPoint) args.push(input.startPoint);
      } else if (input.action === "delete") {
        if (input.force) args.push("-D");
        else args.push("-d");
        if (!input.branch) {
          throw new Error("branch is required for action=delete.");
        }
        args.push(input.branch);
      } else {
        if (!input.branch || !input.newName) {
          throw new Error("branch and newName are required for action=rename.");
        }
        if (input.force) args.push("-M");
        else args.push("-m");
        args.push(input.branch, input.newName);
      }

      if (input.action !== "create" && args.length > 1 && args[1] === "") {
        throw new Error("branch is required for this action.");
      }
      if (input.action === "create" && !input.branch) {
        throw new Error("branch is required for action=create.");
      }

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: `Ran git branch ${input.action}.`,
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_stash") {
      const input = gitStashInputSchema.parse(rawInput);
      const args = ["stash"];

      if (input.action === "list") {
        args.push("list");
      } else if (input.action === "clear") {
        args.push("clear");
      } else if (input.action === "push") {
        args.push("push");
        if (input.message) {
          args.push("-m", input.message);
        }
        if (input.path) {
          const targetPath = resolveSafeWorkspacePath(ctx.workspaceRoot, input.path);
          args.push("--", formatPathForWorkspace(ctx.workspaceRoot, targetPath));
        }
      } else if (input.action === "pop") {
        args.push("pop");
        if (input.ref) args.push(input.ref);
      } else if (input.action === "apply") {
        args.push("apply");
        if (input.ref) args.push(input.ref);
      } else {
        args.push("drop");
        if (!input.ref) {
          throw new Error("ref is required for drop action.");
        }
        args.push(input.ref);
      }

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: `Ran git stash ${input.action}.`,
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_tag") {
      const input = gitTagInputSchema.parse(rawInput);
      const args = ["tag"];

      if (input.action === "list") {
        if (input.force) args.push("-n");
      } else if (input.action === "current") {
        const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, ["describe", "--tags", "--abbrev=0", "--exact-match"]);
        return {
          ok: true,
          summary: "Read current tag (exact match).",
          artifacts: [],
          logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
          errors: []
        };
      } else if (input.action === "create") {
        if (!input.name) {
          throw new Error("name is required for action=create.");
        }
        if (input.force) args.push("-f");
        if (input.message) {
          args.push("-a", "-m", input.message);
        }
        args.push(input.name);
        if (input.target) args.push(input.target);
      } else if (input.action === "delete") {
        args.push("-d");
        if (input.force) args.push("-f");
        if (!input.name) {
          throw new Error("name is required for action=delete.");
        }
        args.push(input.name);
      } else {
        if (!input.name) {
          throw new Error("name is required for action=show.");
        }
        args.push("-l", input.name);
      }

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: `Ran git tag ${input.action}.`,
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_add") {
      const input = gitAddInputSchema.parse(rawInput);
      if (!input.path && !input.all && !input.update) {
        throw new Error("Either path or all/update must be provided.");
      }
      if (input.all && input.update) {
        throw new Error("Choose one of all or update, not both.");
      }

      const args = ["add"];
      if (input.all) args.push("--all");
      if (input.update) args.push("-u");

      if (input.path) {
        const targetPath = resolveSafeWorkspacePath(ctx.workspaceRoot, input.path);
        args.push("--", formatPathForWorkspace(ctx.workspaceRoot, targetPath));
      }

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: `Staged changes with git add.`,
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_reset") {
      const input = gitResetInputSchema.parse(rawInput);

      if (input.path && input.mode === "hard") {
        throw new Error("hard reset with path is not supported.");
      }

      const args = ["reset"];
      if (input.mode === "soft") args.push("--soft");
      if (input.mode === "hard") args.push("--hard");

      if (input.target) args.push(input.target);

      if (input.path) {
        const targetPath = resolveSafeWorkspacePath(ctx.workspaceRoot, input.path);
        args.push("--", formatPathForWorkspace(ctx.workspaceRoot, targetPath));
      }

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: `Ran git reset (${input.mode}).`,
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_rebase") {
      const input = gitRebaseInputSchema.parse(rawInput);

      if (input.action === "continue") {
        const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, ["rebase", "--continue"]);
        return {
          ok: true,
          summary: "Continued git rebase.",
          artifacts: [],
          logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
          errors: []
        };
      }

      if (input.action === "abort") {
        const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, ["rebase", "--abort"]);
        return {
          ok: true,
          summary: "Aborted git rebase.",
          artifacts: [],
          logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
          errors: []
        };
      }

      if (input.action === "skip") {
        const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, ["rebase", "--skip"]);
        return {
          ok: true,
          summary: "Skipped a git rebase commit.",
          artifacts: [],
          logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
          errors: []
        };
      }

      if (!input.upstream) {
        throw new Error("upstream is required for action=start.");
      }

      const args = ["rebase"];
      if (input.onto) {
        args.push("--onto", input.onto);
      }
      args.push(input.upstream);

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: "Started git rebase.",
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_bisect") {
      const input = gitBisectInputSchema.parse(rawInput);
      const args = ["bisect"];

      if (input.action === "start") {
        args.push("start");
        if (input.bad) args.push(input.bad);
        if (input.good) args.push(input.good);
      } else if (input.action === "bad") {
        if (!input.commit) {
          throw new Error("commit is required for action=bad.");
        }
        args.push("bad", input.commit);
      } else if (input.action === "good") {
        if (!input.commit) {
          throw new Error("commit is required for action=good.");
        }
        args.push("good", input.commit);
      } else if (input.action === "skip") {
        args.push("skip");
        if (input.commit) args.push(input.commit);
      } else if (input.action === "reset") {
        args.push("reset");
        if (input.resetRef) args.push(input.resetRef);
      } else {
        args.push("log");
      }

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: `Ran git bisect ${input.action}.`,
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_cherry_pick") {
      const input = gitCherryPickInputSchema.parse(rawInput);
      const args = ["cherry-pick"];

      if (input.action === "continue") {
        args.push("--continue");
      } else if (input.action === "abort") {
        args.push("--abort");
      } else if (input.action === "skip") {
        args.push("--skip");
      } else {
        if (!input.commit) {
          throw new Error("commit is required for action=pick.");
        }
        if (input.noCommit) args.push("--no-commit");
        if (input.signoff) args.push("--signoff");
        if (input.mainline !== undefined) args.push("--mainline", `${input.mainline}`);
        if (input.noVerify) args.push("--no-verify");
        args.push(input.commit);
      }

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: `Ran git cherry-pick ${input.action}.`,
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_ls_files") {
      const input = gitLsFilesInputSchema.parse(rawInput);
      const args = ["ls-files"];

      if (input.stage) args.push("-s");
      if (input.untracked) args.push("-o");
      if (input.ignored) args.push("-i");
      if (input.modified) args.push("-m");
      if (input.deleted) args.push("-d");
      if (input.excludeStandard) args.push("--exclude-standard");

      if (input.path) {
        args.push("--", input.path);
      }

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: "Ran git ls-files.",
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_submodule") {
      const input = gitSubmoduleInputSchema.parse(rawInput);
      const args = ["submodule"];

      if (input.action === "init") {
        args.push("init");
        if (input.path) args.push("--", input.path);
      } else if (input.action === "status") {
        args.push("status");
        if (input.recursive) args.push("--recursive");
        if (input.path) args.push("--", input.path);
      } else if (input.action === "update") {
        args.push("update");
        if (input.remote) args.push("--remote");
        if (input.recursive) args.push("--recursive");
        if (input.path) args.push("--", input.path);
      } else if (input.action === "sync") {
        args.push("sync");
        if (input.recursive) args.push("--recursive");
        if (input.path) args.push("--", input.path);
      } else if (input.action === "add") {
        if (!input.url) {
          throw new Error("url is required for action=add.");
        }
        args.push("add");
        if (input.force) args.push("--force");
        if (input.path) {
          args.push(input.url, input.path);
        } else {
          args.push(input.url);
        }
      } else {
        args.push("deinit");
        if (input.force) args.push("--force");
        if (!input.path) {
          throw new Error("path is required for action=deinit.");
        }
        args.push("--", input.path);
      }

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: `Ran git submodule ${input.action}.`,
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_notes") {
      const input = gitNotesInputSchema.parse(rawInput);
      const args = ["notes"];

      if (input.namespace && input.scope) {
        throw new Error("namespace and scope are mutually exclusive.");
      }
      if (input.namespace) {
        args.push(`--ref=${input.namespace}`);
      } else if (input.scope) {
        args.push(`--ref=${input.scope}`);
      }

      if (input.action === "add") {
        if (!input.commit || !input.message) {
          throw new Error("commit and message are required for action=add.");
        }
        args.push("add", "-m", input.message, input.commit);
      } else if (input.action === "list") {
        args.push("list");
        if (input.commit) args.push(input.commit);
      } else if (input.action === "show") {
        if (!input.commit) {
          throw new Error("commit is required for action=show.");
        }
        args.push("show", input.commit);
      } else {
        if (!input.commit) {
          throw new Error("commit is required for action=remove.");
        }
        args.push("remove", input.commit);
      }

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: `Ran git notes ${input.action}.`,
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_worktree") {
      const input = gitWorktreeInputSchema.parse(rawInput);
      const args = ["worktree"];

      if (input.action === "list") {
        args.push("list");
      } else if (input.action === "add") {
        args.push("add");
        if (input.force) args.push("--force");
        if (input.noCheckout) args.push("--no-checkout");
        if (input.branch) args.push("-b", input.branch);
        if (!input.path) {
          throw new Error("path is required for action=add.");
        }
        const targetPath = resolveSafeWorkspacePath(ctx.workspaceRoot, input.path);
        args.push(formatPathForWorkspace(ctx.workspaceRoot, targetPath));
        if (input.commit) args.push(input.commit);
      } else if (input.action === "remove") {
        args.push("remove");
        if (input.force) args.push("--force");
        if (!input.path) {
          throw new Error("path is required for action=remove.");
        }
        const targetPath = resolveSafeWorkspacePath(ctx.workspaceRoot, input.path);
        args.push(formatPathForWorkspace(ctx.workspaceRoot, targetPath));
      } else if (input.action === "move") {
        if (!input.path || !input.newPath) {
          throw new Error("path and newPath are required for action=move.");
        }
        args.push("move", "--force");
        const targetPath = resolveSafeWorkspacePath(ctx.workspaceRoot, input.path);
        const newTargetPath = resolveSafeWorkspacePath(ctx.workspaceRoot, input.newPath);
        args.push(formatPathForWorkspace(ctx.workspaceRoot, targetPath), formatPathForWorkspace(ctx.workspaceRoot, newTargetPath));
      } else if (input.action === "lock") {
        args.push("lock");
        if (!input.path) {
          throw new Error("path is required for action=lock.");
        }
        const targetPath = resolveSafeWorkspacePath(ctx.workspaceRoot, input.path);
        args.push(formatPathForWorkspace(ctx.workspaceRoot, targetPath));
      } else if (input.action === "unlock") {
        args.push("unlock");
        if (!input.path) {
          throw new Error("path is required for action=unlock.");
        }
        const targetPath = resolveSafeWorkspacePath(ctx.workspaceRoot, input.path);
        args.push(formatPathForWorkspace(ctx.workspaceRoot, targetPath));
      } else {
        args.push("prune");
        if (input.force) args.push("--expire=all");
      }

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: `Ran git worktree ${input.action}.`,
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_config") {
      const input = gitConfigInputSchema.parse(rawInput);
      if (input.scope === "global" || input.scope === "system") {
        throw new Error("Only the repository-local git config scope is permitted.");
      }
      // Force --local for every operation: global/system config can execute commands
      // (core.pager, core.sshCommand, …) on any later git run.
      const args = ["config", "--local"];
      const assertWritableConfigKey = (key: string) => {
        if (!WRITABLE_GIT_CONFIG_KEYS.has(key.toLowerCase())) {
          throw new Error(`Setting git config key '${key}' is not permitted. Allowed keys: ${[...WRITABLE_GIT_CONFIG_KEYS].join(", ")}.`);
        }
      };

      if (input.action === "list") {
        args.push("--list");
      } else if (input.action === "get") {
        if (!input.key) {
          throw new Error("key is required for action=get.");
        }
        args.push("--get", input.key);
      } else if (input.action === "set") {
        if (!input.key || input.value === undefined) {
          throw new Error("key and value are required for action=set.");
        }
        assertWritableConfigKey(input.key);
        args.push(input.key, input.value);
      } else if (input.action === "add") {
        if (!input.key || input.value === undefined) {
          throw new Error("key and value are required for action=add.");
        }
        assertWritableConfigKey(input.key);
        args.push("--add", input.key, input.value);
      } else {
        if (!input.key) {
          throw new Error("key is required for action=unset.");
        }
        assertWritableConfigKey(input.key);
        args.push("--unset", input.key);
      }

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: `Ran git config ${input.action}.`,
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_archive") {
      const input = gitArchiveInputSchema.parse(rawInput);
      const args = ["archive"];

      if (input.action === "list") {
        args.push("--list");
      } else {
        if (!input.output) {
          throw new Error("output is required for action=create.");
        }
        // Without this, --output=../../x escapes the workspace (arbitrary file write).
        const safeOutput = resolveSafeWorkspacePath(ctx.workspaceRoot, input.output);
        if (input.prefix && input.prefix.startsWith("-")) throw new Error("prefix must not start with '-'.");
        const treeish = input.treeish ?? "HEAD";
        if (treeish.startsWith("-")) throw new Error("treeish must not start with '-'.");
        args.push(`--format=${input.format}`);
        args.push(`--output=${safeOutput}`);
        if (input.prefix) args.push(`--prefix=${input.prefix}`);
        args.push(treeish);
        if (input.path) {
          args.push("--", input.path);
        }
      }

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: `Ran git archive ${input.action}.`,
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_diff_staged") {
      const input = gitDiffStagedInputSchema.parse(rawInput);
      const args = ["diff", "--cached"];
      if (input.stat) args.push("--stat");
      if (input.path) {
        const targetPath = resolveSafeWorkspacePath(ctx.workspaceRoot, input.path);
        args.push("--", formatPathForWorkspace(ctx.workspaceRoot, targetPath));
      }

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: "Read git staged diff.",
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_merge_base") {
      const input = gitMergeBaseInputSchema.parse(rawInput);
      const args = ["merge-base"];
      if (input.all) args.push("--all");
      if (input.forkPoint) args.push("--fork-point");
      args.push(input.commit ?? "HEAD");
      if (input.other) args.push(input.other);

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: "Read git merge-base.",
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_count_objects") {
      const input = gitCountObjectsInputSchema.parse(rawInput);
      const args = ["count-objects"];
      if (input.verbose) args.push("-v");
      if (input.action === "size-pack") {
        args.push("--pack-size");
      } else if (input.prune) {
        args.push("--prune");
      }
      if (input.humanReadable && input.action === "size-pack") {
        args.push("--human-readable");
      }

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: `Ran git count-objects ${input.action}.`,
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_verify_pack") {
      const input = gitVerifyPackInputSchema.parse(rawInput);
      const args = ["verify-pack"];

      if (input.action === "stats") {
        args.push("-s");
      } else {
        if (input.verbose) args.push("-v");
      }

      if (input.all) args.push("--all");
      if (input.hashAlgo) args.push(`--hash=${input.hashAlgo}`);
      args.push(input.pack);

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: `Ran git verify-pack ${input.action}.`,
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_fsck") {
      const input = gitFsckInputSchema.parse(rawInput);
      const args = ["fsck"];

      if (input.verbose) args.push("-v");
      if (input.strict) args.push("--strict");

      if (input.action === "full") {
        args.push("--full");
      } else if (input.action === "connectivity") {
        args.push("--connectivity-only");
      } else if (input.action === "prune") {
        if (input.pruneDate) {
          args.push(`--prune=${input.pruneDate}`);
        } else {
          args.push("--prune");
        }
      } else {
        // check
      }

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: "Ran git fsck.",
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_reflog") {
      const input = gitReflogInputSchema.parse(rawInput);
      const args = ["reflog"];

      if (input.action === "show") {
        args.push("show");
        if (input.all) args.push("--all");
        args.push(input.ref ?? "HEAD");
      } else if (input.action === "expire") {
        args.push("expire");
        if (input.all) args.push("--all");
        if (input.staleOnly) args.push("--stale-fix");
        if (input.maxAge) args.push(`--expire=${input.maxAge}`);
        if (input.ref) args.push(input.ref);
      } else {
        if (!input.ref) {
          throw new Error("ref is required for action=delete.");
        }
        args.push("delete");
        if (input.rewrite) args.push("--rewrite");
        if (input.updateref) args.push("--updateref");
        args.push(input.ref);
      }

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: `Ran git reflog ${input.action}.`,
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_maintenance") {
      const input = gitMaintenanceInputSchema.parse(rawInput);
      const args = ["maintenance"];

      if (input.action === "run") {
        args.push("run");
        const tasks = [];
        if (input.tasks && input.tasks.length > 0) {
          tasks.push(...input.tasks);
        } else if (input.task) {
          tasks.push(input.task);
        }
        for (const t of tasks) {
          args.push("--task", t);
        }
      } else {
        args.push(input.action);
      }

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: `Ran git maintenance ${input.action}.`,
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_prune") {
      const input = gitPruneInputSchema.parse(rawInput);
      const args = ["prune"];

      if (input.progress) args.push("--progress");
      if (input.verbose) args.push("--verbose");
      if (input.expire) args.push(`--expire=${input.expire}`);
      if (input.expireUnreachable) args.push(`--expire-unreachable=${input.expireUnreachable}`);
      if (input.includeAll) args.push("--all");
      if (input.action === "dry-run") args.push("--dry-run");

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: `Ran git prune (${input.action}).`,
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_repack") {
      const input = gitRepackInputSchema.parse(rawInput);
      const args = ["repack"];

      if (input.all) args.push("--all");
      if (input.aggressive) args.push("--aggressive");
      if (input.noGc) args.push("--no-gc");
      if (input.keepPack) args.push("--keep-pack");
      if (input.noPrune) args.push("--no-prune");
      if (input.local) args.push("--local");
      if (input.writeBitmapIndex) args.push("--write-bitmap-index");
      if (input.window !== undefined) args.push(`--window=${input.window}`);
      if (input.depth !== undefined) args.push(`--depth=${input.depth}`);
      if (input.maxPackSize) args.push(`--max-pack-size=${input.maxPackSize}`);

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: "Ran git repack.",
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_show_ref") {
      const input = gitShowRefInputSchema.parse(rawInput);
      const args = ["show-ref"];

      if (input.dereference) args.push("--dereference");
      if (input.quiet) args.push("--quiet");
      if (input.all) args.push("--all");
      if (input.abbrev !== undefined) args.push(`--abbrev=${input.abbrev}`);

      if (input.action === "heads" || input.heads) {
        args.push("heads");
      } else if (input.action === "tags" || input.tags) {
        args.push("tags");
      } else {
        if (input.action !== "list") {
          throw new Error("Unsupported action for git_show_ref.");
        }
      }

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: `Ran git show-ref ${input.action}.`,
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_symbolic_ref") {
      const input = gitSymbolicRefInputSchema.parse(rawInput);
      const args = ["symbolic-ref"];

      if (input.log) args.push("--log");
      if (input.quiet) args.push("--quiet");
      if (input.short) {
        args.push("--short");
      }

      if (input.action === "get") {
        if (!input.ref) {
          throw new Error("ref is required for action=get.");
        }
        args.push(input.ref);
      } else if (input.action === "set") {
        if (!input.ref || !input.newRef) {
          throw new Error("ref and newRef are required for action=set.");
        }
        args.push("-m", `Set ${input.ref} to ${input.newRef}`);
        args.push(input.ref, input.newRef);
      } else if (input.action === "short") {
        args.push("--short");
        if (!input.ref) {
          throw new Error("ref is required for action=short.");
        }
        args.push(input.ref);
      } else {
        if (!input.ref) {
          throw new Error("ref is required for action=delete.");
        }
        args.push("-d");
        args.push(input.ref);
      }

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: `Ran git symbolic-ref ${input.action}.`,
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_for_each_ref") {
      const input = gitForEachRefInputSchema.parse(rawInput);
      const args = ["for-each-ref"];

      if (input.format) args.push(`--format=${input.format}`);
      if (input.sort) args.push(`--sort=${input.sort}`);
      if (input.count) args.push(`--count=${input.count}`);
      if (input.contains) args.push(`--contains=${input.contains}`);
      if (input.merged) args.push(`--merged=${input.merged}`);
      if (input.pointsAt) args.push(`--points-at=${input.pointsAt}`);
      if (input.abbrev !== undefined) args.push(`--format=%(objectname:short=${input.abbrev}) %(refname:short)`);

      if (input.action === "heads") {
        args.push("refs/heads");
      } else if (input.action === "tags") {
        args.push("refs/tags");
      } else if (input.action === "remotes") {
        args.push("refs/remotes");
      } else if (input.action === "all") {
        args.push("refs/");
      } else {
        if (!input.pattern) {
          throw new Error("pattern is required for action=pattern.");
        }
        args.push(input.pattern);
      }

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: `Ran git for-each-ref ${input.action}.`,
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_update_ref") {
      const input = gitUpdateRefInputSchema.parse(rawInput);
      const args = ["update-ref"];

      if (input.force) args.push("--no-deref");
      if (input.noDeref) args.push("--no-deref");
      if (input.noDerefFrom) args.push("--no-deref-from");
      if (input.reason) args.push("-m", input.reason);

      if (input.action === "list") {
        args.push("--list");
      } else if (input.action === "create" || input.action === "update") {
        if (!input.ref || !input.newValue) {
          throw new Error("ref and newValue are required for create/update.");
        }
        args.push(input.ref, input.newValue);
        if (input.oldValue) args.push(input.oldValue);
      } else {
        if (!input.ref) {
          throw new Error("ref is required for action=delete.");
        }
        args.push("-d", input.ref);
        if (input.oldValue) args.push(input.oldValue);
      }

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: `Ran git update-ref ${input.action}.`,
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_gc") {
      const input = gitGcInputSchema.parse(rawInput);
      const args = ["gc"];

      if (input.force) args.push("--force");
      if (input.action === "prune") {
        args.push("--prune");
        if (input.prune) args.push(`--prune=${input.prune}`);
      } else if (input.action === "aggressive" || input.aggressive) {
        args.push("--aggressive");
      } else if (input.action === "rerere") {
        args.push("--prune");
      } else {
        args.push("--auto");
      }

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: `Ran git gc ${input.action}.`,
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)],
        errors: []
      };
    }

    if (name === "git_name_rev") {
      const input = gitNameRevInputSchema.parse(rawInput);
      const args = ["name-rev"];

      if (input.nameOnly) args.push("--name-only");
      if (input.tags) args.push("--tags");
      if (input.refs) args.push("--refs");
      if (input.noReflog) args.push("--no-reflog");

      if (input.action === "all") {
        args.push("--all");
      } else {
        if (!input.target) {
          throw new Error("target is required for action=resolve.");
        }
        args.push(input.target);
        if (input.all) args.push("--all");
      }

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: `Ran git name-rev ${input.action}.`,
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_cat_file") {
      const input = gitCatFileInputSchema.parse(rawInput);
      const args = ["cat-file"];

      if (input.action === "type") {
        args.push("-t", input.object);
      } else if (input.action === "size") {
        args.push("-s", input.object);
      } else if (input.action === "pretty") {
        args.push("-p", input.object);
      } else {
        args.push("-e", input.object);
      }

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: `Ran git cat-file ${input.action}.`,
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_check_ref_format") {
      const input = gitCheckRefFormatInputSchema.parse(rawInput);
      const args = ["check-ref-format"];
      if (input.normalize) args.push("--normalize");
      if (input.allowOneLevel) args.push("--allow-onelevel");
      if (input.branch) args.push("--branch");
      if (input.noReflog) args.push("--no-reflog");
      args.push(input.ref);

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: "Ran git check-ref-format.",
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_rev_parse") {
      const input = gitRevParseInputSchema.parse(rawInput);
      if (input.action === "show-ref") {
        if (!input.value) {
          throw new Error("value is required for action=show-ref.");
        }
        const { stdout, stderr } = await gitCommand(
          ctx.workspaceRoot,
          ctx.commandTimeoutMs,
          ["rev-parse", "--verify", input.value]
        );
        return {
          ok: true,
          summary: "Ran git rev-parse show-ref.",
          artifacts: [],
          logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
          errors: []
        };
      }

      if (input.action === "is-inside-work-tree") {
        const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, ["rev-parse", "--is-inside-work-tree"]);
        return {
          ok: true,
          summary: "Ran git rev-parse is-inside-work-tree.",
          artifacts: [],
          logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
          errors: []
        };
      }

      if (input.action === "is-bare-repository") {
        const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, ["rev-parse", "--is-bare-repository"]);
        return {
          ok: true,
          summary: "Ran git rev-parse is-bare-repository.",
          artifacts: [],
          logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
          errors: []
        };
      }

      if (input.action === "short-sha") {
        if (!input.value) {
          throw new Error("value is required for action=short-sha.");
        }
        const args = ["rev-parse"];
        if (input.short) args.push(`--short=${input.short}`);
        args.push(input.value);
        const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
        return {
          ok: true,
          summary: `Ran git rev-parse short-sha.`,
          artifacts: [],
          logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
          errors: []
        };
      }

      if (input.action === "verify") {
        if (!input.value) {
          throw new Error("value is required for action=verify.");
        }
        const args = ["rev-parse", "--verify"];
        if (input.always) args.push("--quiet");
        args.push(input.value);
        const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
        return {
          ok: true,
          summary: "Ran git rev-parse verify.",
          artifacts: [],
          logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
          errors: []
        };
      }

      if (input.action === "default-branch") {
        try {
          const originHead = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]);
          const target = originHead.stdout.trim().replace(/^refs\/remotes\/[^/]+\//, "");
          const logs = [safePreview(originHead.stdout), safePreview(originHead.stderr)].filter(Boolean);
          if (!target) {
            throw new Error("origin/HEAD exists but is empty.");
          }

          return {
            ok: true,
            summary: "Ran git rev-parse default-branch.",
            artifacts: [],
            logs,
            errors: []
          };
        } catch (_originError) {
          const head = await gitCommand(
            ctx.workspaceRoot,
            ctx.commandTimeoutMs,
            ["rev-parse", "--abbrev-ref", "HEAD"]
          );
          const target = head.stdout.trim();
          const logs = [safePreview(head.stdout), safePreview(head.stderr)].filter(Boolean);
          if (!target || target === "HEAD") {
            throw new Error("HEAD does not have a stable branch name.");
          }
          return {
            ok: true,
            summary: "Ran git rev-parse default-branch fallback to HEAD.",
            artifacts: [],
            logs,
            errors: []
          };
        }
      }

      throw new Error(`Unsupported action for git_rev_parse: ${input.action}.`);
    }

    if (name === "git_lfs") {
      const input = gitLfsInputSchema.parse(rawInput);
      const args = ["lfs"];

      if (input.action === "install") {
        args.push("install");
      } else if (input.action === "track") {
        if (!input.pattern) throw new Error("pattern is required for action=track.");
        args.push("track", input.pattern);
      } else if (input.action === "untrack") {
        if (!input.pattern) throw new Error("pattern is required for action=untrack.");
        args.push("untrack", input.pattern);
      } else if (input.action === "status") {
        args.push("status");
      } else if (input.action === "track-list") {
        args.push("track");
      } else if (input.action === "fetch") {
        args.push("fetch");
        if (input.all) args.push("--all");
        if (input.include) args.push(`--include=${input.include}`);
        if (input.exclude) args.push(`--exclude=${input.exclude}`);
        if (input.remote) args.push(input.remote);
      } else if (input.action === "pull") {
        args.push("pull");
        if (input.all) args.push("--all");
        if (input.include) args.push(`--include=${input.include}`);
        if (input.exclude) args.push(`--exclude=${input.exclude}`);
        if (input.remote) args.push(input.remote);
      } else {
        args.push("push");
        if (input.all) args.push("--all");
        if (input.include) args.push(`--include=${input.include}`);
        if (input.exclude) args.push(`--exclude=${input.exclude}`);
        if (input.remote) args.push(input.remote);
      }

      if (input.verbose) args.push("--verbose");

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: `Ran git lfs ${input.action}.`,
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_clean") {
      const input = gitCleanInputSchema.parse(rawInput);
      const args = ["clean"];

      if (input.interactive) args.push("-i");
      if (input.force || input.action !== "list") {
        if (input.action !== "list" || input.force) args.push("-f");
      }
      if (input.action === "clean-dirs") args.push("-d");
      if (input.action === "clean-ignored") args.push("-x");
      if (input.action === "clean-ignored-only") args.push("-X");

      if (input.includeIgnored && input.action === "clean") {
        args.push("-x");
      }

      if (input.dryRun) args.push("-n");
      if (input.pathspec) args.push("--", input.pathspec);

      if (input.action === "list" || input.dryRun) {
        if (!args.includes("-n")) args.push("-n");
      }

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: `Ran git clean ${input.action}.`,
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_fetch") {
      const input = gitFetchInputSchema.parse(rawInput);
      const args = ["fetch"];
      if (input.all) args.push("--all");
      if (input.prune) args.push("--prune");
      if (input.depth) {
        args.push(`--depth=${input.depth}`);
      }
      if (!input.all && input.remote) {
        args.push(input.remote);
      }

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: "Ran git fetch.",
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_clone") {
      const input = gitCloneInputSchema.parse(rawInput);
      const args = ["clone"];
      if (input.branch) args.push("--branch", input.branch);
      if (input.depth) args.push(`--depth=${input.depth}`);
      if (input.bare) args.push("--bare");
      if (input.singleBranch) args.push("--single-branch");
      if (input.noCheckout) args.push("--no-checkout");
      // `--` stops a repo/outputDir beginning with `-` from being parsed as an option.
      args.push("--", input.repo);
      if (input.outputDir) args.push(input.outputDir);

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: `Ran git clone ${input.repo}.`,
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_init") {
      const input = gitInitInputSchema.parse(rawInput);
      const args = ["init"];
      if (input.bare) args.push("--bare");
      if (input.shared) args.push("--shared");
      if (input.initialBranch) args.push(`--initial-branch=${input.initialBranch}`);
      if (input.initDir) args.push(input.initDir);

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: "Ran git init.",
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_revert") {
      const input = gitRevertInputSchema.parse(rawInput);
      const args = ["revert"];
      if (input.mainline) args.push(`-m`, `${input.mainline}`);
      if (input.noCommit) args.push("--no-commit");
      if (input.noEdit) args.push("--no-edit");
      args.push(input.commit);

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: `Ran git revert ${input.commit}.`,
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_stash_apply") {
      const input = gitStashApplyInputSchema.parse(rawInput);
      const args = ["stash", "apply"];
      const useIndex = input.index || input.keepIndex;
      if (useIndex) args.push("--index");
      if (input.stash) args.push(input.stash);

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: `Ran git stash apply${input.stash ? ` ${input.stash}` : ""}.`,
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_stash_pop") {
      const input = gitStashPopInputSchema.parse(rawInput);
      const args = ["stash", "pop"];
      const useIndex = input.index || input.keepIndex;
      if (useIndex) args.push("--index");
      if (input.quiet) args.push("--quiet");
      if (input.stash) args.push(input.stash);

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: `Ran git stash pop${input.stash ? ` ${input.stash}` : ""}.`,
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_merge") {
      const input = gitMergeInputSchema.parse(rawInput);
      if (input.abort) {
        const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, ["merge", "--abort"]);
        return {
          ok: true,
          summary: "Aborted in-progress git merge.",
          artifacts: [],
          logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
          errors: []
        };
      }

      if (!input.source) {
        throw new Error("source is required unless abort is true.");
      }

      const args = ["merge"];
      if (input.noFF) args.push("--no-ff");
      args.push(input.source);

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: `Merged ${input.source}.`,
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_pull") {
      const input = gitPullInputSchema.parse(rawInput);
      const args = ["pull"];
      if (input.rebase) args.push("--rebase");
      if (input.ffOnly) args.push("--ff-only");
      if (input.all) args.push("--all");
      if (input.prune) args.push("--prune");
      if (input.depth) args.push(`--depth=${input.depth}`);

      if (input.remote) {
        args.push(input.remote);
      }
      if (input.source) {
        args.push(input.source);
      }

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: "Ran git pull.",
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_push") {
      const input = gitPushInputSchema.parse(rawInput);
      const args = ["push"];
      if (input.forceWithLease) args.push("--force-with-lease");
      if (input.setUpstream) args.push("--set-upstream");
      if (input.all) {
        args.push("--all");
      } else {
        if (input.remote) args.push(input.remote);
        if (input.source) args.push(input.source);
      }

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: "Ran git push.",
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_remote") {
      const input = gitRemoteInputSchema.parse(rawInput);
      const args = ["remote"];

      if (input.action === "list") {
        args.push("-v");
      } else if (input.action === "show") {
        args.push("show");
        if (input.name) args.push(input.name);
      } else if (input.action === "add") {
        if (!input.name || !input.url) {
          throw new Error("name and url are required for action=add.");
        }
        args.push("add", input.name, input.url);
      } else if (input.action === "remove") {
        if (!input.name) {
          throw new Error("name is required for action=remove.");
        }
        args.push("remove", input.name);
      } else if (input.action === "rename") {
        if (!input.name || !input.newName) {
          throw new Error("name and newName are required for action=rename.");
        }
        args.push("rename", input.name, input.newName);
      } else if (input.action === "get-url") {
        if (!input.name) {
          throw new Error("name is required for action=get-url.");
        }
        args.push("get-url", input.name);
      } else if (input.action === "set-url") {
        if (!input.name || !input.url) {
          throw new Error("name and url are required for action=set-url.");
        }
        args.push("set-url", input.name, input.url);
      } else if (input.action === "prune") {
        args.push("prune");
        if (input.name) args.push(input.name);
      }

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: `Ran git remote ${input.action}.`,
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "git_commit") {
      const input = gitCommitInputSchema.parse(rawInput);

      if (!input.amend && !input.message) {
        throw new Error("message is required unless amend is true.");
      }

      const args = ["commit"];
      if (input.all) args.push("-a");
      if (input.allowEmpty) args.push("--allow-empty");
      if (input.amend) {
        args.push("--amend");
        if (input.message) {
          args.push("-m", input.message);
        } else {
          args.push("--no-edit");
        }
      } else if (input.message) {
        args.push("-m", input.message);
      }

      if (input.path) {
        const targetPath = resolveSafeWorkspacePath(ctx.workspaceRoot, input.path);
        args.push("--only", "--", formatPathForWorkspace(ctx.workspaceRoot, targetPath));
      }

      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: input.amend ? "Amended git commit." : "Created git commit.",
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "chmod_mode") {
      const input = chmodModeInputSchema.parse(rawInput);
      const target = resolveSafeWorkspacePath(ctx.workspaceRoot, input.relativePath);

      if (input.mode === undefined) {
        const statInfo = await stat(target);
        const mode = (statInfo.mode & 0o777).toString(8);
        return {
          ok: true,
          summary: `Mode for ${input.relativePath}: ${mode}.`,
          artifacts: [input.relativePath],
          logs: [`mode=${mode}`],
          errors: []
        };
      }

      const normalizedMode = input.mode.startsWith("0") ? input.mode : `0${input.mode}`;
      const modeValue = Number.parseInt(normalizedMode, 8);
      await chmod(target, modeValue);
      return {
        ok: true,
        summary: `Updated mode for ${input.relativePath}: ${input.mode}.`,
        artifacts: [input.relativePath],
        logs: [`mode=${modeValue.toString(8)}`],
        errors: []
      };
    }

    if (name === "file_hash") {
      const input = fileHashInputSchema.parse(rawInput);
      const target = resolveSafeWorkspacePath(ctx.workspaceRoot, input.relativePath);
      const statInfo = await stat(target);
      if (!statInfo.isFile()) {
        throw new Error("file_hash supports regular files only.");
      }
      const digest = await computeFileHash(target, input.algorithm);
      return {
        ok: true,
        summary: `Computed ${input.algorithm} for ${input.relativePath}.`,
        artifacts: [input.relativePath],
        logs: [
          `path=${input.relativePath}`,
          `algorithm=${input.algorithm}`,
          `size=${statInfo.size}`,
          `digest=${digest}`
        ],
        errors: []
      };
    }

    if (name === "folder_size") {
      const input = folderSizeInputSchema.parse(rawInput);
      const target = resolveSafeWorkspacePath(ctx.workspaceRoot, input.relativePath);
      const statInfo = await stat(target);
      if (!statInfo.isDirectory()) {
        throw new Error("folder_size supports directory paths only.");
      }

      const sizeInfo = await computeFolderSize(target, input.recursive, input.maxDepth, input.includeHidden);
      return {
        ok: true,
        summary: `Computed size for folder ${input.relativePath}.`,
        artifacts: [input.relativePath],
        logs: [
          `path=${input.relativePath}`,
          `recursive=${input.recursive}`,
          `maxDepth=${input.maxDepth}`,
          `includeHidden=${input.includeHidden}`,
          `totalBytes=${sizeInfo.totalBytes}`,
          `files=${sizeInfo.files}`,
          `directories=${sizeInfo.directories}`,
          `symlinks=${sizeInfo.symlinks}`
        ],
        errors: []
      };
    }

    if (name === "file_info") {
      const input = fileInfoInputSchema.parse(rawInput);
      const target = resolveSafeWorkspacePath(ctx.workspaceRoot, input.relativePath);
      const statInfo = await stat(target);
      return {
        ok: true,
        summary: `File info for ${input.relativePath}`,
        artifacts: [input.relativePath],
        logs: [JSON.stringify({
          path: input.relativePath,
          kind: statInfo.isDirectory() ? "directory" : "file",
          size: statInfo.size,
          createdAt: statInfo.birthtime.toISOString(),
          modifiedAt: statInfo.mtime.toISOString(),
          accessedAt: statInfo.atime.toISOString(),
          mode: statInfo.mode
        }, null, 2)],
        errors: []
      };
    }

    if (name === "git_log") {
      const input = gitLogInputSchema.parse(rawInput);
      const args = ["log", `-n`, `${input.maxCount}`, "--oneline", "--no-color"];
      if (input.path) {
        const targetPath = resolveSafeWorkspacePath(ctx.workspaceRoot, input.path);
        args.push("--", formatPathForWorkspace(ctx.workspaceRoot, targetPath));
      }
      const { stdout, stderr } = await gitCommand(ctx.workspaceRoot, ctx.commandTimeoutMs, args);
      return {
        ok: true,
        summary: "Read git log.",
        artifacts: [],
        logs: [safePreview(stdout), safePreview(stderr)].filter(Boolean),
        errors: []
      };
    }

    if (name === "create_project") {
      const input = createProjectInputSchema.parse(rawInput);
      const project = await createProject(ctx.projectRoot, {
        title: input.title,
        summary: input.summary,
        entryFile: input.entryFile,
        createdByClientId: ctx.clientId
      });
      return {
        ok: true,
        summary: `Created project ${project.id}.`,
        jobId: project.id,
        artifacts: [project.id],
        logs: [JSON.stringify(project, null, 2)],
        errors: []
      };
    }

    if (name === "list_projects") {
      const input = listProjectsInputSchema.parse(rawInput);
      const projects = await listProjects(ctx.projectRoot, input.includeDeleted);
      return {
        ok: true,
        summary: `Found ${projects.length} project(s).`,
        artifacts: projects.map((project) => project.id),
        logs: [JSON.stringify(projects, null, 2)],
        errors: []
      };
    }

    if (name === "get_project") {
      const input = projectIdInputSchema.parse(rawInput);
      const project = await getProjectWithFiles(ctx.projectRoot, input.projectId);
      return {
        ok: true,
        summary: `Loaded project ${input.projectId}.`,
        jobId: input.projectId,
        shareUrl: project.metadata.publishedUrl,
        previewUrl: project.metadata.publishedUrl,
        artifacts: project.files.map((file) => file.path),
        logs: [JSON.stringify(project, null, 2)],
        errors: []
      };
    }

    if (name === "write_project_file") {
      const input = writeProjectFileInputSchema.parse(rawInput);
      const file = await writeProjectFile(ctx.projectRoot, input.projectId, input.relativePath, input.content);
      return {
        ok: true,
        summary: `Wrote ${file.path} in project ${input.projectId}.`,
        jobId: input.projectId,
        artifacts: [file.path],
        logs: [JSON.stringify(file, null, 2)],
        errors: []
      };
    }

    if (name === "read_project_file") {
      const input = readProjectFileInputSchema.parse(rawInput);
      const content = await readProjectFile(ctx.projectRoot, input.projectId, input.relativePath, input.maxBytes);
      return {
        ok: true,
        summary: `Read ${input.relativePath} from project ${input.projectId}.`,
        jobId: input.projectId,
        artifacts: [input.relativePath],
        logs: [content],
        errors: []
      };
    }

    if (name === "delete_project_file") {
      const input = deleteProjectFileInputSchema.parse(rawInput);
      await deleteProjectFile(ctx.projectRoot, input.projectId, input.relativePath);
      return {
        ok: true,
        summary: `Deleted ${input.relativePath} from project ${input.projectId}.`,
        jobId: input.projectId,
        artifacts: [input.relativePath],
        logs: [],
        errors: []
      };
    }

    if (name === "publish_project") {
      const input = publishProjectInputSchema.parse(rawInput);
      const project = await publishProject(ctx.projectRoot, input.projectId, ctx.publicBaseUrl, input.entryFile, { shareBasePath: ctx.publicShareBasePath });
      return {
        ok: true,
        summary: `Published project ${input.projectId}.`,
        jobId: input.projectId,
        previewUrl: project.publishedUrl,
        shareUrl: project.publishedUrl,
        artifacts: [project.entryFile],
        logs: [JSON.stringify(project, null, 2)],
        errors: []
      };
    }

    if (name === "delete_project") {
      const input = deleteProjectInputSchema.parse(rawInput);
      const project = await deleteProject(ctx.projectRoot, input.projectId);
      return {
        ok: true,
        summary: `Soft-deleted project ${input.projectId}.`,
        jobId: input.projectId,
        artifacts: [],
        logs: [JSON.stringify(project, null, 2)],
        errors: []
      };
    }

    if (name === "create_share") {
      const input = createShareInputSchema.parse(rawInput);
      const share = await createShareArtifact({
        shareRoot: ctx.shareRoot,
        title: input.title,
        summary: input.summary,
        filename: input.filename,
        html: input.html,
        ownerUserId: ctx.userId
      });
      const shareUrl = makeShareUrl(ctx.publicBaseUrl, share.id, share.filename);
      const result = createJobResult(ctx, `Shared ${share.filename}`, input.summary, ["Share artifact created."], [`share/${share.id}/${share.filename}`]);
      return {
        ...result,
        previewUrl: shareUrl,
        shareUrl
      };
    }

    return {
      ok: false,
      summary: `Unknown tool: ${name}`,
      artifacts: [],
      logs: [],
      errors: [`Unknown tool: ${name}`]
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown tool execution error.";
    return {
      ok: false,
      summary: `Tool ${name} failed.`,
      artifacts: [],
      logs: [],
      errors: [message]
    };
  }
}
