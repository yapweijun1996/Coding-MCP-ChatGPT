# Task tracking (task.jsonl + archive.jsonl)

Lightweight, machine-readable backlog for production-hardening and ongoing dev work.
One JSON object per line (JSONL). No comments — keep it parseable.

- `task.jsonl` — active backlog (status: `todo`, `in_progress`, `blocked`).
- `archive.jsonl` — finished work (status: `done`, `cancelled`). Move a line here when it leaves the active set; never delete history.

## Lifecycle

1. Add a task to `task.jsonl` (status `todo`).
2. When starting, set `status` to `in_progress`.
3. When finished, add `completed` (date), `commit` (sha), and `resolution`, then **cut the line from `task.jsonl` and append it to `archive.jsonl`**.
4. `blocked` tasks stay in `task.jsonl` with a `blocked_by` note.

## Schema

| field | required | values / notes |
|---|---|---|
| `id` | yes | stable id, e.g. `T001` (never reused) |
| `title` | yes | short imperative |
| `status` | yes | `todo` / `in_progress` / `blocked` / `done` / `cancelled` |
| `priority` | yes | `P0` (blocker) / `P1` / `P2` |
| `area` | yes | `security` / `seo` / `ops` / `reliability` / `feature` |
| `files` | no | `path:line` refs |
| `acceptance` | yes | concrete done-criteria (how to verify) |
| `deps` | no | array of task ids that must finish first |
| `created` | yes | `YYYY-MM-DD` |
| `notes` | no | context / verification evidence |
| `completed` | on done | `YYYY-MM-DD` |
| `commit` | on done | git sha |
| `resolution` | on done | what was actually changed |

## Quick queries

```sh
# active P0s
grep '"priority":"P0"' task.jsonl
# count by status
grep -o '"status":"[a-z_]*"' task.jsonl | sort | uniq -c
# pretty-print one task
grep '"id":"T001"' task.jsonl | python3 -m json.tool
```
