# syntax=docker/dockerfile:1

FROM mcr.microsoft.com/playwright:v1.61.0-noble AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends fluidsynth ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY admin-ui ./admin-ui
RUN NODE_OPTIONS=--max-old-space-size=2048 npm run build

FROM mcr.microsoft.com/playwright:v1.61.0-noble AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends fluidsynth ffmpeg \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /app/soundfonts/generaluser-gs \
  && node <<'NODE'
const fs = require("node:fs/promises");
const path = require("node:path");

const targetDir = "/app/soundfonts/generaluser-gs";
const baseUrl = "https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS/master";
const files = [
  ["GeneralUser-GS.sf2", "GeneralUser-GS.sf2"],
  ["documentation/LICENSE.txt", "LICENSE.txt"],
  ["README.md", "README.md"]
];

async function download(sourcePath, targetName) {
  const url = `${baseUrl}/${sourcePath}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download ${url}: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(path.join(targetDir, targetName), buffer);
  return buffer;
}

(async () => {
  const soundfont = await download(files[0][0], files[0][1]);
  await download(files[1][0], files[1][1]);
  await download(files[2][0], files[2][1]);
  if (soundfont.length < 12 || soundfont.subarray(0, 4).toString("ascii") !== "RIFF" || soundfont.subarray(8, 12).toString("ascii") !== "sfbk") {
    throw new Error("Downloaded GeneralUser-GS.sf2 is not a valid RIFF/sfbk SoundFont.");
  }
})();
NODE

ENV NODE_ENV=production \
    PORT=6859 \
    HOST=0.0.0.0 \
    PUBLIC_BASE_URL=http://localhost:6859 \
    WORKSPACE_ROOT=/data/workspace \
    SHARE_ROOT=/data/shares \
    ARTIFACT_ROOT=/data/artifacts \
    PROJECT_ROOT=/data/projects \
    JOBS_ROOT=/data/jobs \
    MUSIC_SOUNDFONT_DIR=/app/soundfonts \
    SKILL_STATE_PATH=/data/state/skill-state.json \
    SITE_STATE_PATH=/data/state/site-state.json \
    BLOG_STATE_PATH=/data/state/blog-state.json \
    OAUTH_STATE_PATH=/data/state/oauth-state.json \
    COMMAND_TIMEOUT_MS=30000

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/admin-ui/dist ./admin-ui/dist

RUN mkdir -p /data/workspace /data/shares /data/artifacts /data/projects /data/state /data/jobs

EXPOSE 6859

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '6859') + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/server.js"]
