"""WiFi management via NetworkManager's ``nmcli``.

Raspberry Pi OS Bookworm (and any modern NM-based image) ships nmcli.
We shell out instead of using libnm bindings so the agent works on any
distro that has NetworkManager installed, with no extra system packages.
"""
from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass, asdict
from typing import Any


log = logging.getLogger(__name__)


WIFI_IFACE_FALLBACK = "wlan0"


@dataclass
class WifiNetwork:
    ssid: str
    signal: int          # 0..100
    security: str        # e.g. "WPA2", "WPA3", "--" for open
    in_use: bool = False

    def to_dict(self) -> dict:
        return asdict(self)


class WifiError(RuntimeError):
    pass


async def _run(*args: str, timeout: float = 30.0) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise WifiError(f"timeout running: {' '.join(args)}")
    return proc.returncode or 0, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")


def _parse_terse(line: str) -> list[str]:
    # nmcli -t uses ':' as field separator, backslash-escapes literal ':'.
    out: list[str] = []
    buf: list[str] = []
    i = 0
    while i < len(line):
        c = line[i]
        if c == "\\" and i + 1 < len(line):
            buf.append(line[i + 1])
            i += 2
            continue
        if c == ":":
            out.append("".join(buf))
            buf = []
            i += 1
            continue
        buf.append(c)
        i += 1
    out.append("".join(buf))
    return out


async def get_wifi_iface() -> str:
    """Return the name of the first WiFi interface, or a fallback."""
    rc, out, _ = await _run("nmcli", "-t", "-f", "DEVICE,TYPE", "device")
    if rc == 0:
        for line in out.splitlines():
            fields = _parse_terse(line)
            if len(fields) >= 2 and fields[1] == "wifi":
                return fields[0]
    return WIFI_IFACE_FALLBACK


_rescan_task: asyncio.Task | None = None
DEFAULT_LIMIT = 30


async def _background_rescan(iface: str) -> None:
    """Fire `nmcli ... rescan` and discard the result.

    Errors are ignored — NM rate-limits rescans (~10 s) and we just want
    to nudge it; the next ``scan()`` call will pick up whatever it found.
    """
    try:
        await _run("nmcli", "device", "wifi", "rescan", "ifname", iface, timeout=15.0)
    except Exception:
        pass


async def scan(rescan: bool = True, limit: int = DEFAULT_LIMIT) -> list[WifiNetwork]:
    """Return visible networks, strongest first, capped at ``limit``.

    If ``rescan`` is True, kick off an ``nmcli rescan`` in the background
    so the *next* call sees fresh results — but return immediately with
    whatever NM has cached now. A synchronous rescan can block for 10+ s,
    which is longer than a BLE read should ever take.
    """
    global _rescan_task
    iface = await get_wifi_iface()

    if rescan and (_rescan_task is None or _rescan_task.done()):
        _rescan_task = asyncio.create_task(_background_rescan(iface))

    rc, out, err = await _run(
        "nmcli", "-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY",
        "device", "wifi", "list", "ifname", iface,
        timeout=5.0,
    )
    if rc != 0:
        raise WifiError(f"nmcli wifi list failed: {err.strip()}")

    seen: dict[str, WifiNetwork] = {}
    for line in out.splitlines():
        fields = _parse_terse(line)
        if len(fields) < 4:
            continue
        in_use_raw, ssid, signal_raw, security = fields[0], fields[1], fields[2], fields[3]
        if not ssid:
            continue  # hidden network with no SSID broadcast
        try:
            signal = int(signal_raw)
        except ValueError:
            signal = 0
        in_use = in_use_raw.strip() == "*"
        net = WifiNetwork(
            ssid=ssid,
            signal=signal,
            security=security or "--",
            in_use=in_use,
        )
        # Same SSID may appear on multiple BSSIDs — keep the strongest.
        prev = seen.get(ssid)
        if prev is None or net.signal > prev.signal:
            seen[ssid] = net

    nets = sorted(seen.values(), key=lambda n: n.signal, reverse=True)
    return nets[:limit] if limit else nets


async def _profiles_for_ssid(ssid: str) -> list[str]:
    """Return all NM connection profile names whose 802-11 SSID matches.

    A profile's display name (``NAME``) is *not* the same as its SSID —
    NetworkManager creates them with the SSID by default, but anything
    can rename them (the system tray applet, manual creation, an old
    version of our own code that used a different naming scheme). So
    "delete by name" is not enough: a stale profile under a different
    name with a broken ``key-mgmt`` will keep blocking activation until
    we remove it explicitly.

    Implementation: list all wifi profiles, then for each one read its
    ``802-11-wireless.ssid`` and compare. Cheap on a Pi (<20 ms total
    even with many profiles).
    """
    rc, out, _ = await _run(
        "nmcli", "-t", "-f", "NAME,TYPE", "connection", "show",
        timeout=5.0,
    )
    if rc != 0:
        return []

    candidates: list[str] = []
    for line in out.splitlines():
        fields = _parse_terse(line)
        if len(fields) >= 2 and fields[1] == "802-11-wireless":
            candidates.append(fields[0])

    matches: list[str] = []
    for name in candidates:
        rc2, out2, _ = await _run(
            "nmcli", "-t", "-g", "802-11-wireless.ssid",
            "connection", "show", name,
            timeout=5.0,
        )
        if rc2 == 0 and out2.strip() == ssid:
            matches.append(name)
    return matches


_FRIENDLY_ERRORS: tuple[tuple[str, str], ...] = (
    # nmcli message substring                      → user-facing message
    ("Secrets were required, but not provided",   "Wrong password."),
    ("802-11-wireless-security.psk: property is invalid",
                                                  "Password is invalid (8–63 characters required for WPA-PSK)."),
    ("psk has to be between",                     "Password is invalid (8–63 characters required for WPA-PSK)."),
    ("No network with SSID",                      "Network not visible. If it's hidden, tick \"Hidden network\"."),
    ("not found",                                 "Network not visible. If it's hidden, tick \"Hidden network\"."),
    ("802-11-wireless-security.key-mgmt",         "Stale Wi-Fi profile blocked activation. Retry — the next attempt clears it."),
    ("Operation timed out",                       "Timed out joining the network — weak signal or wrong password."),
    ("Connection activation failed",              "Could not associate with the network."),
)


def _translate_nmcli_error(raw: str) -> str:
    """Map a known nmcli failure substring to a one-line user message.

    Falls back to the original message if nothing matches — better to
    show a wall of text than to hide it. We also strip the leading
    ``Error: `` prefix nmcli always emits, which is noise.
    """
    s = (raw or "").strip()
    s = s.removeprefix("Error: ")
    for needle, friendly in _FRIENDLY_ERRORS:
        if needle in s:
            return f"{friendly} ({s})" if len(s) < 200 else friendly
    return s or "Unknown error."


async def connect(
    ssid: str,
    password: str | None = None,
    hidden: bool = False,
) -> None:
    """Associate with an SSID. Raises WifiError with a friendly message.

    Defensive pipeline:

    1. **Wipe every** existing profile whose 802-11 SSID matches —
       not just the one named after the SSID. Old profiles with broken
       ``key-mgmt`` cause the famous
       ``802-11-wireless-security.key-mgmt : property is missing`` and
       persist until explicitly deleted.

    2. **Build a fresh profile** with key-mgmt set explicitly. For
       WPA2/WPA3-PSK mixed APs (the common case) ``wpa-psk`` works for
       both: NM negotiates SAE automatically when the AP advertises
       WPA3.

    3. **Verify** ``key-mgmt`` survived the add step. If somehow it
       didn't, we set it explicitly via ``connection modify`` rather
       than letting ``connection up`` fail with the confusing
       "property is missing" error.

    4. **Bring it up** with a generous timeout and translate the
       failure into a user-readable message.

    Open networks (no password) skip the security properties entirely.
    """
    if not ssid:
        raise WifiError("ssid is required")
    iface = await get_wifi_iface()
    log.info(
        "wifi.connect: ssid=%r iface=%s hidden=%s has_password=%s",
        ssid, iface, hidden, bool(password),
    )

    # ---- 1. Wipe every matching profile, by SSID not just name ----
    stale = await _profiles_for_ssid(ssid)
    if stale:
        log.info("wifi.connect: deleting %d stale profile(s): %r", len(stale), stale)
    for name in stale:
        rc, _, err = await _run("nmcli", "connection", "delete", name, timeout=5.0)
        if rc != 0:
            log.warning("could not delete stale profile %r: %s", name, err.strip())

    # ---- 2. Build the fresh profile ----
    add_args = [
        "nmcli", "connection", "add",
        "type", "wifi",
        "con-name", ssid,
        "ifname", iface,
        "ssid", ssid,
    ]
    if hidden:
        add_args += ["802-11-wireless.hidden", "yes"]
    if password:
        if len(password) < 8 or len(password) > 63:
            # nmcli would reject this anyway; bail early with a clear msg.
            raise WifiError("Password is invalid (8–63 characters required for WPA-PSK).")
        add_args += [
            "wifi-sec.key-mgmt", "wpa-psk",
            "wifi-sec.psk", password,
        ]

    # Log the redacted command — never log the password.
    log.info(
        "wifi.connect: nmcli add: %s",
        " ".join(a if a != password else "<redacted>" for a in add_args),
    )
    rc, out, err = await _run(*add_args, timeout=15.0)
    if rc != 0:
        raw = (err or out).strip()
        log.warning("wifi.connect: add failed rc=%d: %s", rc, raw)
        raise WifiError(_translate_nmcli_error(raw))

    # ---- 3. Belt-and-braces: verify key-mgmt actually got set ----
    if password:
        rc, out, _ = await _run(
            "nmcli", "-t", "-g", "802-11-wireless-security.key-mgmt",
            "connection", "show", ssid,
            timeout=5.0,
        )
        got = out.strip() if rc == 0 else ""
        if got != "wpa-psk":
            log.warning("wifi.connect: key-mgmt not set after add (got %r), forcing it", got)
            await _run(
                "nmcli", "connection", "modify", ssid,
                "wifi-sec.key-mgmt", "wpa-psk",
                "wifi-sec.psk", password,
                timeout=5.0,
            )

    # ---- 4. Activate ----
    log.info("wifi.connect: bringing profile up")
    rc, out, err = await _run("nmcli", "connection", "up", ssid, timeout=60.0)
    if rc != 0:
        raw = (err or out).strip()
        log.warning("wifi.connect: up failed rc=%d: %s", rc, raw)
        raise WifiError(_translate_nmcli_error(raw))

    log.info("wifi.connect: success")


async def disconnect() -> None:
    iface = await get_wifi_iface()
    rc, _, err = await _run("nmcli", "device", "disconnect", iface)
    if rc != 0:
        raise WifiError(err.strip() or f"exit {rc}")


async def status() -> dict[str, Any]:
    """Return current WiFi state as a dict."""
    iface = await get_wifi_iface()
    rc, out, _ = await _run(
        "nmcli", "-t", "-f", "GENERAL.STATE,GENERAL.CONNECTION,IP4.ADDRESS",
        "device", "show", iface,
    )
    state = ""
    connection = ""
    ip = ""
    if rc == 0:
        for line in out.splitlines():
            if ":" not in line:
                continue
            key, _, value = line.partition(":")
            if key == "GENERAL.STATE":
                state = value
            elif key == "GENERAL.CONNECTION":
                connection = value if value != "--" else ""
            elif key.startswith("IP4.ADDRESS") and not ip:
                # "192.168.1.5/24" -> "192.168.1.5"
                ip = re.split(r"/", value, maxsplit=1)[0]
    connected = "100 (connected)" in state or state.startswith("100")
    return {
        "iface": iface,
        "connected": connected,
        "ssid": connection,
        "ip": ip,
        "state": state,
    }
