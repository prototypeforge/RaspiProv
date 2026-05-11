"""pi_ble_config: BLE headless provisioning agent for Raspberry Pi."""

__version__ = "0.1.0"

from .protocol import (
    SERVICE_UUID,
    CHAR_WIFI_SCAN_UUID,
    CHAR_WIFI_CONNECT_UUID,
    CHAR_WIFI_STATUS_UUID,
    CHAR_SSH_UUID,
    CHAR_IP_UUID,
    CHAR_RESULT_UUID,
)

__all__ = [
    "__version__",
    "SERVICE_UUID",
    "CHAR_WIFI_SCAN_UUID",
    "CHAR_WIFI_CONNECT_UUID",
    "CHAR_WIFI_STATUS_UUID",
    "CHAR_SSH_UUID",
    "CHAR_IP_UUID",
    "CHAR_RESULT_UUID",
]
