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
RUN npm run build

# Drop dev deps so only what the runtime needs is copied to the next stage.
# Native modules (.node) built above against musl carry through untouched.
RUN npm prune --omit=dev

# --- Runtime stage ---
# alpine: ~50MB base vs ~150MB for slim. git + ca-certificates are the only
# extras needed (clone/push + HTTPS). node_modules is copied from the builder,
# so no toolchain is needed here.
FROM node:22-alpine
RUN apk add --no-cache git ca-certificates

# Default git identity for agent commits
RUN git config --global user.name "noodle-agent" && \
    git config --global user.email "noodle-agent@users.noreply.github.com"

WORKDIR /app

COPY package.json package-lock.json ./
COPY --from=builder /app/node_modules/ node_modules/
COPY --from=builder /app/dist/ dist/
COPY skills/ skills/

# Persistent volume mount for SQLite DB
RUN mkdir -p /data

ENV NODE_ENV=production
ENV NOODLE_CONFIG=/app/noodle.config.yaml

EXPOSE 3000

CMD ["node", "dist/cli.js", "serve"]
