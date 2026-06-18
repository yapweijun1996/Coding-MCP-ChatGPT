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
- `publish_project`: publish the project entry file.
- `publish_and_report`: validate, publish, and return a stable delivery report with `publishedUrl`.
- `delete_project`: soft-delete a project with `confirm=true`; disabled by default in Admin tool access.
- `create_app_project`: create a Vite app source workspace for React, Vue, or vanilla demos.
- `write_app_project_file` / `read_app_project_file`: edit and inspect source files under the project `workspace/`.
- `install_project_dependencies`: run controlled `npm install` in the app workspace.
- `run_project_dev` / `stop_project_dev`: start or stop a local Vite dev preview.
- `run_project_build`: run controlled `npm run build`.
- `publish_project_dist`: publish built `dist/` output to the stable `/share/:projectId/index.html` URL.
- `get_app_project_report`: return manifest plus app dev server state.

Recommended ChatGPT workflow:

1. Call `deliver_static_project` with `title`, `summary`, `entryFile`, and all text files.
2. If it returns `ok:true`, return the `publishedUrl`, for example `https://gmb01.xyz/share/project_xxx/index.html`.
3. If it returns `ok:false`, use `get_project_activity` and the inspection report to explain what must be fixed.
4. Use the lower-level `create_project` / `write_project_file` / `validate_project` / `publish_and_report` workflow only for incremental repairs.

## Admin pages

- `/admin`: project list, connector status, tool toggles, activity log.
- `/admin/projects/:projectId`: project detail and read-only code viewer.
- `/admin/projects/:projectId/files?path=...`: JSON file content.
- `/admin/projects/:projectId/download.zip`: dynamic ZIP download of project files.
- `/share/:projectId/:filename`: public published project file.

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

The first version provides code viewing with a read-only textarea. Monaco Editor or a stronger online editor can be added later, but full VS Code/code-server is intentionally not exposed to the public internet in this MVP.

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
