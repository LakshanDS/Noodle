#!/usr/bin/env bash
# Run this ONCE on your VPS to set up the noodle-agent.
# Usage: bash setup-vps.sh

set -euo pipefail

INSTALL_DIR="/opt/noodle-agent"

echo "==> Creating install directory"
sudo mkdir -p "$INSTALL_DIR"
sudo chown "$USER:$USER" "$INSTALL_DIR"

echo "==> Copying docker-compose.yml"
cp "$(dirname "$0")/../docker-compose.yml" "$INSTALL_DIR/docker-compose.yml"

echo "==> Creating .env file (fill in your values)"
cat > "$INSTALL_DIR/.env" << 'EOF'
# GitHub App
GITHUB_APP_ID=
GITHUB_PRIVATE_KEY=
GITHUB_WEBHOOK_SECRET=
NOODLE_LOGIN=noodle-agent

# LLM
ANTHROPIC_API_KEY=

# Runtime
LOG_LEVEL=info
NODE_ENV=production
EOF

echo ""
echo "==> Edit the .env file:"
echo "    nano $INSTALL_DIR/.env"
echo ""
echo "==> Then log in to ghcr.io and start:"
echo "    echo YOUR_GITHUB_TOKEN | docker login ghcr.io -u YOUR_USERNAME --password-stdin"
echo "    cd $INSTALL_DIR && docker compose up -d"
echo ""
echo "==> Test:"
echo "    curl http://localhost:3000/health"
