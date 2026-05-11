"""BlueZ pairing agent — auto-accept Just-Works pairing.

Without an agent registered against ``org.bluez.AgentManager1``, BlueZ
has no way to answer pairing prompts coming from a central. Modern
BlueZ (5.66+) and modern Linux kernels initiate a brief pairing dance
even for "unencrypted" GATT access in some configurations — most
visibly, when the central uses LE Privacy / Resolvable Private
Addresses, or when it has a stale bond for our public address.

If no agent is present, that pairing dance has nobody to confirm to and
the central tears the link down a second or two after connect. This is
the failure mode the user was seeing: ``Request confirmation`` in
``bluetoothctl`` followed by ``Request canceled`` followed by
``disconnected``.

We register a ``NoInputNoOutput`` agent that silently accepts every
decision. This is the right model for a headless provisioning device:
zero-friction onboarding, no PIN to type, no display to read.
"""
from __future__ import annotations

import logging

from dbus_next.aio import MessageBus
from dbus_next.service import ServiceInterface, method


log = logging.getLogger(__name__)


BLUEZ_BUS                  = "org.bluez"
BLUEZ_AGENT_MANAGER_PATH   = "/org/bluez"
BLUEZ_AGENT_MANAGER_IFACE  = "org.bluez.AgentManager1"
AGENT_PATH                 = "/com/bluetoothprov/agent"


class Agent(ServiceInterface):
    """Implements ``org.bluez.Agent1``.

    For ``NoInputNoOutput`` capability, BlueZ should only ever call
    ``AuthorizeService``, ``RequestAuthorization``, ``Cancel`` and
    ``Release``. The other methods are present because the interface
    requires them; they return safe defaults if BlueZ ever does invoke
    them (e.g. against a buggy central that requests a passkey
    despite our advertised capability).
    """

    def __init__(self) -> None:
        super().__init__("org.bluez.Agent1")

    @method()
    def Release(self):
        log.info("agent released by BlueZ")

    @method()
    def RequestPinCode(self, device: "o") -> "s":  # noqa: F722
        log.info("RequestPinCode %s (returning '0000')", device)
        return "0000"

    @method()
    def DisplayPinCode(self, device: "o", pincode: "s"):  # noqa: F722
        log.info("DisplayPinCode %s pin=%s", device, pincode)

    @method()
    def RequestPasskey(self, device: "o") -> "u":  # noqa: F722
        log.info("RequestPasskey %s (returning 0)", device)
        return 0

    @method()
    def DisplayPasskey(self, device: "o", passkey: "u", entered: "q"):  # noqa: F722
        log.info("DisplayPasskey %s passkey=%06d entered=%d", device, passkey, entered)

    @method()
    def RequestConfirmation(self, device: "o", passkey: "u"):  # noqa: F722
        # Just Works numeric-comparison: simply accept.
        log.info("RequestConfirmation %s passkey=%06d (auto-accept)", device, passkey)

    @method()
    def RequestAuthorization(self, device: "o"):  # noqa: F722
        log.info("RequestAuthorization %s (auto-accept)", device)

    @method()
    def AuthorizeService(self, device: "o", uuid: "s"):  # noqa: F722
        log.info("AuthorizeService %s uuid=%s (auto-accept)", device, uuid)

    @method()
    def Cancel(self):
        log.info("agent cancel")


async def register_agent(
    bus: MessageBus,
    capability: str = "NoInputNoOutput",
) -> Agent:
    """Export the agent on the bus and register it as the default agent."""
    agent = Agent()
    bus.export(AGENT_PATH, agent)

    intro = await bus.introspect(BLUEZ_BUS, BLUEZ_AGENT_MANAGER_PATH)
    obj = bus.get_proxy_object(BLUEZ_BUS, BLUEZ_AGENT_MANAGER_PATH, intro)
    mgr = obj.get_interface(BLUEZ_AGENT_MANAGER_IFACE)

    await mgr.call_register_agent(AGENT_PATH, capability)
    log.info("agent registered at %s (capability=%s)", AGENT_PATH, capability)

    try:
        await mgr.call_request_default_agent(AGENT_PATH)
        log.info("agent set as system default")
    except Exception as exc:
        # Not fatal — another tool (e.g. an interactive bluetoothctl
        # session) may already hold the default-agent slot. Our agent is
        # still registered and BlueZ will route pairings for our device
        # to it.
        log.warning("could not become default agent (continuing): %s", exc)

    return agent


async def unregister_agent(bus: MessageBus) -> None:
    try:
        intro = await bus.introspect(BLUEZ_BUS, BLUEZ_AGENT_MANAGER_PATH)
        obj = bus.get_proxy_object(BLUEZ_BUS, BLUEZ_AGENT_MANAGER_PATH, intro)
        mgr = obj.get_interface(BLUEZ_AGENT_MANAGER_IFACE)
        await mgr.call_unregister_agent(AGENT_PATH)
        log.info("agent unregistered")
    except Exception as exc:
        log.debug("agent unregister error (ignored): %s", exc)
