# --- Build stage ---
# alpine = musl libc. better-sqlite3 has no reliable musl prebuild, so it
# compiles from source via node-gyp: build-base + python3 + make are required.
FROM node:22-alpine AS builder
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/
RUN npm run build:server

# Drop dev deps so only what the runtime needs is copied to the next stage.
# Native modules (.node) built above against musl carry through untouched.
RUN npm prune --omit=dev

# --- Client build stage ---
# Builds the Vue SPA into ../public/index.html (a single self-contained file,
# all JS+CSS inlined via vite-plugin-singlefile). Separate stage so the runtime
# image never carries the client toolchain (vite, vue, vue-tsc).
FROM node:22-alpine AS client-builder
WORKDIR /client
COPY client/package.json client/package-lock.json* ./
RUN npm ci
COPY client/ ./
RUN npm run build
# The build emits to ../public (relative to /client → /public).

# --- Runtime stage ---
# alpine: ~50MB base vs ~150MB for slim. git + ca-certificates + curl are the
# extras needed (clone/push + HTTPS + OpenCode binary install). node_modules is
# copied from the builder, so no toolchain is needed here.
FROM node:22-alpine
RUN apk add --no-cache git ca-certificates curl

# Install the OpenCode CLI binary. The SDK (@opencode-ai/sdk, already in
# node_modules) spawns `opencode serve` as a subprocess at runtime. This step
# is only needed for profiles that use the opencode runtime — pi-only
# deployments can comment out this block to save ~100MB.
# The install script puts the binary in ~/.opencode/bin/ — we symlink it to
# /usr/local/bin so it's on PATH without shell-profile gymnastics.
RUN curl -fsSL https://opencode.ai/install | sh && \
    ln -sf ~/.opencode/bin/opencode /usr/local/bin/opencode

# Default git identity for agent commits
RUN git config --global user.name "noodle-agent" && \
    git config --global user.email "noodle-agent@users.noreply.github.com"

WORKDIR /app

COPY package.json package-lock.json ./
COPY --from=builder /app/node_modules/ node_modules/
COPY --from=builder /app/dist/ dist/
COPY skills/ skills/
# The web UI is the client build output (single inlined index.html), not the
# source public/ dir.
COPY --from=client-builder /public/ public/

# Persistent volume mount for SQLite DB
RUN mkdir -p /data

ENV NODE_ENV=production
ENV NOODLE_CONFIG=/app/noodle.config.yaml

EXPOSE 3000

CMD ["node", "dist/cli.js", "serve"]
