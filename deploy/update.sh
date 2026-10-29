#!/usr/bin/env bash
# Update the droplet to the latest main and restart. Run as root:
#
#   bash /opt/nivaria/deploy/update.sh
#
# Pulls, reinstalls production dependencies, refreshes the systemd unit and
# the Caddyfile if the repo's copies changed, restarts the service and checks
# that it answers. The database in /opt/nivaria/data is git-ignored, so a pull
# never touches it.
#
# Everything runs inside main(): git pull rewrites this file, and bash reads a
# script as it goes, so the whole body has to be parsed before it starts.

set -euo pipefail

APP_DIR=/opt/nivaria
APP_USER=nivaria

main() {
  if [[ $EUID -ne 0 ]]; then
    echo "Run this as root." >&2
    exit 1
  fi

  echo "==> git pull"
  sudo -u "$APP_USER" -H git -C "$APP_DIR" pull --ff-only

  echo "==> npm ci --omit=dev"
  sudo -u "$APP_USER" -H bash -c "cd '$APP_DIR' && npm ci --omit=dev"

  if ! cmp -s "$APP_DIR/deploy/nivaria.service" /etc/systemd/system/nivaria.service; then
    echo "==> systemd unit changed, installing it"
    install -m 644 "$APP_DIR/deploy/nivaria.service" /etc/systemd/system/nivaria.service
    systemctl daemon-reload
  fi

  if ! cmp -s "$APP_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile; then
    echo "==> Caddyfile changed, validating and reloading Caddy"
    caddy validate --config "$APP_DIR/deploy/Caddyfile" --adapter caddyfile
    install -m 644 "$APP_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile
    systemctl reload caddy
  fi

  echo "==> restart"
  systemctl restart nivaria

  for _ in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:3000/health >/dev/null 2>&1; then
      echo "==> up: $(git -C "$APP_DIR" log --oneline -1)"
      return 0
    fi
    sleep 1
  done
  echo "The service did not answer on port 3000 within 30 seconds. Recent log:" >&2
  journalctl -u nivaria -n 40 --no-pager >&2
  exit 1
}

main "$@"
