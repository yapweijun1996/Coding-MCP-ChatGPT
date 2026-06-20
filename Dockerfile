# syntax=docker/dockerfile:1

FROM mcr.microsoft.com/playwright:v1.61.0-noble AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY admin-ui ./admin-ui
RUN npm run build

FROM mcr.microsoft.com/playwright:v1.61.0-noble AS runtime

ENV NODE_ENV=production \
    PORT=6859 \
    HOST=0.0.0.0 \
    PUBLIC_BASE_URL=http://localhost:6859 \
    WORKSPACE_ROOT=/data/workspace \
    SHARE_ROOT=/data/shares \
    ARTIFACT_ROOT=/data/artifacts \
    PROJECT_ROOT=/data/projects \
    JOBS_ROOT=/data/jobs \
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
