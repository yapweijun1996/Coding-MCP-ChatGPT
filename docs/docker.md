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

The Docker image installs `fluidsynth` and `ffmpeg` automatically in both the build and runtime stages. It also downloads and validates the free commercial-friendly GeneralUser GS SoundFont during image build, storing it under `/app/soundfonts/generaluser-gs/` with `GeneralUser-GS.sf2`, `LICENSE.txt`, and `README.md`.

GeneralUser GS is fetched from upstream commit `684543d5e5efaef08d02be50dcda8d552478fa60`, not a moving branch. The Docker build verifies SHA-256 before writing each bundled file:

- `GeneralUser-GS.sf2`: `9575028c7a1f589f5770fccc8cff2734566af40cd26ed836944e9a5152688cfe`
- `LICENSE.txt`: `7b32efefdf95ce38a043799f0659853ddc00fbaa14d8c50f0aca16b9b8b405be`
- `README.md`: `f1a5d1ef99591763617689d064e57113b1db900a920e145233aa2789331e085a`

If upstream content changes or a download is tampered with, the image build fails instead of silently bundling different audio assets or license text.

At runtime, `install_free_soundfont_pack` first copies this bundled SoundFont into the target project assets and records SHA-256, source URL, license path, README path, `productionUseApproved`, and `qualityTier=production_candidate`. It only downloads from upstream if the bundled cache is missing. This keeps normal ChatGPT tool usage offline from the SoundFont source after the Docker image is built.

GeneralUser GS is not MIT. Treat it as the built-in free/commercial-friendly production-candidate SoundFont after the license/hash/QA gates pass.

After rebuilding the image, registered `.sf2` and `.sf3` SoundFont piano packs can render through `render_midi_with_soundfont` without manual host setup.

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
