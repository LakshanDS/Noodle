# --- Build stage ---
FROM node:22-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# --- Runtime stage ---
FROM node:22-bookworm-slim

# git needed for clone/push; ca-certificates for HTTPS
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*

# Default git identity for bot commits
RUN git config --global user.name "noodle-bot" && \
    git config --global user.email "noodle-bot@users.noreply.github.com"

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist/ dist/
COPY skills/ skills/

# Persistent volume mount for SQLite DB
RUN mkdir -p /data

ENV NODE_ENV=production
ENV NOODLE_CONFIG=/app/noodle.config.yaml

EXPOSE 3000

CMD ["node", "dist/cli.js", "serve"]
