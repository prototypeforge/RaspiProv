"""Glue: bind characteristic read/write callbacks to wifi/ssh/network."""
from __future__ import annotations

import asyncio
import logging
import os
import socket

from . import network, ssh, wifi
from .ble_server import Peripheral
from .protocol import (
    CHAR_IP_UUID,
    CHAR_RESULT_UUID,
    CHAR_SSH_UUID,
    CHAR_WIFI_CONNECT_UUID,
    CHAR_WIFI_SCAN_UUID,
    CHAR_WIFI_STATUS_UUID,
    SERVICE_UUID,
    decode_json,
    encode_json,
    result_payload,
)


# Cap for the legacy single-read fallback so we never exceed the 512-byte
# GATT characteristic value limit. The streaming flow has no such cap.
LEGACY_READ_LIMIT = 5

# Small delay between streamed notifications so BlueZ doesn't coalesce
# rapid PropertiesChanged emissions on the Value property. 30 networks
# × 50 ms = ~1.5 s end-to-end — fine for an interactive UI, well under
# any BLE supervision timeout.
NOTIFY_INTERVAL_S = 0.05


log = logging.getLogger(__name__)


def _wifi_mac_suffix() -> str:
    """Return last two octets of the first WiFi NIC's MAC, e.g. ``"1A1C"``.

    Reads ``/sys/class/net/<iface>/address`` directly so we don't depend
    on nmcli at name-resolution time (this runs before BLE setup). Picks
    the first interface whose name starts with "wl" — the kernel naming
    rule for WLAN devices on Linux (``wlan0``, ``wlp2s0`` etc.).

    Returns an empty string if no WiFi interface exists or the address
    file is unreadable; callers should treat that as "skip the suffix"
    rather than fail, so the agent still works on Ethernet-only Pis.
    """
    try:
        ifaces = sorted(os.listdir("/sys/class/net"))
    except OSError:
        return ""
    for iface in ifaces:
        if not iface.startswith("wl"):
            continue
        try:
            with open(f"/sys/class/net/{iface}/address") as f:
                mac = f.read().strip()
        except OSError:
            continue
        parts = mac.split(":")
        if len(parts) == 6:
            return (parts[4] + parts[5]).upper()
    return ""


def default_local_name() -> str:
    """Advertised name: ``PiCfg-<hostname>-<XXXX>``.

    ``XXXX`` is the last two octets of the WiFi MAC, which gives each
    device a stable, visually distinct identifier even when several Pis
    share the same hostname (which happens by default on Raspberry Pi
    OS images: every fresh flash is called ``raspberrypi``).

    The full string is truncated to fit BlueZ's scan-response budget.
    Modern BlueZ puts the local name in the scan response when a 128-bit
    service UUID is being advertised, leaving ~28 chars of headroom.
    """
    MAX = 28
    suffix = _wifi_mac_suffix()
    hostname = socket.gethostname()

    if not suffix:
        return f"PiCfg-{hostname}"[:MAX]

    # Reserve room for the trailing "-XXXX" suffix; if hostname is long,
    # trim the hostname rather than the suffix (the suffix is what makes
    # the name unique, which is the whole point).
    prefix = "PiCfg-"
    reserved = len(prefix) + 1 + len(suffix)  # "-XXXX"
    avail = MAX - reserved
    if avail < 1:
        return f"PiCfg-{suffix}"[:MAX]
    return f"{prefix}{hostname[:avail]}-{suffix}"


class ProvisioningService:
    def __init__(self, local_name: str | None = None):
        self._local_name = local_name or default_local_name()
        self._periph = Peripheral(SERVICE_UUID, self._local_name)
        self._status_task: asyncio.Task | None = None
        self._scan_task: asyncio.Task | None = None
        self._stop_event = asyncio.Event()

    # ----- characteristic handlers ----- #

    async def _on_read_scan(self) -> bytes:
        """Legacy single-read path — capped to a few networks.

        A single GATT characteristic value is limited to 512 bytes. With
        30 networks the JSON list easily exceeds that and the central's
        ``readValue`` returns a truncated/empty payload. The proper way
        to get the full list is the *streaming* path below: write any
        byte to this characteristic, then receive one notification per
        network. This read is kept only as a tiny fallback for callers
        that haven't been updated yet.
        """
        try:
            networks = await wifi.scan(limit=LEGACY_READ_LIMIT)
            return encode_json([n.to_dict() for n in networks])
        except wifi.WifiError as e:
            log.warning("scan failed: %s", e)
            return encode_json({"error": str(e)})

    async def _on_write_scan(self, data: bytes) -> None:
        """Trigger a streaming scan. The actual write payload is ignored.

        Cancels any previously running stream so the central always gets
        a coherent ``begin``/.../``end`` sequence for the most recent
        request, even if it spam-clicks the scan button.
        """
        log.info("scan trigger received (%d bytes payload)", len(data))
        if self._scan_task is not None and not self._scan_task.done():
            log.info("cancelling previous scan stream")
            self._scan_task.cancel()
            try:
                await self._scan_task
            except (asyncio.CancelledError, Exception):
                pass
        self._scan_task = asyncio.create_task(self._stream_scan())

    async def _stream_scan(self) -> None:
        """Run the scan and notify one network frame at a time."""
        ch = self._periph.characteristic(CHAR_WIFI_SCAN_UUID)

        await self._notify_scan(ch, {"t": "begin"})
        await asyncio.sleep(NOTIFY_INTERVAL_S)

        try:
            networks = await wifi.scan(rescan=True, limit=30)
        except wifi.WifiError as e:
            log.warning("streaming scan: nmcli failed: %s", e)
            await self._notify_scan(ch, {"t": "err", "msg": str(e)})
            return
        except asyncio.CancelledError:
            log.info("streaming scan cancelled before nmcli finished")
            raise

        # Sort strongest first (wifi.scan already does this, but be
        # defensive in case anyone changes that).
        networks = sorted(networks, key=lambda n: n.signal, reverse=True)

        for n in networks:
            frame = {
                "t":   "net",
                "ssid": n.ssid,
                "sig":  n.signal,
                "sec":  n.security,
                "in":   n.in_use,
            }
            await self._notify_scan(ch, frame)
            await asyncio.sleep(NOTIFY_INTERVAL_S)

        await self._notify_scan(ch, {"t": "end", "n": len(networks)})
        log.info("streaming scan: emitted %d networks", len(networks))

    async def _notify_scan(self, ch, frame: dict) -> None:
        """One notification on the scan characteristic."""
        ch.update_value(encode_json(frame))

    async def _on_write_connect(self, data: bytes) -> None:
        try:
            payload = decode_json(data)
            ssid = payload.get("ssid", "")
            password = payload.get("password") or None
            hidden = bool(payload.get("hidden", False))
        except Exception as e:
            await self._push_result("connect", False, f"bad payload: {e}")
            return
        log.info("connect request: ssid=%r hidden=%s", ssid, hidden)
        try:
            await wifi.connect(ssid, password, hidden=hidden)
        except wifi.WifiError as e:
            await self._push_result("connect", False, str(e))
            return
        await self._push_result("connect", True, f"associated with {ssid}")
        # Immediate refresh, then a staged sequence — nmcli returns
        # "connected" as soon as association completes, but DHCP often
        # needs another 1–5 s before an IPv4 address is actually bound
        # to the interface. Push fresh status snapshots at those points
        # so the UI fills in without waiting a full periodic tick.
        await self._refresh_status_and_ip()
        asyncio.create_task(self._delayed_refreshes((2.0, 5.0, 10.0)))

    async def _delayed_refreshes(self, delays: tuple[float, ...]) -> None:
        for d in delays:
            try:
                await asyncio.sleep(d)
                if self._stop_event.is_set():
                    return
                await self._refresh_status_and_ip()
                log.info("post-connect refresh fired at +%.1fs", d)
            except asyncio.CancelledError:
                return
            except Exception:
                log.exception("post-connect refresh at +%.1fs failed", d)

    async def _on_read_status(self) -> bytes:
        return encode_json(await wifi.status())

    async def _on_read_ssh(self) -> bytes:
        return bytes([1 if await ssh.is_enabled() else 0])

    async def _on_write_ssh(self, data: bytes) -> None:
        enable = bool(data and data[0])
        log.info("ssh request: enable=%s", enable)
        try:
            await ssh.set_enabled(enable)
        except ssh.SshError as e:
            await self._push_result("ssh", False, str(e))
            return
        # Reflect new state on the characteristic itself so a read sees it.
        ch = self._periph.characteristic(CHAR_SSH_UUID)
        ch.update_value(bytes([1 if enable else 0]))
        await self._push_result("ssh", True, "enabled" if enable else "disabled")

    async def _on_read_ip(self) -> bytes:
        """Return JSON: {"primary": "...", "ifaces": [...]}.

        Was a bare UTF-8 IP string in earlier protocol revisions; we
        upgraded to a structured payload so the UI can show every
        interface (eth and wifi) rather than just the kernel's "default
        route" pick. Still well under the 512-byte single-read limit
        even on a Pi with several Docker bridges.
        """
        primary = await network.primary_ip()
        ifaces = await network.interfaces()
        return encode_json({"primary": primary, "ifaces": ifaces})

    # ----- helpers ----- #

    async def _push_result(self, op: str, ok: bool, msg: str = "") -> None:
        ch = self._periph.characteristic(CHAR_RESULT_UUID)
        ch.update_value(result_payload(op, ok, msg))
        log.info("result op=%s ok=%s msg=%s", op, ok, msg)

    async def _refresh_status_and_ip(self) -> None:
        try:
            self._periph.characteristic(CHAR_WIFI_STATUS_UUID).update_value(
                encode_json(await wifi.status())
            )
        except Exception:
            log.exception("status refresh failed")
        try:
            primary = await network.primary_ip()
            ifaces = await network.interfaces()
            payload = {"primary": primary, "ifaces": ifaces}
            self._periph.characteristic(CHAR_IP_UUID).update_value(encode_json(payload))
            # Human-readable trace so the journal shows what we pushed.
            log.info(
                "ip refresh: primary=%s ifaces=[%s]",
                primary or "(none)",
                ", ".join(
                    f"{i['iface']}/{i['type']}={i['ip'] or '-'}/{i['state']}"
                    for i in ifaces
                ),
            )
        except Exception:
            log.exception("ip refresh failed")

    async def _status_loop(self) -> None:
        """Periodically refresh status + IP characteristics."""
        while not self._stop_event.is_set():
            await self._refresh_status_and_ip()
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=10.0)
            except asyncio.TimeoutError:
                continue

    # ----- lifecycle ----- #

    async def setup(self) -> None:
        await self._periph.connect_bus()
        self._periph.build_service()
        self._periph.add_characteristic(
            CHAR_WIFI_SCAN_UUID,
            flags=["read", "write", "notify"],
            read_fn=self._on_read_scan,
            write_fn=self._on_write_scan,
        )
        self._periph.add_characteristic(
            CHAR_WIFI_CONNECT_UUID,
            flags=["write"],
            write_fn=self._on_write_connect,
        )
        self._periph.add_characteristic(
            CHAR_WIFI_STATUS_UUID,
            flags=["read", "notify"],
            read_fn=self._on_read_status,
        )
        self._periph.add_characteristic(
            CHAR_SSH_UUID,
            flags=["read", "write"],
            read_fn=self._on_read_ssh,
            write_fn=self._on_write_ssh,
        )
        self._periph.add_characteristic(
            CHAR_IP_UUID,
            flags=["read", "notify"],
            read_fn=self._on_read_ip,
        )
        self._periph.add_characteristic(
            CHAR_RESULT_UUID,
            flags=["notify"],
        )
        await self._periph.register()

    async def run(self) -> None:
        await self.setup()
        self._status_task = asyncio.create_task(self._status_loop())
        log.info("pi-ble-config running; advertising as %r", self._local_name)
        await self._stop_event.wait()

    async def shutdown(self) -> None:
        self._stop_event.set()
        for task in (self._status_task, self._scan_task):
            if task is not None:
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass
        await self._periph.close()
