#!/usr/bin/env bash
# One-shot installer for RaspiProv (pi-ble-config) on a fresh Raspberry Pi.
#
# Typical use, on the Pi:
#   curl -fsSL https://raw.githubusercontent.com/prototypeforge/RaspiProv/main/scripts/bootstrap.sh -o bootstrap.sh
#   sudo bash bootstrap.sh
#
# Env vars:
#   RASPIPROV_REPO    git URL                 (default: https://github.com/prototypeforge/RaspiProv.git)
#   RASPIPROV_REF     branch / tag / commit   (default: main)
#   RASPIPROV_DIR     checkout path on the Pi (default: /opt/RaspiProv)
set -euo pipefail

REPO="${RASPIPROV_REPO:-https://github.com/prototypeforge/RaspiProv.git}"
REF="${RASPIPROV_REF:-main}"
DIR="${RASPIPROV_DIR:-/opt/RaspiProv}"

if [[ $EUID -ne 0 ]]; then
    echo "This bootstrap needs root. Re-run with: sudo bash $0" >&2
    exit 1
fi

echo "==> Installing git"
apt-get update
apt-get install -y --no-install-recommends git ca-certificates

if [[ -d "$DIR/.git" ]]; then
    echo "==> Updating existing checkout in $DIR"
    git -C "$DIR" fetch --depth 1 origin "$REF"
    git -C "$DIR" checkout FETCH_HEAD
else
    echo "==> Cloning $REPO ($REF) into $DIR"
    mkdir -p "$(dirname "$DIR")"
    git clone --depth 1 --branch "$REF" "$REPO" "$DIR"
fi

echo "==> Running installer"
chmod +x "$DIR/scripts/install.sh"
exec "$DIR/scripts/install.sh"
