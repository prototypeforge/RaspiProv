#!/usr/bin/env bash
# Push the current repo to a Pi and reload the service.
#
# Usage:
#   scripts/deploy.sh                          # defaults: pi@raspberrypi.local
#   scripts/deploy.sh user@your-pi.local
#   scripts/deploy.sh user@<pi-ip-address>
#   PI_BLE_CONFIG_COMPILE=1 scripts/deploy.sh  # build cythonized wheel
#
# Excludes build artifacts (build/, *.egg-info/) so rsync's --delete
# doesn't trip on root-owned files left by `sudo pip install` on the Pi.
set -euo pipefail

TARGET="${1:-pi@raspberrypi.local}"
REMOTE_DIR="~/pi-ble-config"
COMPILE="${PI_BLE_CONFIG_COMPILE:-0}"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

echo "==> Syncing to ${TARGET}:${REMOTE_DIR}"
rsync -av --delete \
    --exclude '.git' \
    --exclude '.gitignore' \
    --exclude '__pycache__' \
    --exclude '*.pyc' \
    --exclude 'build/' \
    --exclude 'dist/' \
    --exclude '*.egg-info/' \
    --exclude '.claude' \
    --exclude 'web/dev-*.pem' \
    --exclude '.venv' \
    ./ "${TARGET}:${REMOTE_DIR}/"

echo "==> Reinstalling and restarting service on ${TARGET}"
# shellcheck disable=SC2087
ssh "${TARGET}" bash -lc "'
    set -e
    cd ${REMOTE_DIR}
    sudo PI_BLE_CONFIG_COMPILE=${COMPILE} \
        pip3 install --break-system-packages --force-reinstall . \
        > /tmp/pi-ble-config-install.log 2>&1 \
        || { tail -30 /tmp/pi-ble-config-install.log; exit 1; }
    sudo systemctl restart pi-ble-config
    sleep 1
    sudo journalctl -u pi-ble-config -n 20 --no-pager
'"
