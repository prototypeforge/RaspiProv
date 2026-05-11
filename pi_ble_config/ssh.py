"""Enable/disable the OpenSSH daemon via systemd."""
from __future__ import annotations

import asyncio


SERVICE = "ssh"   # Raspberry Pi OS / Debian unit name. Some images use "sshd".


class SshError(RuntimeError):
    pass


async def _systemctl(*args: str) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        "systemctl", *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate()
    return proc.returncode or 0, out.decode().strip(), err.decode().strip()


async def _resolve_unit() -> str:
    # Try "ssh" first, fall back to "sshd".
    for name in (SERVICE, "sshd"):
        rc, _, _ = await _systemctl("cat", name)
        if rc == 0:
            return name
    return SERVICE


async def is_enabled() -> bool:
    unit = await _resolve_unit()
    rc, _, _ = await _systemctl("is-active", unit)
    return rc == 0


async def set_enabled(enabled: bool) -> None:
    unit = await _resolve_unit()
    if enabled:
        rc1, _, e1 = await _systemctl("enable", unit)
        rc2, _, e2 = await _systemctl("start", unit)
        if rc1 != 0 or rc2 != 0:
            raise SshError((e1 + " " + e2).strip() or "failed to enable ssh")
    else:
        rc1, _, e1 = await _systemctl("stop", unit)
        rc2, _, e2 = await _systemctl("disable", unit)
        if rc1 != 0 or rc2 != 0:
            raise SshError((e1 + " " + e2).strip() or "failed to disable ssh")
