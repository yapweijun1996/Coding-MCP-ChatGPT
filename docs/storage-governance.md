# Storage governance

Project storage is now measured and cleaned as a first-class lifecycle concern. A project's footprint can exist in more than one location:

- managed project files and the internal workspace under the project root;
- a project-bound external workspace under the user's workspace root;
- project backups and export-package artifacts;
- shared HTML artifacts and append-only telemetry.

## Inspecting usage

The enabled `get_my_storage_usage` MCP tool reports the current user's project/workspace usage, per-project sizes, quota state, and warnings. It never returns absolute filesystem paths.

Administrators can request the full report with:

```text
GET /admin/api/storage
```

The administrator report also includes artifact, share, and telemetry roots. Non-admin users receive only their own project and workspace scope.

## Quotas and maintenance

The server reads these environment variables at startup:

| Variable | Default | Meaning |
| --- | ---: | --- |
| `PROJECT_STORAGE_QUOTA` | `5GiB` | Hard limit for one project and its bound workspace |
| `USER_STORAGE_QUOTA` | `25GiB` | Hard limit for one user's project and workspace roots |
| `GLOBAL_STORAGE_QUOTA` | `100GiB` | Hard limit across all configured project, workspace, artifact, share, and telemetry roots |
| `STORAGE_WARN_AT_PERCENT` | `80` | Warning threshold for project, user, and global usage |
| `DELETED_PROJECT_RETENTION_DAYS` | `7` | How long soft-deleted projects remain before maintenance purges them |
| `STORAGE_MONITOR_INTERVAL_MS` | `15m` | Maintenance/report interval; accepts `ms`, `s`, `m`, or `h` suffixes |

Quota values accept `B`, `KiB`, `MiB`, `GiB`, and `TiB` (the short `K`, `M`, `G`, and `T` forms are also accepted). Set a project, user, or global quota to `0` to disable that hard limit. The global check is serialized and runs before managed project/workspace, artifact, share, and telemetry writes; a rejected write leaves its action unexecuted.

Managed project-file writes and workspace asset writes perform a pre-write quota check. Artifact and share records persist project ownership in `artifact.json`/`share.json`, allowing purge to remove only matching project-owned outputs while retaining unrelated generic outputs. The maintenance monitor periodically measures all configured roots, logs warnings, and purges expired soft-deleted projects. Export ZIP temporary files are removed in a `finally` block so failed or completed exports do not leave duplicate archives behind.

Native conversation-file promotion also performs quota preflight before staging when the connector supplies a byte length. When the length is unknown, the same-directory temporary file is excluded from the second quota measurement before the final atomic rename, so the source is not rejected merely because the staged copy is counted twice. `CONVERSATION_FILE_MAX_BYTES` defaults to `100MiB` and is independent from the legacy 40 MiB JSON body ceiling.

## Deletion semantics

The existing delete APIs remain soft-delete operations for compatibility. Permanent deletion requires explicit confirmation:

```text
POST /admin/api/projects/:projectId/purge
{ "confirm": true }
```

Only administrators can use the HTTP purge endpoint. The `purge_project` MCP tool is disabled by default and also requires `confirm: true`. A purge removes managed project data, matching project backups/export artifacts and project-owned artifact/share records, and a bound workspace only when it is safely inside the configured workspace root. A workspace shared by another project is preserved.

The Admin console exposes the report at `/admin/storage`, with global and per-scope quota bars, storage-category totals, warnings, and largest project usage. It never displays filesystem paths.

## Verification

The storage behavior is covered by `tests/storage-governance.test.ts`, including quota rejection, multi-root reporting, backup cleanup, and shared-workspace protection.
