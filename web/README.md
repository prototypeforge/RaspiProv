# Web BLE client for pi-ble-config

A static web page that runs in your desktop browser and talks to the Pi
over the **Web Bluetooth API**. No build step, no framework, no backend —
just three JS modules and a stylesheet.

## Files

| File         | Role                                                          |
|--------------|---------------------------------------------------------------|
| `index.html` | Page layout: status, WiFi list, join form, SSH switch, log.   |
| `styles.css` | Dark theme, grid layout, log panel styling.                   |
| `logger.js`  | In-page logger: timestamped, levelled, downloadable as `.log`.|
| `ble.js`     | `PiBleClient` — Web Bluetooth wrapper for the Pi GATT service.|
| `app.js`     | UI orchestration — wires the DOM to `ble.js`.                 |

## Requirements

- Chrome, Edge, or another Chromium-based browser. Firefox and Safari
  do **not** ship Web Bluetooth.
- Page must be served from `https://` or `http://localhost`. Web Bluetooth
  is blocked in plain `http://` insecure contexts.
- On **Linux**, Web Bluetooth may be disabled by default. If
  `navigator.bluetooth` is `undefined` even on localhost, enable
  *Web Bluetooth* and *Experimental Web Platform features* in
  `chrome://flags` and relaunch.
- **Snap and Flatpak builds of Chrome/Chromium will *not* work** — the
  sandbox blocks the D-Bus path to BlueZ, so `navigator.bluetooth` stays
  `undefined` regardless of flags. Verify with
  `which google-chrome` — if the path is under `/snap/...`, replace it
  with the official `.deb` from <https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb>
  and launch via `/usr/bin/google-chrome`.
- On **Linux**, verify the API is alive by visiting `chrome://bluetooth-internals/`
  — if it loads with adapter controls, Web Bluetooth works.
- The Pi must be running `pi-ble-config` and advertising as `PiCfg-*`.
- The PC must have a Bluetooth radio capable of BLE central role.

## Run it

**Local-only (simplest, localhost only):**
```bash
cd web
python3 -m http.server 8080
```
Open <http://localhost:8080> in Chrome/Edge.

**LAN-accessible (HTTPS with self-signed cert):**
```bash
cd web
python3 serve.py             # default: 0.0.0.0:8443
```
Open <https://localhost:8443> on the same PC, **or** `https://<your-pc-ip>:8443`
from another device. Each device shows a "Not secure" warning the first
time — click *Advanced* → *Proceed*. Web Bluetooth treats the page as a
secure context once you accept, and `navigator.bluetooth` becomes available.

The cert is generated on first run as `dev-cert.pem` / `dev-key.pem` in
the `web/` directory. Delete them to regenerate.

## Using the UI

1. Click **Connect to Pi** — the browser shows a chooser listing devices
   advertising our service UUID. Pick `PiCfg-<hostname>`.
2. After connect, the **Status** card fills in (WiFi state, SSID, IP, SSH).
   The page also subscribes to live notifications for status, IP, and the
   command-result channel.
3. **Scan** lists visible networks. Click *Use* on a row to prefill the
   SSID into the join form.
4. **Join** sends `{ssid, password}` to the connect characteristic. The
   firmware replies on the result channel — you'll see it in the log and
   in the *Last result* field. On success, status + IP refresh.
5. Toggle the **SSH** switch to enable/disable `sshd`. The new state is
   confirmed by a re-read.

## The log panel

Everything BLE-related goes through `logger.js`:

- BLE lifecycle: `requestDevice`, GATT connect, characteristic discovery,
  disconnect.
- Every read/write with byte length, timing, and (for JSON) decoded
  content.
- Every notification with hex + UTF-8 dump.
- All errors with stack traces.

Controls:

- **level** — filter the panel (`debug` shows everything; entries are
  always stored regardless of filter).
- **Clear** — empty the panel and in-memory buffer.
- **Download** — save the full session as a plain text `.log` file.

The same entries are mirrored to the browser devtools console
(`console.debug` / `info` / `warn` / `error`) if you want to filter or
search there instead.

## Hacking on it

The GATT UUIDs are duplicated between `ble.js` and the firmware's
`pi_ble_config/protocol.py`. If you change one, change the other.

There is no bundler. Modules use native `<script type="module">` and ESM
`import`. Browsers cache aggressively — hard-reload (`Ctrl+Shift+R`)
after edits.
