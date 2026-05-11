#!/usr/bin/env bash
# Install pi-ble-config on a Raspberry Pi running Raspberry Pi OS (Bookworm+).
# Requires: BlueZ, NetworkManager, Python 3.9+, pip, sudo.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
    echo "This installer needs root. Re-run with sudo." >&2
    exit 1
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Installing system dependencies"
apt-get update
apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    bluez network-manager

echo "==> Making sure NetworkManager owns wifi (not dhcpcd)"
systemctl enable --now NetworkManager.service || true

echo "==> Building and installing the Python package"
# Compiled build: cythonize the .py modules into .so before packaging.
PI_BLE_CONFIG_COMPILE=1 pip3 install --break-system-packages "${REPO_DIR}"

echo "==> Installing systemd unit"
install -m 0644 "${REPO_DIR}/systemd/pi-ble-config.service" \
    /etc/systemd/system/pi-ble-config.service
systemctl daemon-reload
systemctl enable --now pi-ble-config.service

echo "==> Status:"
systemctl --no-pager --full status pi-ble-config.service || true

echo
echo "Done. Look for the BLE advertisement 'PiCfg-$(hostname)' from a client."
