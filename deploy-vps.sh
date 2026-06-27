#!/bin/bash
# Deploy SubBot to VPS (run this ON the VPS)
# Usage: bash deploy-vps.sh

set -e

APP_DIR="$HOME/subbot"
REPO_URL="https://github.com/$(git remote get-url origin 2>/dev/null | sed 's|.*github.com[:/]||;s|\.git$||')" 2>/dev/null || true

echo "=== SubBot VPS Deploy ==="

# 1. Clone or pull
if [ -d "$APP_DIR" ]; then
  echo "[1/4] Pulling latest code..."
  cd "$APP_DIR"
  git pull
else
  echo "[1/4] Cloning repo..."
  if [ -n "$REPO_URL" ] && [ "$REPO_URL" != "https://github.com/" ]; then
    git clone "$REPO_URL" "$APP_DIR"
  else
    echo "No git remote found. Copy the project to $APP_DIR manually, then re-run."
    exit 1
  fi
  cd "$APP_DIR"
fi

# 2. Install Node deps
echo "[2/4] Installing dependencies..."
npm install --production

# 3. Create .env if missing
if [ ! -f "$APP_DIR/.env" ]; then
  echo "[3/4] Creating .env template..."
  cat > "$APP_DIR/.env" <<'EOF'
# SubBot environment — fill in your values
PORT=3747
DATA_DIR=/root/.hermes

# LLM (Nous Research / OpenAI-compatible)
OPENAI_API_KEY=
OPENAI_BASE_URL=https://inference-api.nousresearch.com/v1

# Celo contracts
AGENT_PRIVATE_KEY=
LOG_CONTRACT_ADDRESS=0x5bc06976e5b46fd624195EFdD0bFC45a73569003
VAULT_CONTRACT_ADDRESS=0x48720eeDdCc1Cf3B2C613Dc093869a2332841e62
GD_ADAPTER_ADDRESS=
EOF
  echo "   → Edit $APP_DIR/.env with your keys"
else
  echo "[3/4] .env already exists, skipping"
fi

# 4. Set up systemd service
echo "[4/4] Setting up systemd service..."
sudo tee /etc/systemd/system/subbot.service > /dev/null <<EOF
[Unit]
Description=SubBot API Bridge
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$APP_DIR
ExecStart=$(which node) api-bridge.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable subbot
sudo systemctl restart subbot

echo ""
echo "=== Done! ==="
echo "SubBot running at http://5.75.229.204:3747"
echo ""
echo "Commands:"
echo "  sudo systemctl status subbot    # check status"
echo "  sudo journalctl -u subbot -f    # view logs"
echo "  sudo systemctl restart subbot   # restart"
