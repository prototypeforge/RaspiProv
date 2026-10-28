// Native BLE transport for the Android app.
//
// Implements the transport contract documented at the top of
// web/ble.js on top of @capacitor-community/bluetooth-le, so the
// unchanged PiBleClient / app.js drive the phone's BLE radio instead
// of Web Bluetooth (which Android's WebView does not expose).
//
// Everything here is local to the phone: the plugin talks to the OS
// Bluetooth stack, no network is involved.

import { BleClient } from "@capacitor-community/bluetooth-le";
import { Capacitor } from "@capacitor/core";
import { log } from "../../web/logger.js";
import { viewToBytes } from "../../web/ble.js";

export class CapacitorBleTransport {
    constructor() {
        this.name = "capacitor-ble";
        this.deviceId = null;
        this.serviceUuid = null;
        /** @type {Map<string, object>} uuid -> characteristic properties */
        this.chars = new Map();
        this._connected = false;
        this._initialized = false;
    }

    get available() {
        return Capacitor.isNativePlatform();
    }

    get unavailableReason() {
        return "Native Bluetooth bridge not available (not running inside the app).";
    }

    get warnings() {
        return [];
    }

    get connected() {
        return this._connected;
    }

    async _init() {
        if (this._initialized) return;
        // initialize() asks for the runtime permissions the OS needs
        // (Nearby devices on Android 12+, Location on older versions).
        // androidNeverForLocation pairs with the manifest's
        // usesPermissionFlags="neverForLocation" so Android 12+ never
        // asks for Location at all.
        await BleClient.initialize({ androidNeverForLocation: true });
        this._initialized = true;
        log.debug("capacitor-ble: initialized");
    }

    async requestDevice(serviceUuid) {
        await this._init();
        this.serviceUuid = serviceUuid;

        // If the radio is off, ask the user to turn it on (Android shows
        // the system dialog). Failing that, let requestDevice report it.
        try {
            const { value: enabled } = await BleClient.isEnabled();
            if (!enabled) {
                log.info("capacitor-ble: Bluetooth is off, asking to enable");
                await BleClient.requestEnable();
            }
        } catch (err) {
            log.warn("capacitor-ble: requestEnable failed", err);
        }

        // Native chooser, filtered on our service UUID like the web
        // version's requestDevice() filter.
        const dev = await BleClient.requestDevice({
            services: [serviceUuid],
            optionalServices: [serviceUuid],
        });
        this.deviceId = dev.deviceId;
        return { id: dev.deviceId, name: dev.name || "" };
    }

    async connect(onDisconnected) {
        if (!this.deviceId) throw new Error("no device chosen — call requestDevice() first");
        await BleClient.connect(this.deviceId, () => {
            log.warn("capacitor-ble: peripheral disconnected");
            this._connected = false;
            this.chars.clear();
            if (onDisconnected) onDisconnected();
        }, { timeout: 15000 });
        this._connected = true;

        // The plugin negotiates MTU 512 on Android right after connect;
        // the firmware's JSON frames rely on that (default 23 would
        // truncate every notification to 20 bytes). Log what we got.
        try {
            const { value: mtu } = await BleClient.getMtu(this.deviceId);
            log.info(`capacitor-ble: MTU ${mtu}`);
            if (mtu > 0 && mtu < 100) {
                log.warn(`capacitor-ble: MTU ${mtu} is small — long frames may be truncated`);
            }
        } catch { /* not supported on this platform, ignore */ }
    }

    async discover(serviceUuid, charUuids) {
        const services = await BleClient.getServices(this.deviceId);
        const want = serviceUuid.toLowerCase();
        const svc = services.find(s => s.uuid.toLowerCase() === want);
        if (!svc) throw new Error(`service ${serviceUuid} not found on device`);

        this.chars.clear();
        const found = new Map();
        for (const uuid of charUuids) {
            const ch = svc.characteristics.find(c => c.uuid.toLowerCase() === uuid.toLowerCase());
            if (!ch) throw new Error(`characteristic ${uuid} not found on device`);
            const props = {
                read:                 !!ch.properties.read,
                write:                !!ch.properties.write,
                writeWithoutResponse: !!ch.properties.writeWithoutResponse,
                notify:               !!ch.properties.notify,
                indicate:             !!ch.properties.indicate,
            };
            this.chars.set(uuid, props);
            found.set(uuid, props);
        }
        return found;
    }

    _require(uuid) {
        if (!this._connected) throw new Error("not connected");
        if (!this.chars.has(uuid)) throw new Error(`characteristic not available: ${uuid}`);
    }

    async read(uuid) {
        this._require(uuid);
        const view = await BleClient.read(this.deviceId, this.serviceUuid, uuid, { timeout: 10000 });
        return viewToBytes(view);
    }

    async write(uuid, bytes, { withResponse = true } = {}) {
        this._require(uuid);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (withResponse) {
            await BleClient.write(this.deviceId, this.serviceUuid, uuid, view, { timeout: 10000 });
        } else {
            await BleClient.writeWithoutResponse(this.deviceId, this.serviceUuid, uuid, view, { timeout: 10000 });
        }
    }

    async startNotifications(uuid, onBytes) {
        this._require(uuid);
        await BleClient.startNotifications(
            this.deviceId, this.serviceUuid, uuid,
            (view) => onBytes(viewToBytes(view)),
            { timeout: 10000 },
        );
    }

    async disconnect() {
        const id = this.deviceId;
        const wasConnected = this._connected;
        this._connected = false;
        this.chars.clear();
        if (id && wasConnected) {
            try { await BleClient.disconnect(id); }
            catch (err) { log.debug("capacitor-ble: disconnect threw", err); }
        }
    }
}
