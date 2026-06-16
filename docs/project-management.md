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

## MCP tools

- `create_project`: create a persistent project and return `projectId`.
- `list_projects`: list projects.
- `get_project`: get metadata and file list.
- `write_project_file`: write a text file inside the project.
- `read_project_file`: read a text file inside the project.
- `delete_project_file`: delete a project file with `confirm=true`.
- `publish_project`: publish the project entry file.
- `delete_project`: soft-delete a project with `confirm=true`; disabled by default in Admin tool access.

Recommended ChatGPT workflow:

1. Call `create_project`.
2. Call `write_project_file` for `index.html`, CSS, JS, and docs.
3. Call `read_project_file` or `get_project` if verification context is needed.
4. Call `publish_project`.
5. Return the `publishedUrl`, for example `https://gmb01.xyz/share/project_xxx/index.html`.

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
- ZIP download only includes the project `files/` directory.
- Revoking a connector does not delete its projects.

## Current limitation

The first version provides code viewing with a read-only textarea. Monaco Editor or a stronger online editor can be added later, but full VS Code/code-server is intentionally not exposed to the public internet in this MVP.

## Tool module location

Project tools live in `src/mcp/tools/project.ts`. Their definitions, zod schemas, handlers, and default access are colocated there. `delete_project` is intentionally `enabledByDefault: false`; enable it from Admin only when needed.

## Required ChatGPT delivery workflow

For project deliverables, ChatGPT must use the persistent Project workflow:

1. `create_project`
2. `write_project_file`
3. `read_project_file` or `get_project` when needed
4. `publish_project`
5. Return the `publishedUrl`

Do not use `create_share` for project deliverables. It is a legacy standalone HTML tool, disabled by default, and should only be enabled temporarily from Admin for compatibility testing.
