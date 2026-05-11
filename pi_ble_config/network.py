"""Network introspection: primary IPv4 + per-interface listing.

Pure stdlib — no shelling out to ``ip``/``ifconfig``, no dependency on
NetworkManager being healthy. Reads ``/sys/class/net/`` for the topology
and uses ``SIOCGIFADDR`` (the same ioctl ``ifconfig`` uses) for the IPv4
address. Works on any modern Linux including stripped-down Pi images.
"""
from __future__ import annotations

import asyncio
import fcntl
import os
import socket
import struct
from typing import Any


# ``man netdevice`` — SIOCGIFADDR returns the iface's IPv4 in a sockaddr.
SIOCGIFADDR = 0x8915
SYSFS = "/sys/class/net"


async def primary_ip() -> str:
    """Best-effort: address used to reach the default gateway.

    Returns an empty string if the device has no usable route. Useful as
    a single "the IP" answer when callers don't care about per-interface
    detail.
    """
    def _pick() -> str:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.settimeout(0.5)
            s.connect(("1.1.1.1", 80))   # UDP — no packets actually sent
            return s.getsockname()[0]
        except OSError:
            return ""
        finally:
            s.close()
    return await asyncio.get_running_loop().run_in_executor(None, _pick)


async def hostname() -> str:
    return socket.gethostname()


def _iface_ipv4(name: str) -> str:
    """Return IPv4 address for ``name`` or ``""`` if unassigned."""
    if len(name) > 15:
        # The IFNAMSIZ kernel limit; longer names can't be queried.
        return ""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        packed = struct.pack("256s", name.encode())
        # The address sits at bytes 20..24 of the returned struct.
        raw = fcntl.ioctl(s.fileno(), SIOCGIFADDR, packed)[20:24]
        return socket.inet_ntoa(raw)
    except OSError:
        return ""
    finally:
        s.close()


def _read(path: str) -> str:
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return ""


def _iface_type(name: str) -> str:
    """Classify as ``wifi`` / ``ethernet`` / ``loopback`` / ``other``.

    Uses the presence of ``/sys/class/net/<iface>/wireless/`` for WiFi
    (universally true for any cfg80211-managed device, irrespective of
    naming convention like ``wlan0`` vs ``wlp2s0``). Falls back to the
    ARP hardware type number from ``/sys/.../type``.
    """
    if os.path.isdir(f"{SYSFS}/{name}/wireless"):
        return "wifi"
    type_no = _read(f"{SYSFS}/{name}/type")
    if type_no == "772":     # ARPHRD_LOOPBACK
        return "loopback"
    if type_no == "1":       # ARPHRD_ETHER
        return "ethernet"
    return "other"


def _iface_state(name: str) -> str:
    # operstate is one of: up, down, dormant, unknown, ...
    return _read(f"{SYSFS}/{name}/operstate") or "unknown"


def _iface_mac(name: str) -> str:
    return _read(f"{SYSFS}/{name}/address")


async def interfaces(include_loopback: bool = False) -> list[dict[str, Any]]:
    """Return all interfaces with IPv4 + type + link state.

    Sorted with up + addressed interfaces first so the UI can show the
    "useful" ones at the top. Loopback is excluded by default.
    """
    def _enum() -> list[dict[str, Any]]:
        try:
            names = sorted(os.listdir(SYSFS))
        except OSError:
            return []
        out: list[dict[str, Any]] = []
        for name in names:
            t = _iface_type(name)
            if t == "loopback" and not include_loopback:
                continue
            out.append({
                "iface": name,
                "type":  t,
                "ip":    _iface_ipv4(name),
                "state": _iface_state(name),
                "mac":   _iface_mac(name),
            })
        # Useful first: state==up AND has an IP, then state==up, then rest.
        def _rank(i: dict[str, Any]) -> tuple[int, str]:
            up = i["state"].lower() == "up"
            has_ip = bool(i["ip"])
            return (0 if (up and has_ip) else 1 if up else 2, i["iface"])
        out.sort(key=_rank)
        return out

    return await asyncio.get_running_loop().run_in_executor(None, _enum)
