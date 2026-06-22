# Project Workflows: published file-store vs. Git workspace

Code-MCP has **two different project workflows**. Confusing them is the usual cause of "git
tools fail" reports — git tools only apply to the second one.

## 1. Published file-store project (the default; what `create_project` makes)

- `create_project` → `write_project_file` / `write_project_asset` → `validate_project` →
  `publish_project` → public `…/share/<id>/…` URL.
- Files live in a **content store** (`projects/<id>/files`), **not** a Git repository.
- This is the path for "generate a page and publish it." It needs no Git.
- Running `git_status` / `git_diff` / `git_commit` against such a project fails with
  **"Project is not bound to a Git repository"** — that is correct, not a bug. There is simply
  no repo here.

## 2. Bound Git workspace (for real version-controlled dev)

- A project is bound to a real on-disk Git work tree; then `git_status`, `git_diff`,
  `git_commit`, `run_project_build`, `run_project_npm_command`, `apply_patch`,
  `inspect_project_workspace`, etc. operate on that work tree.
- Two ways to get one:
  - **`bind_project_workspace`** — bind to a Git repo that **already exists** inside the
    tenant workspace root. (It rejects a path that is not already a Git work tree.)
  - **`init_project_git`** — bootstrap one from scratch (see below). Use this when there is no
    repo to bind yet — which is the normal situation for a freshly created project.

## `init_project_git` — bootstrap Git for a project

```
init_project_git({ projectId, relativePath?, importProjectFiles? })
```

What it does, in one call:

1. Creates `relativePath` (default `workspace`) inside the tenant workspace root.
2. `git init -b main` and sets a **local** commit identity
   (`Coding MCP Agent <agent@coding-mcp.local>`). This is required because the git child
   environment neutralizes global/system Git config for security, so a repo must carry its own
   identity or `git commit` fails.
3. Imports the project's current stored files (`importProjectFiles`, default `true`).
4. Makes an initial commit.
5. Binds the project to the new repo.

After it returns, the Git tools work. It is **idempotent** — re-running just rebinds the
existing repo.

Typical use, e.g. after ChatGPT reviews a generated page:

```
init_project_git({ projectId })
git_status({ projectId })          # now OK (was "not bound")
git_diff({ projectId })
git_commit({ projectId, message: "Fix CTA overflow on mobile" })
```

## ⚠️ Caveat: the file-store and the Git workspace can diverge

`init_project_git` **copies** the project's stored files into the Git workspace. They are then
two separate copies:

- `write_project_file` / `write_project_asset` write to the **file-store** (the publish path),
  **not** the Git workspace.
- The Git workspace is changed with the **workspace** tools — `apply_patch`,
  `write_project_workspace_asset`, `import_project_workspace_asset_from_local_file`,
  `run_project_npm_command` — and then committed.

So pick one editing path per project and stay on it:

- **Publish-only** → keep using `write_project_file` + `publish_project`; do not init Git.
- **Git-versioned dev** → after `init_project_git`, edit in the workspace (`apply_patch` etc.)
  and `git_commit`; use `publish_project_workspace` to publish the built output.

Mixing them (editing via `write_project_file` after init) leaves the Git workspace stale. To
re-sync, re-run `init_project_git` (it re-imports and rebinds).

## Tenant isolation

A ChatGPT connector authenticates via OAuth and gets its **own** workspace root under
`/data/users/<userId>/` (an isolated Docker volume). `init_project_git` writes there, never into
another tenant's space or the server's host repo. (Only the local dev-token / global path uses
`/data/workspace`, which in the Docker setup is the bind-mounted host repo — avoid initializing
Git there.)
