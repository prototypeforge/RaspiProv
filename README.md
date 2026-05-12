# RaspiProv (`pi-ble-config`)

Headless Raspberry Pi provisioning over Bluetooth Low Energy.

Project home: <https://github.com/prototypeforge/RaspiProv>

## Public web app
As maybe you don't have time to push that web app into your local machine? There is a public web app that you can use. It's exactly the same as you would deploy it yourself. 

Just visit: 

https://raspi.cxo.ninja


## Quick install (one-liner)

On a freshly-flashed Pi with an internet connection, download the
bootstrap script and run it:

```bash
curl -fsSL https://raw.githubusercontent.com/prototypeforge/RaspiProv/main/scripts/bootstrap.sh -o bootstrap.sh
sudo bash bootstrap.sh
```

It will `apt-get install git`, clone the repo to `/opt/RaspiProv`, and
run `scripts/install.sh` — building the package, installing the systemd
unit, and starting the service. After it finishes, the Pi will advertise
as `PiCfg-<hostname>-<MAC4>` and you can configure it from the web UI.

Override the defaults with env vars if you need to:

```bash
sudo RASPIPROV_REF=v0.1.0 RASPIPROV_DIR=/srv/RaspiProv bash bootstrap.sh
```

For a manual / step-by-step install see [Install on a fresh
Raspberry Pi](#install-on-a-fresh-raspberry-pi) below.

---

This repo has two halves:

| Path             | What it is                                                    |
|------------------|---------------------------------------------------------------|
| `pi_ble_config/` | **Firmware / device-side** Python package that runs on the Pi |
| `web/`           | **Client-side** static web page (Web Bluetooth) for your PC   |

Either half can be replaced without touching the other — the contract
between them is the GATT layout in [GATT layout](#gatt-layout), kept in
sync between `pi_ble_config/protocol.py` and `web/ble.js`.

A small Python service that runs on a Pi and exposes a custom GATT service
over the built-in BLE radio. A phone (or any BLE central) can connect and:

- scan visible WiFi networks
- join a network (SSID + password)
- read live WiFi status (connected? which SSID? what IP?)
- enable / disable the SSH daemon
- read the device's current primary IPv4 address

No network connection on the Pi is required to provision it — the entire
flow happens over BLE.

## Architecture

```
+--------------------+     BlueZ D-Bus     +-----------------------+
| BLE central (phone)| <-----------------> | pi-ble-config (this)  |
+--------------------+   GATT over BLE     |   |                   |
                                           |   +-- nmcli (wifi)    |
                                           |   +-- systemctl (ssh) |
                                           |   +-- socket (ip)     |
                                           +-----------------------+
```

The agent registers itself with BlueZ as a GATT application and an LE
advertisement; BlueZ relays GATT operations from the central to our
characteristic objects.

## GATT layout

Service `6f3a0001-9a2b-4f3e-8d1c-1a2b3c4d5e6f`:

| Char UUID end | Flags                | Payload                                                                  |
|---------------|----------------------|--------------------------------------------------------------------------|
| `...0002`     | read, write, notify  | **Scan.** *Write* any byte to trigger. *Notify* streams `{"t":"begin"}` → repeated `{"t":"net","ssid","sig","sec","in"}` → `{"t":"end","n":N}` (or `{"t":"err","msg"}`). *Read* returns a small JSON fallback list of up to 5 networks. |
| `...0003`     | write                | **Connect.** JSON `{"ssid","password","hidden":false}`.                  |
| `...0004`     | read, notify         | **WiFi status.** JSON `{"iface","connected","ssid","ip","state"}`.       |
| `...0005`     | read, write          | **SSH.** 1 byte: `0` = stopped/disabled, `1` = running/enabled.          |
| `...0006`     | read, notify         | **IP / interfaces.** JSON `{"primary":"x.x.x.x","ifaces":[{"iface","type","ip","state","mac"}, ...]}`. |
| `...0007`     | notify               | **Result channel.** JSON `{"op","ok","msg"}` — outcome of the last write-triggered command. |

WiFi status and IP characteristics are pushed every ~10 s while running,
and at +0/+2/+5/+10 s after a successful `connect` so DHCP-assigned
addresses show up promptly. A BlueZ Just-Works pairing agent is
registered automatically so centrals never get stuck on a pairing
prompt.

---

## Install on a fresh Raspberry Pi

End-to-end walkthrough: blank SD card → working provisioning device.
Tested against Raspberry Pi OS **Bookworm** (Debian 12) on Pi 3 / 4 / 5
and Pi Zero 2 W. Pi Zero W (the original v1.1) is *not* recommended —
its BLE radio works but the slow CPU makes the install very long.

### Hardware checklist

- A Pi with built-in Bluetooth: **Pi 3 / 3+ / 4 / 5 / Zero W / Zero 2 W**.
- Power supply rated for your model (under-volt warnings can knock BlueZ offline).
- microSD card (≥ 8 GB recommended).
- A way to reach the Pi for the *initial* install — Ethernet, an existing
  WiFi network, or USB-OTG/serial console. Once `pi-ble-config` is
  running, future provisioning is over BLE and you no longer need this.

### 1. Flash Raspberry Pi OS

Use **Raspberry Pi Imager** (`https://www.raspberrypi.com/software/`)
and pick *Raspberry Pi OS (64-bit)* — Bookworm or newer. Before clicking
*Write*, open the gear icon / *Edit Settings* and pre-configure:

- ✅ **Set hostname** — e.g. `raspberrypi` (the default). The BLE advertisement name will
  include it, so make it recognisable.
- ✅ **Enable SSH** — password or public key, your choice. You'll need
  this for the install step.
- ✅ **Set username and password** — non-default is strongly recommended.
- ✅ **Configure wireless LAN** — country code, SSID, password. This is
  the SSID the Pi will use *for the install only*; afterwards you'll
  reprovision it over BLE.
- ✅ **Set locale / timezone**.

Flash, eject, insert into the Pi, power on. Give it ~60 s on first boot
to expand the filesystem and apply the imager settings.

### 2. Reach the Pi over the network

```bash
# from your PC — mDNS works on most home networks
ssh pi@raspberrypi.local

# or by IP if mDNS doesn't resolve
arp -a | grep -i raspberry          # find the Pi's IP from your router's ARP table
ssh you@<pi-ip>
```

If you can't get in via mDNS, check `arp -a`, your router's DHCP lease
list, or fall back to a USB-OTG console / monitor + keyboard.

Confirm Bookworm and NetworkManager:

```bash
# On the Pi
cat /etc/os-release | grep VERSION_CODENAME      # → bookworm (or newer)
systemctl is-active NetworkManager               # → active
nmcli device                                     # → wlan0 in 'connected' state
```

If `NetworkManager` is `inactive` (older Bullseye image upgraded in
place), switch to it with:
```bash
sudo raspi-config
# → Advanced Options → Network Config → NetworkManager
sudo reboot
```

### 3. Get the code onto the Pi

Pick whichever fits your workflow.

**A. Git clone on the Pi** (simplest if the repo is online):
```bash
ssh pi@raspberrypi.local
sudo apt-get install -y git
git clone https://github.com/prototypeforge/RaspiProv ~/pi-ble-config
```

**B. rsync from your PC** (best for iterating during development):
```bash
# from your PC, in the directory containing this repo
./scripts/deploy.sh pi@raspberrypi.local
```
That script handles excludes, runs the install on the Pi, restarts the
service, and tails the journal. The rest of this section is what
`deploy.sh` automates.

**C. USB stick / scp** — copy the whole `RaspiProv/` directory to
`~/pi-ble-config` on the Pi.

### 4. Run the installer

```bash
ssh pi@raspberrypi.local
cd ~/pi-ble-config
sudo ./scripts/install.sh
```

What that does:
1. `apt-get install` of `bluez`, `network-manager`, Python build tools.
2. Builds the package with `PI_BLE_CONFIG_COMPILE=1`, which Cython-compiles
   every module under `pi_ble_config/` (except `__init__.py` / `__main__.py`)
   into native `.so` extensions, then installs the resulting wheel.
3. Drops `systemd/pi-ble-config.service` into `/etc/systemd/system/`.
4. `systemctl enable --now pi-ble-config.service`.

Build takes ~30 s on a Pi 4, several minutes on a Pi Zero 2 W. If you
just want to iterate quickly during development, skip the compile:

```bash
sudo pip3 install --break-system-packages .
sudo systemctl restart pi-ble-config
```

### 5. Verify

```bash
# service is up and the agent registered with BlueZ
sudo systemctl status pi-ble-config

# should end with: advertising as 'PiCfg-<hostname>-<MAC4>'
sudo journalctl -u pi-ble-config -n 20 --no-pager

# adapter is powered and our service UUID is in the list
sudo bluetoothctl show | grep -E 'Powered|UUID: Vendor'
```

You should see lines like:
```
INFO pi_ble_config.ble_server: using adapter /org/bluez/hci0
INFO pi_ble_config.ble_server: adapter already powered
INFO pi_ble_config.agent:      agent registered at /com/bluetoothprov/agent (capability=NoInputNoOutput)
INFO pi_ble_config.ble_server: GATT application registered at /com/bluetoothprov
INFO pi_ble_config.ble_server: advertising as 'PiCfg-raspberrypi-1A1C'
INFO pi_ble_config.service:    pi-ble-config running; advertising as 'PiCfg-raspberrypi-1A1C'
```

Then connect to it from the web UI (`web/serve.py` from your PC) — see
[`web/README.md`](./web/README.md).

### 6. Updating later

After editing the code on your PC, push it again:

```bash
./scripts/deploy.sh pi@raspberrypi.local
```

For pure-Python (fast) iteration without Cython:
```bash
./scripts/deploy.sh
```

For a compiled-wheel deploy (slower but ships `.so` not `.py`):
```bash
PI_BLE_CONFIG_COMPILE=1 ./scripts/deploy.sh
```

### 7. Uninstall

```bash
sudo systemctl disable --now pi-ble-config
sudo rm /etc/systemd/system/pi-ble-config.service
sudo systemctl daemon-reload
sudo pip3 uninstall --break-system-packages pi-ble-config
```

Optional: also remove the bonded device record if you paired during testing:
```bash
sudo bluetoothctl
[bluetoothctl]> remove <central-MAC>
```

---

## Troubleshooting

Real failure modes we hit while building this, in roughly the order
they showed up:

### `"no BlueZ adapter with GATT + LE advertising found"` at startup

The Bluetooth service isn't running, or the kernel doesn't see an
adapter:

```bash
sudo systemctl status bluetooth
hciconfig -a    # apt-install bluez-tools if missing
rfkill list
```

Fixes:
- `sudo systemctl enable --now bluetooth`
- `sudo rfkill unblock bluetooth`
- On Pi Zero / older images, ensure `dtoverlay=disable-bt` is **not**
  set in `/boot/firmware/config.txt`.

### `"could not power on the Bluetooth adapter"` (with `Last error: DBusError('Failed')`)

The HCI side is up but the management interface refuses `Powered=true`.
Almost always one of:

```bash
# Most common: rfkill blocks it (sometimes added back by power-mgmt daemons)
rfkill list
sudo rfkill unblock bluetooth

# Or: someone brought hci0 up via raw HCI and bluetoothd is out of sync
sudo hciconfig hci0 down
sudo systemctl restart bluetooth
sleep 2
sudo bluetoothctl show | grep Powered   # expect: Powered: yes
sudo systemctl restart pi-ble-config
```

### `"Failed to register advertisement"`

This is downstream of the previous issue — the controller wasn't really
powered when we tried to advertise. Apply the fix above. If the
controller insists it's powered but registration still fails, check
`btmon` while attempting (see [BLE link drops or stalls](#ble-link-drops-or-stalls)).

### `bluetoothctl` shows `Request confirmation` and the central drops

This means a pairing prompt arrived but no agent answered it. **This
should no longer happen** — the firmware registers a `NoInputNoOutput`
Just-Works pairing agent automatically at startup
(see `pi_ble_config/agent.py`). If you ever see this with a current
build, the symptom is usually an interactive `bluetoothctl` session
holding the default-agent slot somewhere else; close it, then:

```bash
sudo systemctl restart pi-ble-config
```

### "Unexpected end of JSON input" on the web UI scan

Single-shot reads are capped at 512 bytes by the GATT spec; old
firmware returned the whole list of networks in one read and overflowed
it. The current code uses the **streaming protocol** (`begin` → many
`net` frames → `end`) and the web UI auto-uses it. If you still see
this error, you're running a mismatched old client against new firmware
(or vice versa). Hard-reload the web page (`Ctrl+Shift+R`) and update
the firmware to the matching commit.

### BLE link drops or stalls

The single most useful diagnostic is `btmon`:

```bash
# Terminal 1 on the Pi
sudo btmon | tee /tmp/btmon.log

# Terminal 2 on the Pi — interleaved bluetoothd + our service
sudo journalctl -u bluetooth -u pi-ble-config -f
```

Then connect from your PC and watch what happens. The last few
`Disconnect Complete  Reason: ...` lines in `btmon` name the cause:
- `Connection Timeout (0x08)` — supervision timer expired, usually
  contention or stalled responses.
- `Remote User Terminated Connection (0x13)` — the peripheral hung up.
- `Local Host Terminated Connection (0x16)` — the PC's BlueZ hung up.

The web UI's **"last update Xs ago"** pill in the Status card is a
quick separator of "link dead" from "link fine but data missing":
green = receiving notifications, red = link is gone even if Chrome
hasn't fired `gattserverdisconnected` yet.

### Interfaces table shows no IP after successful WiFi connect

`nmcli connect` returns as soon as association completes; DHCP can
take another few seconds. The firmware refreshes at +0/+2/+5/+10 s
after a connect so the IP usually fills in within ~10 s. If it
*never* fills in, DHCP itself is failing on the Pi — check:

```bash
sudo journalctl -u pi-ble-config -n 30 --no-pager | grep 'ip refresh'
# Look for lines like:
#   ip refresh: primary=10.0.0.42 ifaces=[wlan0/wifi=10.0.0.42/up, ...]
# If primary=(none) and the wifi iface has no IP, it's a DHCP problem.

nmcli device show wlan0 | grep IP4
```

### Two BLE peripherals already in use on the PC (e.g. a BLE mouse)

Connections to the Pi may drop quickly because the PC's controller is
spending most of its airtime on the mouse's 7.5 ms connection interval.
Either disconnect the BLE accessory during provisioning, or use a
dedicated BLE USB dongle as `hci1`. See `docs/btmon` traces in the
issue tracker for examples.

## Manual / development run

For poking at the firmware without going through the deploy script:

```bash
# Plain Python install (no Cython compilation — fast)
sudo pip3 install --break-system-packages -e .

# Compiled install (Cython -> .so modules — slower, ships native code)
sudo PI_BLE_CONFIG_COMPILE=1 pip3 install --break-system-packages .

# Stop the systemd unit so it doesn't fight you for the BLE adapter
sudo systemctl stop pi-ble-config

# Run the agent in the foreground with verbose logging
sudo pi-ble-config -vv

# When done:
sudo systemctl start pi-ble-config
```

## Client side

A complete Web Bluetooth client lives in [`web/`](./web). To use it from
your PC:

```bash
cd web
python3 -m http.server 8080
# open http://localhost:8080 in Chrome or Edge
```

It provides connect / scan / join / SSH toggle / status, plus an in-page
log panel that captures every BLE operation (with hex dumps, timings, and
errors) and can be saved as a `.log` file. See [`web/README.md`](./web/README.md)
for details.

Any other BLE stack also works (CoreBluetooth, BlueZ on Linux, `bleak` on
desktop Python). Bleak pseudocode, using the streaming scan protocol:

```python
import json, asyncio
from bleak import BleakClient, BleakScanner

SERVICE_UUID = "6f3a0001-9a2b-4f3e-8d1c-1a2b3c4d5e6f"
SCAN_CHAR    = "6f3a0002-9a2b-4f3e-8d1c-1a2b3c4d5e6f"
CONNECT_CHAR = "6f3a0003-9a2b-4f3e-8d1c-1a2b3c4d5e6f"
SSH_CHAR     = "6f3a0005-9a2b-4f3e-8d1c-1a2b3c4d5e6f"
IP_CHAR      = "6f3a0006-9a2b-4f3e-8d1c-1a2b3c4d5e6f"

async def main():
    dev = await BleakScanner.find_device_by_filter(
        lambda d, ad: SERVICE_UUID.lower() in [u.lower() for u in (ad.service_uuids or [])]
    )
    async with BleakClient(dev) as c:
        # Streaming scan: subscribe, write any byte to trigger,
        # collect frames until {"t":"end"}.
        done = asyncio.Event()
        networks = []
        def on_frame(_, data: bytearray):
            frame = json.loads(bytes(data).decode())
            if frame["t"] == "net": networks.append(frame)
            elif frame["t"] in ("end", "err"): done.set()
        await c.start_notify(SCAN_CHAR, on_frame)
        await c.write_gatt_char(SCAN_CHAR, b"\x01", response=True)
        await done.wait()
        await c.stop_notify(SCAN_CHAR)
        print(networks)

        # Join a network (set hidden=True for non-broadcast SSIDs).
        await c.write_gatt_char(
            CONNECT_CHAR,
            json.dumps({"ssid": "MyWifi", "password": "secret", "hidden": False}).encode(),
            response=True,
        )

        # Inspect what got assigned.
        ip = json.loads((await c.read_gatt_char(IP_CHAR)).decode())
        print(ip["primary"], ip["ifaces"])

        # Turn SSH on.
        await c.write_gatt_char(SSH_CHAR, b"\x01")

asyncio.run(main())
```

## Permissions

The unit runs as root because:
- BlueZ requires privileged access on the system bus for
  `RegisterApplication` / `RegisterAdvertisement`.
- `nmcli device wifi connect` and `systemctl start ssh` both need root.

If you need to run as a non-root user, you'll need polkit rules for
`org.freedesktop.NetworkManager.network-control`, BlueZ, and systemd's
`manage-units` — see the BlueZ and NetworkManager docs.

## Why "compiled"?

`PI_BLE_CONFIG_COMPILE=1` runs every module under `pi_ble_config/` (except
`__init__.py` and `__main__.py`) through Cython with `language_level=3`,
producing CPython extension modules. The shipped wheel contains `.so`
files instead of source `.py`, which obscures the source on the device
and gives a small import-time speedup. Pure-Python builds remain
supported for development.

## License

MIT.
