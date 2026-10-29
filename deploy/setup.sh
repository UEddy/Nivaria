#!/usr/bin/env bash
# One-time setup for a fresh Ubuntu droplet. Run once, as root:
#
#   curl -fsSL https://raw.githubusercontent.com/UEddy/Nivaria/main/deploy/setup.sh -o setup.sh
#   bash setup.sh
#
# It adds 1 GB of swap, installs Node 20 and Caddy, turns on the ufw firewall
# (SSH, 80 and 443 only), creates the nivaria user, clones the repo to
# /opt/nivaria, installs production dependencies, and installs the systemd
# service and the Caddyfile from the clone. It holds no secrets: those go in
# /opt/nivaria/.env by hand (deploy/CHECKLIST.md). Safe to run again.

set -euo pipefail

REPO_URL=https://github.com/UEddy/Nivaria.git
APP_DIR=/opt/nivaria
APP_USER=nivaria

log() { printf '\n==> %s\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "Run this as root." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

log "Swap (1 GB)"
if swapon --show=NAME --noheadings | grep -qx /swapfile; then
  echo "/swapfile already active"
else
  if [[ ! -f /swapfile ]]; then
    fallocate -l 1G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=1024
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab

log "Base packages"
apt-get update
apt-get install -y ca-certificates curl gnupg git ufw debian-keyring debian-archive-keyring apt-transport-https

log "Node 20"
if node --version 2>/dev/null | grep -q '^v20\.'; then
  echo "Node $(node --version) already installed"
else
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

log "Caddy"
if command -v caddy >/dev/null 2>&1; then
  echo "Caddy already installed"
else
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    -o /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

log "Firewall (SSH, 80, 443)"
# Allow the port sshd actually listens on, so a custom SSH port does not lock
# you out when the firewall comes on.
SSH_PORT=$(sshd -T 2>/dev/null | awk '$1 == "port" { print $2; exit }')
SSH_PORT=${SSH_PORT:-22}
ufw default deny incoming
ufw default allow outgoing
ufw allow "${SSH_PORT}/tcp"
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status verbose

log "App user and code"
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/home/$APP_USER" --shell /usr/sbin/nologin "$APP_USER"
fi
mkdir -p "$APP_DIR"
chown "$APP_USER:$APP_USER" "$APP_DIR"
if [[ -d "$APP_DIR/.git" ]]; then
  echo "$APP_DIR already cloned; use deploy/update.sh to update it"
else
  sudo -u "$APP_USER" -H git clone "$REPO_URL" "$APP_DIR"
fi
sudo -u "$APP_USER" -H mkdir -p "$APP_DIR/data"

log "Dependencies (npm ci --omit=dev)"
# ENABLE_SCRAPER is unset here, so the postinstall skips the browser download.
sudo -u "$APP_USER" -H bash -c "cd '$APP_DIR' && npm ci --omit=dev"

log "systemd service"
install -m 644 "$APP_DIR/deploy/nivaria.service" /etc/systemd/system/nivaria.service
systemctl daemon-reload
systemctl enable nivaria

log "Caddy config"
if [[ -f /etc/caddy/Caddyfile && ! -f /etc/caddy/Caddyfile.orig ]]; then
  cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.orig
fi
caddy validate --config "$APP_DIR/deploy/Caddyfile" --adapter caddyfile
install -m 644 "$APP_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile
systemctl enable caddy
systemctl reload caddy || systemctl restart caddy

log "Start"
if [[ -f "$APP_DIR/.env" ]]; then
  systemctl restart nivaria
  sleep 5
  systemctl --no-pager status nivaria | head -n 12
else
  cat <<MSG
$APP_DIR/.env does not exist yet, so the service is enabled but not started.
Create it as described in deploy/CHECKLIST.md, then run:
  systemctl start nivaria
MSG
fi

log "Done"
