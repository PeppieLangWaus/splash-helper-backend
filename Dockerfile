# syntax=docker/dockerfile:1
# ── Stage 1: build ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ── Stage 2: runtime ───────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist ./dist

# Item icon PNGs (data/item-icons/, served by src/routes/items.ts's GET /items/:id/icon) used to
# be rendered here at build time — a JDK + Gradle stage that downloaded a live ~180MB OSRS cache
# from OpenRS2 on every image build. That was unreliable in practice: it added minutes to every
# deploy, a single flaky download hard-failed the whole build, and the BuildKit cache mount meant
# to skip re-rendering on unchanged builds didn't reliably survive between Coolify redeploys on
# the same host (observed emptied out in well under a day). See scripts/item-icons/README.md.
#
# The render now runs on its own schedule via .github/workflows/render-item-icons.yml, which
# publishes the result as this repo's "item-icons-latest" GitHub Release asset. This just fetches
# that pre-rendered tarball instead — no JDK, no live game-cache download, no build-time renderer.
# `ADD` from a remote URL is layer-cached by BuildKit on the target's ETag/Last-Modified (syntax
# 1.4+, declared above), so a build only re-downloads when the workflow has actually published a
# new render, not on every deploy. Trigger the workflow manually (Actions tab, "Run workflow")
# after an OSRS update if you don't want to wait for its weekly schedule.
ADD https://github.com/PeppieLangWaus/splash-helper-backend/releases/download/item-icons-latest/item-icons.tar.gz /tmp/item-icons.tar.gz
RUN mkdir -p data/item-icons && \
    tar -xzf /tmp/item-icons.tar.gz -C data/item-icons && \
    rm /tmp/item-icons.tar.gz

EXPOSE 3000

CMD ["node", "dist/app.js"]
