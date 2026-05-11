"""BLE GATT peripheral built on BlueZ + dbus-next.

BlueZ exposes its GATT API over D-Bus. To act as a peripheral we register
three things on the system bus:

  1. A ``GattService1`` object plus one ``GattCharacteristic1`` object per
     characteristic, all exported under a common root path.
  2. An ``LEAdvertisement1`` object so peer devices can discover us.
  3. An ``ObjectManager`` at the root path implementing
     ``org.freedesktop.DBus.ObjectManager`` so BlueZ can enumerate (1).

The shape of these interfaces is set by BlueZ's ``doc/gatt-api.txt`` and
``doc/advertising-api.txt`` — we mirror them.

Characteristic handlers are plain async callables passed in by the caller;
this module knows nothing about WiFi or SSH. Notifications are pushed by
calling :py:meth:`Characteristic.update_value`, which emits a
``PropertiesChanged`` signal on the ``Value`` property — clients that
subscribed via ``StartNotify`` receive it as a GATT notification.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Awaitable, Callable

from dbus_next import BusType, Variant
from dbus_next.aio import MessageBus
from dbus_next.constants import PropertyAccess
from dbus_next.service import ServiceInterface, dbus_property, method, signal

from .agent import register_agent, unregister_agent


log = logging.getLogger(__name__)


BLUEZ_BUS                  = "org.bluez"
BLUEZ_ADAPTER_IFACE        = "org.bluez.Adapter1"
BLUEZ_GATT_MANAGER_IFACE   = "org.bluez.GattManager1"
BLUEZ_LE_AD_MANAGER_IFACE  = "org.bluez.LEAdvertisingManager1"
DBUS_OM_IFACE              = "org.freedesktop.DBus.ObjectManager"
DBUS_PROP_IFACE            = "org.freedesktop.DBus.Properties"

ROOT_PATH = "/com/bluetoothprov"


ReadHandler  = Callable[[], Awaitable[bytes]]
WriteHandler = Callable[[bytes], Awaitable[None]]


# --------------------------------------------------------------------------- #
# GATT objects                                                                #
# --------------------------------------------------------------------------- #


class Service(ServiceInterface):
    """Implements ``org.bluez.GattService1``."""

    def __init__(self, path: str, uuid: str, primary: bool = True):
        super().__init__("org.bluez.GattService1")
        self.path = path
        self._uuid = uuid
        self._primary = primary
        self.characteristics: list["Characteristic"] = []

    @dbus_property(access=PropertyAccess.READ)
    def UUID(self) -> "s":  # type: ignore[name-defined]   # noqa: F722
        return self._uuid

    @dbus_property(access=PropertyAccess.READ)
    def Primary(self) -> "b":  # type: ignore[name-defined]   # noqa: F722
        return self._primary

    def properties_for_om(self) -> dict[str, dict[str, Variant]]:
        return {
            "org.bluez.GattService1": {
                "UUID": Variant("s", self._uuid),
                "Primary": Variant("b", self._primary),
            }
        }


class Characteristic(ServiceInterface):
    """Implements ``org.bluez.GattCharacteristic1``.

    ``flags`` is a list such as ``["read", "write", "notify"]``. Provide a
    ``read_fn`` if "read" is in flags; a ``write_fn`` if "write" is in flags.
    Notifications are pushed by calling :py:meth:`update_value`.
    """

    def __init__(
        self,
        path: str,
        uuid: str,
        service: Service,
        flags: list[str],
        read_fn: ReadHandler | None = None,
        write_fn: WriteHandler | None = None,
    ):
        super().__init__("org.bluez.GattCharacteristic1")
        self.path = path
        self._uuid = uuid
        self._service = service
        self._flags = flags
        self._read_fn = read_fn
        self._write_fn = write_fn
        self._value: bytes = b""
        self._notifying = False
        service.characteristics.append(self)

    @dbus_property(access=PropertyAccess.READ)
    def UUID(self) -> "s":  # noqa: F722
        return self._uuid

    @dbus_property(access=PropertyAccess.READ)
    def Service(self) -> "o":  # noqa: F722
        return self._service.path

    @dbus_property(access=PropertyAccess.READ)
    def Flags(self) -> "as":  # noqa: F722
        return list(self._flags)

    @dbus_property(access=PropertyAccess.READ)
    def Notifying(self) -> "b":  # noqa: F722
        return self._notifying

    @dbus_property(access=PropertyAccess.READ)
    def Value(self) -> "ay":  # noqa: F722
        # dbus-next requires Python ``bytes`` for the ``ay`` signature; a
        # ``list[int]`` here raises SignatureBodyMismatchError when BlueZ
        # introspects the characteristic via ObjectManager.
        return self._value

    @method()
    async def ReadValue(self, options: "a{sv}") -> "ay":  # noqa: F722
        if self._read_fn is None:
            return self._value
        try:
            data = await self._read_fn()
        except Exception:
            log.exception("ReadValue handler failed for %s", self._uuid)
            raise
        self._value = bytes(data)
        return self._value

    @method()
    async def WriteValue(self, value: "ay", options: "a{sv}"):  # noqa: F722
        # dbus-next may hand us ``bytes`` or ``list[int]`` depending on
        # version; normalise to bytes for our handlers.
        data = bytes(value)
        self._value = data
        if self._write_fn is None:
            return
        try:
            await self._write_fn(data)
        except Exception as exc:
            log.exception("WriteValue handler failed for %s", self._uuid)
            raise

    @method()
    def StartNotify(self):
        if "notify" not in self._flags and "indicate" not in self._flags:
            raise RuntimeError("characteristic does not support notify")
        self._notifying = True
        log.debug("notify started: %s", self._uuid)

    @method()
    def StopNotify(self):
        self._notifying = False
        log.debug("notify stopped: %s", self._uuid)

    def update_value(self, data: bytes) -> None:
        """Set value and (if subscribed) push a notification."""
        self._value = bytes(data)
        # Always emit PropertiesChanged on Value — BlueZ relays this to
        # any subscribed central as a GATT notification.
        # The ``ay`` signature requires ``bytes`` (not list[int]).
        self.emit_properties_changed(
            changed_properties={"Value": self._value},
        )

    def properties_for_om(self) -> dict[str, dict[str, Variant]]:
        return {
            "org.bluez.GattCharacteristic1": {
                "UUID": Variant("s", self._uuid),
                "Service": Variant("o", self._service.path),
                "Flags": Variant("as", list(self._flags)),
                "Notifying": Variant("b", self._notifying),
            }
        }


class Advertisement(ServiceInterface):
    """Implements ``org.bluez.LEAdvertisement1``."""

    def __init__(self, path: str, local_name: str, service_uuids: list[str]):
        super().__init__("org.bluez.LEAdvertisement1")
        self.path = path
        self._local_name = local_name
        self._service_uuids = service_uuids

    @dbus_property(access=PropertyAccess.READ)
    def Type(self) -> "s":  # noqa: F722
        return "peripheral"

    @dbus_property(access=PropertyAccess.READ)
    def ServiceUUIDs(self) -> "as":  # noqa: F722
        return list(self._service_uuids)

    @dbus_property(access=PropertyAccess.READ)
    def LocalName(self) -> "s":  # noqa: F722
        return self._local_name

    @dbus_property(access=PropertyAccess.READ)
    def IncludeTxPower(self) -> "b":  # noqa: F722
        return True

    @method()
    def Release(self):
        log.info("advertisement released by BlueZ")


# --------------------------------------------------------------------------- #
# ObjectManager root                                                          #
# --------------------------------------------------------------------------- #


class GattRoot(ServiceInterface):
    """``org.freedesktop.DBus.ObjectManager`` exposing service + chars.

    BlueZ calls ``GetManagedObjects`` on the application root path when
    we register the application — it's how it discovers the hierarchy.
    """

    def __init__(self, service: Service):
        super().__init__(DBUS_OM_IFACE)
        self._service = service

    @method()
    def GetManagedObjects(self) -> "a{oa{sa{sv}}}":  # noqa: F722
        objs: dict[str, dict[str, dict[str, Variant]]] = {}
        objs[self._service.path] = self._service.properties_for_om()
        for ch in self._service.characteristics:
            objs[ch.path] = ch.properties_for_om()
        return objs

    @signal()
    def InterfacesAdded(self) -> "oa{sa{sv}}":  # noqa: F722
        ...

    @signal()
    def InterfacesRemoved(self) -> "oas":  # noqa: F722
        ...


# --------------------------------------------------------------------------- #
# Top-level peripheral                                                        #
# --------------------------------------------------------------------------- #


class Peripheral:
    """Owns the bus connection, the GATT objects, and the advertisement."""

    def __init__(self, service_uuid: str, local_name: str):
        self._service_uuid = service_uuid
        self._local_name = local_name
        self._bus: MessageBus | None = None
        self._adapter_path: str | None = None
        self.service: Service | None = None
        self._root: GattRoot | None = None
        self._adv: Advertisement | None = None
        self._chars: dict[str, Characteristic] = {}

    # ----- setup ----- #

    async def connect_bus(self) -> None:
        self._bus = await MessageBus(bus_type=BusType.SYSTEM).connect()

    async def _find_adapter(self) -> str:
        """Locate the first object exposing both GattManager1 and
        LEAdvertisingManager1 — that's our usable BLE adapter."""
        assert self._bus is not None
        introspection = await self._bus.introspect(BLUEZ_BUS, "/")
        root = self._bus.get_proxy_object(BLUEZ_BUS, "/", introspection)
        om = root.get_interface(DBUS_OM_IFACE)
        objects = await om.call_get_managed_objects()
        for path, ifaces in objects.items():
            if BLUEZ_GATT_MANAGER_IFACE in ifaces and BLUEZ_LE_AD_MANAGER_IFACE in ifaces:
                return path
        raise RuntimeError("no BlueZ adapter with GATT + LE advertising found")

    async def _set_adapter_alias(self, alias: str) -> None:
        """Set ``Adapter1.Alias`` so the GAP Device Name characteristic
        also reflects our chosen identifier.

        We already put the same string in the LE Advertisement's
        ``LocalName`` field, but with a 128-bit service UUID in the
        primary advertising packet the local name has to spill into
        the scan response — and some central stacks don't capture
        scan-response data at chooser time. Setting Alias means any
        client that connects will be able to read the GAP Device Name
        characteristic (0x2A00) and see the right name regardless.
        """
        if not (self._bus and self._adapter_path):
            return
        try:
            intro = await self._bus.introspect(BLUEZ_BUS, self._adapter_path)
            obj = self._bus.get_proxy_object(BLUEZ_BUS, self._adapter_path, intro)
            props = obj.get_interface(DBUS_PROP_IFACE)
            await props.call_set(BLUEZ_ADAPTER_IFACE, "Alias", Variant("s", alias))
            log.info("adapter alias set to %r", alias)
        except Exception as exc:
            log.warning("could not set adapter alias: %s", exc)

    async def _power_on_adapter(self) -> None:
        """Ensure the adapter is Powered=true, with a short retry loop.

        ``RegisterAdvertisement`` is rejected by BlueZ on an unpowered
        adapter, so we fail loudly here with a hint about rfkill rather
        than let the user puzzle out an opaque "Failed to register
        advertisement" later.
        """
        assert self._bus is not None and self._adapter_path is not None
        intro = await self._bus.introspect(BLUEZ_BUS, self._adapter_path)
        obj = self._bus.get_proxy_object(BLUEZ_BUS, self._adapter_path, intro)
        props = obj.get_interface(DBUS_PROP_IFACE)

        async def _powered() -> bool:
            v = await props.call_get(BLUEZ_ADAPTER_IFACE, "Powered")
            return bool(v.value)

        if await _powered():
            log.info("adapter already powered")
            return

        last_err: Exception | None = None
        for attempt in range(1, 6):
            try:
                await props.call_set(BLUEZ_ADAPTER_IFACE, "Powered", Variant("b", True))
            except Exception as exc:
                last_err = exc
                log.warning("Powered=true attempt %d failed: %s", attempt, exc)
            # Setting Powered may complete asynchronously; poll briefly.
            for _ in range(10):
                if await _powered():
                    log.info("adapter powered on (attempt %d)", attempt)
                    return
                await asyncio.sleep(0.2)

        raise RuntimeError(
            "could not power on the Bluetooth adapter. "
            "Most likely it is rfkill-blocked. Try: "
            "`sudo rfkill unblock bluetooth && sudo systemctl restart bluetooth`. "
            f"Last error: {last_err!r}"
        )

    def build_service(self) -> Service:
        self.service = Service(f"{ROOT_PATH}/service0", self._service_uuid, primary=True)
        return self.service

    def add_characteristic(
        self,
        uuid: str,
        flags: list[str],
        read_fn: ReadHandler | None = None,
        write_fn: WriteHandler | None = None,
    ) -> Characteristic:
        assert self.service is not None, "call build_service() first"
        idx = len(self._chars)
        path = f"{self.service.path}/char{idx}"
        ch = Characteristic(path, uuid, self.service, flags, read_fn, write_fn)
        self._chars[uuid] = ch
        return ch

    def characteristic(self, uuid: str) -> Characteristic:
        return self._chars[uuid]

    # ----- run ----- #

    async def register(self) -> None:
        """Export D-Bus objects and tell BlueZ about them."""
        assert self._bus is not None and self.service is not None

        self._adapter_path = await self._find_adapter()
        log.info("using adapter %s", self._adapter_path)
        await self._power_on_adapter()
        await self._set_adapter_alias(self._local_name)

        # Register a Just-Works pairing agent before we start advertising.
        # Without this, BlueZ has no way to answer pairing prompts from
        # centrals, and connections drop ~1s in with "Request canceled".
        await register_agent(self._bus)

        # Export every object on the bus.
        self._root = GattRoot(self.service)
        self._bus.export(ROOT_PATH, self._root)
        self._bus.export(self.service.path, self.service)
        for ch in self.service.characteristics:
            self._bus.export(ch.path, ch)

        self._adv = Advertisement(
            f"{ROOT_PATH}/adv0",
            self._local_name,
            [self._service_uuid],
        )
        self._bus.export(self._adv.path, self._adv)

        # Register GATT application.
        intro = await self._bus.introspect(BLUEZ_BUS, self._adapter_path)
        adapter_obj = self._bus.get_proxy_object(BLUEZ_BUS, self._adapter_path, intro)
        gatt_mgr = adapter_obj.get_interface(BLUEZ_GATT_MANAGER_IFACE)
        await gatt_mgr.call_register_application(ROOT_PATH, {})
        log.info("GATT application registered at %s", ROOT_PATH)

        # Register advertisement.
        ad_mgr = adapter_obj.get_interface(BLUEZ_LE_AD_MANAGER_IFACE)
        await ad_mgr.call_register_advertisement(self._adv.path, {})
        log.info("advertising as %r", self._local_name)

    async def unregister(self) -> None:
        if self._bus is None or self._adapter_path is None:
            return
        try:
            intro = await self._bus.introspect(BLUEZ_BUS, self._adapter_path)
            adapter_obj = self._bus.get_proxy_object(BLUEZ_BUS, self._adapter_path, intro)
            if self._adv is not None:
                ad_mgr = adapter_obj.get_interface(BLUEZ_LE_AD_MANAGER_IFACE)
                await ad_mgr.call_unregister_advertisement(self._adv.path)
            gatt_mgr = adapter_obj.get_interface(BLUEZ_GATT_MANAGER_IFACE)
            await gatt_mgr.call_unregister_application(ROOT_PATH)
        except Exception as exc:
            log.warning("teardown error (ignored): %s", exc)
        await unregister_agent(self._bus)

    async def close(self) -> None:
        await self.unregister()
        if self._bus is not None:
            self._bus.disconnect()
