# Docker Deployment

This project can run as a Docker container for easier process management and persistent data handling.

## Files

- `Dockerfile`: builds a production Node image on top of the Playwright runtime image so browser inspection tools have Chromium dependencies available.
- `docker-compose.yml`: runs the service with persistent bind mounts.
- `.env.docker.example`: safe template for container environment variables.

## First Run

```bash
cp .env.docker.example .env.docker
```

Edit `.env.docker` and set strong values for:

- `MCP_DEV_TOKEN`
- `KB_MCP_OAUTH_PASSCODE`
- `ADMIN_PASSCODE`
- `PUBLIC_BASE_URL`
- `KB_MCP_OAUTH_ISSUER`

Then start the service:

```bash
docker compose up -d --build
```

Verify:

```bash
curl -sS http://127.0.0.1:6859/health
docker compose ps
docker compose logs -f coding-mcp-chatgpt
```

## Persistent Data

Compose stores runtime data under `.docker-data/`:

- `.docker-data/projects` -> `/data/projects`
- `.docker-data/shares` -> `/data/shares`
- `.docker-data/artifacts` -> `/data/artifacts`
- `.docker-data/state` -> `/data/state`
- repository root -> `/data/workspace`

Back up `.docker-data/` if you need to preserve projects, shared pages, artifacts, OAuth state, and tool state.

## Common Commands

```bash
docker compose up -d
docker compose down
docker compose logs -f coding-mcp-chatgpt
docker compose restart coding-mcp-chatgpt
docker compose pull
docker compose build --no-cache
```

## Cloudflare Tunnel

If Cloudflare Tunnel runs outside Docker, point it to:

```text
http://127.0.0.1:6859
```

Set these in `.env.docker` for the public domain:

```bash
PUBLIC_BASE_URL=https://gmb01.xyz
KB_MCP_OAUTH_ISSUER=https://gmb01.xyz
```
