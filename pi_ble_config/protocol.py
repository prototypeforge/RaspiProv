"""BLE service / characteristic UUIDs and small (de)serialization helpers.

Layout of the GATT service exposed by this agent:

    Service: SERVICE_UUID
      |
      +-- CHAR_WIFI_SCAN_UUID     read, notify     JSON list of networks
      +-- CHAR_WIFI_CONNECT_UUID  write            JSON {"ssid","password"}
      +-- CHAR_WIFI_STATUS_UUID   read, notify     JSON status object
      +-- CHAR_SSH_UUID           read, write      1 byte: 0=off, 1=on
      +-- CHAR_IP_UUID            read, notify     UTF-8 string
      +-- CHAR_RESULT_UUID        notify           JSON {"op","ok","msg"}

All JSON payloads are UTF-8 encoded. Writes that exceed the default ATT MTU
(23 bytes => 20 payload bytes) are received in chunks by BlueZ and assembled
before the WriteValue method is invoked, so callers can send full JSON in
one logical write provided the central negotiates a larger MTU (most do).
"""
from __future__ import annotations

import json
from typing import Any

# 128-bit UUIDs. Custom vendor-style block, no conflict with assigned numbers.
SERVICE_UUID         = "6f3a0001-9a2b-4f3e-8d1c-1a2b3c4d5e6f"
CHAR_WIFI_SCAN_UUID  = "6f3a0002-9a2b-4f3e-8d1c-1a2b3c4d5e6f"
CHAR_WIFI_CONNECT_UUID = "6f3a0003-9a2b-4f3e-8d1c-1a2b3c4d5e6f"
CHAR_WIFI_STATUS_UUID = "6f3a0004-9a2b-4f3e-8d1c-1a2b3c4d5e6f"
CHAR_SSH_UUID        = "6f3a0005-9a2b-4f3e-8d1c-1a2b3c4d5e6f"
CHAR_IP_UUID         = "6f3a0006-9a2b-4f3e-8d1c-1a2b3c4d5e6f"
CHAR_RESULT_UUID     = "6f3a0007-9a2b-4f3e-8d1c-1a2b3c4d5e6f"


def encode_json(obj: Any) -> bytes:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def decode_json(data: bytes) -> Any:
    return json.loads(bytes(data).decode("utf-8"))


def result_payload(op: str, ok: bool, msg: str = "") -> bytes:
    return encode_json({"op": op, "ok": bool(ok), "msg": msg})
