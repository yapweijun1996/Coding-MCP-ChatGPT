# Project CRUD and Sharing

This MCP stores ChatGPT-created coding projects on disk under `.projects/`.

## Storage layout

```text
.projects/
  project_<uuid>/
    project.json
    files/
      index.html
      style.css
      app.js
```

`project.json` includes:

- `id`
- `title`
- `summary`
- `createdAt`
- `updatedAt`
- `createdByClientId`
- `status`: `draft`, `published`, or `deleted`
- `entryFile`
- `publishedUrl`
- `workspaceBinding`: optional real local workspace path and detected Git root
- `lastValidation`
- `taskHistory`

## MCP tools

- `create_project`: create a persistent project and return `projectId`.
- `list_projects`: list projects.
- `get_project`: get metadata and file list.
- `get_project_manifest`: get agent-readable metadata, files, entry file, published URL, last validation, and task history.
- `get_project_activity`: get task history, latest validation, publish status, and creator connector.
- `deliver_static_project`: create a project from multiple text files, validate, publish, browser-check, and return a delivery report.
- `write_project_file`: write a text file inside the project.
- `read_project_file`: read a text file inside the project.
- `delete_project_file`: delete a project file with `confirm=true`.
- `validate_project`: validate entry file, safe paths, file sizes, basic HTML structure, and public URL readiness.
- `publish_project`: publish the project entry file. MCP tool calls default to public `anyone_with_link` access for final handoff; pass `shareAccess: "private"` for internal previews.
- `publish_and_report`: validate, publish, and return a stable delivery report with `publishedUrl` and `shareAccess`.
- `delete_project`: soft-delete a project with `confirm=true`; disabled by default in Admin tool access.
- `create_app_project`: create a Vite app source workspace for React, Vue, or vanilla demos.
- `write_app_project_file` / `read_app_project_file`: edit and inspect source files under the project `workspace/`.
- `install_project_dependencies`: run controlled `npm install` in the app workspace.
- `run_project_dev` / `stop_project_dev`: start or stop a local Vite dev preview.
- `run_project_build`: run controlled `npm run build`.
- `publish_project_dist`: publish built `dist/` output to the stable `/share/:projectId/index.html` URL. MCP delivery tools publish final handoff links as `anyone_with_link` so referenced assets are anonymously loadable.
- `get_app_project_report`: return manifest plus app dev server state.
- `bind_project_workspace`: bind an existing `projectId` to a real local Git repository under `WORKSPACE_ROOT`.
- `list_project_files`: list files in the bound workspace, excluding heavy generated folders by default.
- `search_in_project`: search the bound workspace with ripgrep.
- `apply_patch`: apply a unified diff to the bound workspace after `git apply --check`.
- `write_project_workspace_asset`: write binary assets such as images, textures, GLB/GLTF models, HDR files, audio, or video into the bound workspace from raw base64.
- `import_project_workspace_asset_from_local_file`: copy a local generated/uploaded binary asset into the bound workspace.
- `run_project_npm_command`: run `npm install`, `npm run build`, `npm test`, `npm run lint`, or `npm run typecheck` in the bound workspace.
- `run_shell_command`: run a bounded shell command in the bound workspace with a scrubbed environment; disabled by default.
- `inspect_project_workspace`: start the bound workspace dev server and inspect desktop/tablet/mobile screenshots, layout, console errors, and optional accessibility.
- `record_project_workspace_video`: start the bound workspace dev server and record real browser output to WebM, or MP4 when `ffmpeg` is installed; failed MP4 conversion still returns the WebM artifact.
- `publish_project_workspace`: copy a built output directory such as `dist/` into the project files and publish it to `/share/:projectId/index.html` with `anyone_with_link` access for user handoff.
- `record_project_task`: append queued/in-progress/completed/blocked task state to project history.

Recommended ChatGPT workflow:

1. Call `deliver_static_project` with `title`, `summary`, `entryFile`, and all text files.
2. If it returns `ok:true`, return the `publishedUrl`, for example `https://gmb01.xyz/share/project_xxx/index.html`. By default the link is public `anyone_with_link`; pass `shareAccess: "private"` only when the user or agent needs an owner/admin-only preview.
3. If it returns `ok:false`, use `get_project_activity` and the inspection report to explain what must be fixed.
4. Use the lower-level `create_project` / `write_project_file` / `validate_project` / `publish_and_report` workflow only for incremental repairs.

## Admin pages

- `/admin`: React operations console with project, connector, tool, skill, special-tool, activity, and settings views.
- `/admin/projects/:projectId`: React project detail route for status, files, validation, and task history.
- `/admin/api/projects/:projectId`: authenticated JSON project detail.
- `/admin/api/projects/:projectId/download.zip`: authenticated dynamic ZIP download of project files.
- `/share/:projectId/:filename`: published project file. Default project access is public `anyone_with_link`; set `shareAccess: "private"` for signed-in project users and admins only.

## Safety boundaries

- Project files must stay inside `.projects/{projectId}/files/`.
- Absolute paths are rejected.
- `..` path traversal is rejected.
- Hidden path segments such as `.env` are rejected.
- Single file content is limited to 1 MiB.
- Only text-first static files are enabled in this version: `.html`, `.css`, `.js`, `.json`, `.txt`, `.md`, `.svg`.
- ZIP download includes `published/` and app source `workspace/`, excluding `node_modules` and built `dist`.
- Revoking a connector does not delete its projects.

## Current limitation

The Admin UI exposes project files and task history for inspection, but it does not provide an in-browser code editor. Monaco Editor or a stronger online editor can be added later, but full VS Code/code-server is intentionally not exposed to the public internet in this MVP.

## Tool module location

Project tools live in `src/mcp/tools/project.ts`. Their definitions, zod schemas, handlers, and default access are colocated there. `delete_project` is intentionally `enabledByDefault: false`; enable it from Admin only when needed.

The project detail page shows the agent-readable manifest, last validation result, browser inspection report link when present, task history, file tree, and read-only code viewer.

## Required ChatGPT delivery workflow

For project deliverables, ChatGPT must use the persistent Project workflow:

1. `create_project`
2. `write_project_file`
3. `get_project_manifest`
4. `validate_project`
5. `publish_and_report`
6. Return the `publishedUrl`

For normal new static deliverables, prefer `deliver_static_project` over the manual sequence above. Do not use `create_share` for project deliverables. It is a legacy standalone HTML tool, disabled by default, and should only be enabled temporarily from Admin for compatibility testing.

For idea-to-demo Vite apps, use the app project workflow:

1. `create_app_project`
2. `write_app_project_file`
3. `install_project_dependencies`
4. `run_project_dev` when a local preview is useful
5. `run_project_build`
6. `publish_project_dist`
7. Return the `shareUrl` and Admin ZIP download link

For existing repositories on disk, use the real workspace workflow:

1. `create_project` or `get_project`
2. `bind_project_workspace` with `projectId` and the repository path under `WORKSPACE_ROOT`
3. `git_status` with `projectId`
4. `list_project_files` and `search_in_project`
5. `apply_patch`
6. `write_project_workspace_asset` or `import_project_workspace_asset_from_local_file` when the project needs textures, models, HDR, audio, or video assets
7. `run_project_npm_command` for install/build/test/lint/typecheck
8. `inspect_project_workspace`
9. `record_project_workspace_video` when the deliverable needs a browser-rendered demo video
10. `publish_project_workspace`
11. Return changed files, validation result, screenshot/inspection report URLs, video artifact URL when present, public URL, and remaining issues.

`git_status`, `git_diff`, `git_commit`, and `git_push` accept an optional `projectId`. When present, they run inside the bound Git repository instead of the MCP server's default workspace. Bound repositories must be under `WORKSPACE_ROOT` such as `/data/workspace` in Docker.
