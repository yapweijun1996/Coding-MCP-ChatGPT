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
  && apt-get install -y --no-install-recommends fluidsynth ffmpeg bzip2 xz-utils xvfb \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /app/soundfonts/generaluser-gs \
  && node <<'NODE'
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const path = require("node:path");

const targetDir = "/app/soundfonts/generaluser-gs";
const upstreamCommit = "684543d5e5efaef08d02be50dcda8d552478fa60";
const baseUrl = `https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS/${upstreamCommit}`;
const files = [
  ["GeneralUser-GS.sf2", "GeneralUser-GS.sf2", "9575028c7a1f589f5770fccc8cff2734566af40cd26ed836944e9a5152688cfe"],
  ["documentation/LICENSE.txt", "LICENSE.txt", "7b32efefdf95ce38a043799f0659853ddc00fbaa14d8c50f0aca16b9b8b405be"],
  ["README.md", "README.md", "f1a5d1ef99591763617689d064e57113b1db900a920e145233aa2789331e085a"]
];

async function download(sourcePath, targetName, expectedSha256) {
  const url = `${baseUrl}/${sourcePath}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download ${url}: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const actualSha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error(`SHA-256 mismatch for ${targetName}: expected ${expectedSha256}, got ${actualSha256}`);
  }
  await fs.writeFile(path.join(targetDir, targetName), buffer);
  return buffer;
}

(async () => {
  const soundfont = await download(files[0][0], files[0][1], files[0][2]);
  await download(files[1][0], files[1][1], files[1][2]);
  await download(files[2][0], files[2][1], files[2][2]);
  if (soundfont.length < 12 || soundfont.subarray(0, 4).toString("ascii") !== "RIFF" || soundfont.subarray(8, 12).toString("ascii") !== "sfbk") {
    throw new Error("Downloaded GeneralUser-GS.sf2 is not a valid RIFF/sfbk SoundFont.");
  }
})();
NODE

# Bundle the YDP Grand Piano (sampled Yamaha grand, CC-BY 3.0) so install_free_soundfont_pack
# packId=ydp_grand resolves from MUSIC_SOUNDFONT_DIR with no per-run download (~118 MB sampled .sf2
# ships as a bz2 archive Node cannot extract, so it is fetched + extracted here at build time).
# Salamander (296 MiB compressed / 1.27 GB uncompressed) is bundled at build time — see the RUN block below.
RUN mkdir -p /app/soundfonts/ydp-grand \
  && node -e "const fs=require('node:fs');fetch('https://freepats.zenvoid.org/Piano/YDP-GrandPiano/YDP-GrandPiano-SF2-20160804.tar.bz2').then(r=>{if(!r.ok)throw new Error('download '+r.status);return r.arrayBuffer()}).then(b=>fs.writeFileSync('/tmp/ydp.tar.bz2',Buffer.from(b)))" \
  && tar -xjf /tmp/ydp.tar.bz2 -C /tmp \
  && SRC=/tmp/YDP-GrandPiano-SF2-20160804 \
  && echo "8757076aecf80abdad1e8f8f6168370399b06f94481796986e6e75ceca09ad21  $SRC/YDP-GrandPiano-20160804.sf2" | sha256sum -c - \
  && cp "$SRC/YDP-GrandPiano-20160804.sf2" /app/soundfonts/ydp-grand/YDP-GrandPiano.sf2 \
  && cp "$SRC/YDP-GrandPiano-20160804.txt" /app/soundfonts/ydp-grand/LICENSE.txt \
  && cp "$SRC/YDP-GrandPiano-20160804.txt" /app/soundfonts/ydp-grand/README.md \
  && rm -rf /tmp/ydp.tar.bz2 "$SRC"

# Bundle Salamander Grand Piano V3 (CC-BY 3.0, Yamaha C5 samples) so install_free_soundfont_pack
# packId=salamander_grand resolves from MUSIC_SOUNDFONT_DIR with no per-run download.
# 296 MiB compressed / 1.27 GB uncompressed; tradeoff explicitly accepted.
RUN mkdir -p /app/soundfonts/salamander \
  && node -e "const fs=require('node:fs');const crypto=require('node:crypto');(async()=>{const r=await fetch('https://freepats.zenvoid.org/Piano/SalamanderGrandPiano/SalamanderGrandPiano-SF2-V3+20200602.tar.xz');if(!r.ok)throw new Error('download '+r.status);const hash=crypto.createHash('sha256');const out=fs.createWriteStream('/tmp/salamander.tar.xz');for await(const chunk of r.body){hash.update(chunk);out.write(chunk);}await new Promise((res,rej)=>out.end(e=>e?rej(e):res()));const h=hash.digest('hex');if(h!=='15edb061d7ba60d58332f72dba8f8ce40988048cc703f935e6320f37d650e213')throw new Error('SHA256 mismatch: '+h);})()" \
  && tar -xJf /tmp/salamander.tar.xz -C /tmp \
  && SRC="/tmp/SalamanderGrandPiano-SF2-V3+20200602" \
  && cp "$SRC/SalamanderGrandPiano-V3+20200602.sf2" /app/soundfonts/salamander/Salamander.sf2 \
  && cp "$SRC/readme.txt" /app/soundfonts/salamander/LICENSE.txt \
  && node -e "const fs=require('node:fs');const h=Buffer.alloc(12);const fd=fs.openSync('/app/soundfonts/salamander/Salamander.sf2','r');fs.readSync(fd,h,0,12,0);fs.closeSync(fd);if(h.toString('ascii',0,4)!=='RIFF'||h.toString('ascii',8,12)!=='sfbk')throw new Error('magic check failed: '+h.toString('hex'))" \
  && rm -rf /tmp/salamander.tar.xz "$SRC"

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

# xvfb-run gives every process a real DISPLAY. Only agoda_search_hotels launches Chromium
# non-headless (Agoda's bot mitigation blocks headless Chromium there); every other browser
# tool in this image still launches headless and is unaffected by the wrapper being present.
CMD ["xvfb-run", "--auto-servernum", "--server-args=-screen 0 1280x1024x24", "node", "dist/server.js"]
