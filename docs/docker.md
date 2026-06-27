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

## Music Renderers

The Docker image installs `fluidsynth` and `ffmpeg` automatically in both the build and runtime stages. After rebuilding the image, registered `.sf2` and `.sf3` SoundFont piano packs can render through `render_midi_with_soundfont` without manual host setup.

SFZ packs require the `sfizz_render` executable. The current Playwright Ubuntu Noble base image does not expose an installable `sfizz`/`sfizz-tools` package through its default apt sources, so the stock Docker image does not claim automatic SFZ rendering. If a custom image adds `sfizz_render` to `PATH`, `.sfz` packs are eligible for the same production render path; otherwise the tool returns a preview-only renderer-missing report instead of silently falling back to procedural audio.

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
CONTENT_BASE_URL=https://content.gmb01.xyz
KB_MCP_OAUTH_ISSUER=https://gmb01.xyz
```
