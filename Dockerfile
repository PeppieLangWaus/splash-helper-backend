# syntax=docker/dockerfile:1
# ── Stage 1: build ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# Renders OSRS item icons into data/item-icons/ at build time (scripts/render-item-icons.ts —
# see scripts/item-icons/README.md) rather than committing ~4000 generated PNGs to the repo.
# Needs a JDK for the Gradle-based renderer, and downloads a live cache (~180MB) from OpenRS2
# plus the Gradle distribution and net.runelite:cache's own dependencies on top of that — this
# stage needs network access and adds a few minutes to every image build.
#
# --build-cache points render-item-icons.ts at a BuildKit cache mount: OpenRS2's cache only
# actually changes when the game itself updates, so most builds/redeploys can skip the download +
# render and reuse whatever was saved there last time. The mount persists in BuildKit's cache
# store on the build host across separate `docker build` runs (i.e. across Coolify redeploys on
# the same server) — Coolify itself isn't involved in keeping it around, so if the cache is ever
# pruned or a build lands on a different host, that build just renders from scratch and
# repopulates it. Requires a BuildKit-enabled builder, which is Docker's default since Engine 23.
RUN apk add --no-cache openjdk17
COPY scripts ./scripts
RUN --mount=type=cache,target=/build-cache,id=item-icons-build-cache \
    npm run render-item-icons -- --build-cache /build-cache

# ── Stage 2: runtime ───────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/data ./data

EXPOSE 3000

CMD ["node", "dist/app.js"]
