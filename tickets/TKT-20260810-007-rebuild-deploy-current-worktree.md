---
id: TKT-20260810-007
title: "Rebuild and deploy the current Code-MCP worktree"
type: bugfix
priority: P1
status: DONE
owner: "Codex"
requestor: "Code-MCP user"
risk: HIGH
scope:
  in:
    - "Build the current verified worktree into the Docker production-like image"
    - "Recreate the coding-mcp-chatgpt container through Docker Compose while preserving named and bind-mounted data volumes"
    - "Verify local health, container health, MCP tool registration, and the public Cloudflare Tunnel endpoint"
  out:
    - "Changing application code, environment secrets, OAuth state, or database schema"
    - "Running docker compose down -v or deleting .docker-data"
    - "Changing Cloudflare Tunnel configuration or DNS"
    - "Deploying an unrelated branch or uncommitted state not present in this worktree"
constraints:
  - "localhost-first"
  - "preserve existing code and worktree changes"
  - "no secrets in logs or ticket evidence"
  - "preserve all Docker data volumes"
acceptance_criteria:
  - "The current worktree passes the release build and registry checks before deployment"
  - "The Docker image rebuild completes successfully with the repository Dockerfile"
  - "Both Postgres and coding-mcp-chatgpt are healthy after Compose recreation"
  - "The app logs show it listening on 0.0.0.0:6859 and local /health returns ok"
  - "The running container serves the current MCP registry without duplicate tools"
  - "The configured public Cloudflare Tunnel health endpoint remains reachable"
  - "No data volume is removed or recreated destructively"
test_plan:
  - "Capture the current image/container IDs and Compose health as a rollback point"
  - "Run npm run build, npm run lint, npm test, and npm run check:mcp"
  - "Run docker compose build and docker compose up -d without down -v"
  - "Check docker compose ps, health, logs, local health, MCP tool count, and public health"
  - "Run a post-deploy targeted smoke check for the deployed registry and core endpoint"
rollback_plan:
  - "If the image build fails, leave the currently healthy container serving and do not force recreation"
  - "If the new container is unhealthy, restore the captured pre-deploy image tag and recreate only coding-mcp-chatgpt with existing volumes"
  - "Never remove postgres-data or .docker-data/state; stop and report if rollback would require destructive data changes"
notes:
  - "Current deployment target is Docker Compose with an external Cloudflare Tunnel for gmb01.xyz."
  - "The worktree is intentionally dirty from the user's pending changes; deployment must preserve and build that state without resetting it."
  - "Reviewer note: HIGH-risk production-impacting operation; main agent will perform final release validation and record rollback evidence before completion."
---

## Context

The user selected the hard follow-up to rebuild and deploy the current Code-MCP worktree after the Playwright environment repair and full-suite verification. The repository documents Docker Compose as the production-like deployment path and Cloudflare Tunnel as the public edge.

## Requirements

- Rebuild the image from the current worktree.
- Recreate only the application service through the documented Compose path.
- Keep existing Postgres and bind-mounted state intact.
- Verify the actual running image and public route, not only the build exit code.

## Non-Goals

- No application feature edits or dependency upgrades.
- No Cloudflare configuration changes.
- No destructive volume cleanup or database migration.

## QA Checklist

- [x] Pre-deploy image/container rollback point recorded
- [x] Release build and registry checks pass
- [x] Docker image rebuilt
- [x] Postgres remains healthy
- [x] Application container is healthy and uses the new image
- [x] Local health and listening log verified
- [x] MCP registry/tool count verified
- [x] Public Cloudflare health verified
- [x] Rollback evidence and final status recorded

## Resolution Evidence

- Pre-deploy application container: `b5190c8546a4...`; pre-deploy image: `sha256:2bd22d3046ba...`; rollback tag saved as `coding-mcp-chatgpt:rollback-tkt-20260810-007`.
- Pre-deploy Postgres container: `d14b8794fef6...`, healthy; it remained running through the deployment.
- `npm run build` -> passed.
- `npm run lint` -> passed.
- `npm test` -> 513/513 passed.
- `npm run check:mcp` -> passed; 617 tools, 50 skills, 0 duplicates.
- `npm run docker:up` -> Docker image build completed successfully and produced `coding-mcp-chatgpt:local` image `sha256:c616c48a2d49...`.
- The first Compose up did not replace the old container, so the documented live-image check caught it. `docker compose up -d --no-build --force-recreate coding-mcp-chatgpt` then created application container `dd99209a4769...` from the new image while preserving volumes.
- Final `docker compose ps`: `coding-mcp-chatgpt` healthy and `coding-mcp-postgres` healthy.
- Final application log: `coding-mcp-chatgpt listening on http://0.0.0.0:6859`.
- Local `http://127.0.0.1:6859/health` -> `{\"ok\":true,\"version\":\"0.1.0\",\"service\":\"coding-mcp-chatgpt\"}`.
- Public `https://gmb01.xyz/health` -> the same healthy response.
- Public OAuth discovery endpoints returned the expected `https://gmb01.xyz` issuer and `/mcp` resource.
- Container-internal deployed registry inspection -> 617 tools, including `create_music_production` and `promote_sandbox_artifact_to_project`.
- Unauthenticated HTTP `tools/list` returned 401 locally and publicly, which is expected because production uses OAuth; the authenticated registry surface was verified inside the deployed image without exposing credentials.
- Xvfb emitted non-fatal `xkbcomp` keysym warnings; the server started, health checks passed, and the listening log was present.
- No source files, environment secrets, database data, OAuth state, or Docker volumes were deleted or modified by the deployment.

## Skill Reflection

The existing autonomous-delivery, agents-team, and quality-check skills covered this release workflow. The reusable production lesson is to verify the running container image ID after `docker compose up -d --build`; a successful build can leave the old container running, requiring an explicit `--force-recreate --no-build` cutover. No new skill was created or updated because this is already captured by the repository deployment runbook and existing quality guidance.
