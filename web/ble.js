// BLE client for the pi_ble_config GATT service.
//
// Mirrors the layout defined in pi_ble_config/protocol.py — keep the UUIDs
// here in sync with that file. All operations are logged at debug/info
// level via ./logger.js so the user can see exactly what is happening over
// the air.
//
// The client talks to the radio through a small *transport* interface so
// the same protocol code runs in two places:
//
//   * the browser, via Web Bluetooth  (WebBluetoothTransport, the default)
//   * the Android app, via a native BLE plugin (see app/src/capacitor-transport.js)
//
// Transport contract (all async unless noted):
//
//   name                               string  — for logs ("web-bluetooth", ...)
//   available                          boolean — can this transport work here at all?
//   unavailableReason                  string  — human-readable, when !available
//   warnings                           string[] — non-fatal environment caveats
//   connected                          boolean (sync getter)
//   requestDevice(serviceUuid)         → {id, name}   show the device picker
//   connect(onDisconnected)            → void         GATT connect to the chosen device
//   discover(serviceUuid, charUuids)   → Map<uuid, {read,write,writeWithoutResponse,notify,indicate}>
//                                        throws if any characteristic is missing
//   read(uuid)                         → Uint8Array
//   write(uuid, bytes, {withResponse}) → void
//   startNotifications(uuid, onBytes)  → void   at most once per characteristic
//                                               per connection; PiBleClient fans out
//   disconnect()                       → void   safe to call when not connected
//
// Transports never log payloads — PiBleClient does, so it can redact.

import { log } from "./logger.js";

export const SERVICE_UUID         = "6f3a0001-9a2b-4f3e-8d1c-1a2b3c4d5e6f";
export const CHAR_WIFI_SCAN_UUID  = "6f3a0002-9a2b-4f3e-8d1c-1a2b3c4d5e6f";
export const CHAR_WIFI_CONNECT_UUID = "6f3a0003-9a2b-4f3e-8d1c-1a2b3c4d5e6f";
export const CHAR_WIFI_STATUS_UUID = "6f3a0004-9a2b-4f3e-8d1c-1a2b3c4d5e6f";
export const CHAR_SSH_UUID        = "6f3a0005-9a2b-4f3e-8d1c-1a2b3c4d5e6f";
export const CHAR_IP_UUID         = "6f3a0006-9a2b-4f3e-8d1c-1a2b3c4d5e6f";
export const CHAR_RESULT_UUID     = "6f3a0007-9a2b-4f3e-8d1c-1a2b3c4d5e6f";

const ALL_CHAR_UUIDS = [
    CHAR_WIFI_SCAN_UUID, CHAR_WIFI_CONNECT_UUID, CHAR_WIFI_STATUS_UUID,
    CHAR_SSH_UUID, CHAR_IP_UUID, CHAR_RESULT_UUID,
];

const decoder = new TextDecoder("utf-8");
const encoder = new TextEncoder();


// ---------- Web Bluetooth transport (browser default) ---------- #

export class WebBluetoothTransport {
    constructor() {
        this.name = "web-bluetooth";
        /** @type {BluetoothDevice|null} */ this.device = null;
        /** @type {BluetoothRemoteGATTServer|null} */ this.server = null;
        /** @type {BluetoothRemoteGATTService|null} */ this.service = null;
        /** @type {Map<string, BluetoothRemoteGATTCharacteristic>} */
        this.chars = new Map();
        this._onDisconnected = null;
    }

    get available() {
        return typeof navigator !== "undefined" && "bluetooth" in navigator;
    }

    get unavailableReason() {
        return "Web Bluetooth not available. Use Chrome/Edge over HTTPS or localhost.";
    }

    get warnings() {
        const w = [];
        if (typeof window !== "undefined" && !window.isSecureContext) {
            w.push("Insecure context — Web Bluetooth requires HTTPS or localhost");
        }
        return w;
    }

    get connected() {
        return !!(this.server && this.server.connected);
    }

    async requestDevice(serviceUuid) {
        if (!this.available) throw new Error(this.unavailableReason);
        const device = await navigator.bluetooth.requestDevice({
            filters: [{ services: [serviceUuid] }],
            optionalServices: [serviceUuid],
        });
        device.addEventListener("gattserverdisconnected", () => {
            log.warn("gattserverdisconnected");
            if (this._onDisconnected) this._onDisconnected();
        });
        this.device = device;
        return { id: device.id, name: device.name || "" };
    }

    async connect(onDisconnected) {
        if (!this.device) throw new Error("no device chosen — call requestDevice() first");
        this._onDisconnected = onDisconnected;
        this.server = await this.device.gatt.connect();
    }

    async discover(serviceUuid, charUuids) {
        this.service = await this.server.getPrimaryService(serviceUuid);
        const found = new Map();
        for (const uuid of charUuids) {
            const ch = await this.service.getCharacteristic(uuid);   // throws if missing
            this.chars.set(uuid, ch);
            found.set(uuid, {
                read:                 !!ch.properties.read,
                write:                !!ch.properties.write,
                writeWithoutResponse: !!ch.properties.writeWithoutResponse,
                notify:               !!ch.properties.notify,
                indicate:             !!ch.properties.indicate,
            });
        }
        return found;
    }

    _char(uuid) {
        const ch = this.chars.get(uuid);
        if (!ch) throw new Error(`characteristic not available: ${uuid}`);
        return ch;
    }

    async read(uuid) {
        const view = await this._char(uuid).readValue();
        return viewToBytes(view);
    }

    async write(uuid, bytes, { withResponse = true } = {}) {
        const ch = this._char(uuid);
        if (withResponse && ch.writeValueWithResponse) {
            await ch.writeValueWithResponse(bytes);
        } else if (!withResponse && ch.writeValueWithoutResponse) {
            await ch.writeValueWithoutResponse(bytes);
        } else {
            // Older Web Bluetooth implementations.
            await ch.writeValue(bytes);
        }
    }

    async startNotifications(uuid, onBytes) {
        const ch = this._char(uuid);
        ch.addEventListener("characteristicvaluechanged", (ev) => {
            onBytes(viewToBytes(ev.target.value));
        });
        await ch.startNotifications();
    }

    async disconnect() {
        this.chars.clear();
        this.service = null;
        const server = this.server;
        this.server = null;
        try {
            if (server && server.connected) server.disconnect();
        } catch { /* already gone */ }
    }
}

// The transport PiBleClient uses when none is passed to its constructor.
// The Android app swaps this for its native transport *before* app.js
// evaluates (see app/src/native-setup.js).
let defaultTransportFactory = () => new WebBluetoothTransport();

export function setDefaultTransport(factory) {
    defaultTransportFactory = factory;
}


// ---------- protocol client ---------- #

export class PiBleClient extends EventTarget {
    constructor({ transport = null } = {}) {
        super();
        this.transport = transport || defaultTransportFactory();
        /** @type {{id:string, name:string}|null} */ this.device = null;
        /** @type {Map<string, object>} uuid -> characteristic properties */
        this.chars = new Map();
        /** @type {Map<string, Set<Function>>} uuid -> value listeners */
        this._listeners = new Map();
        /** @type {Set<string>} uuids with notifications already enabled */
        this._notifying = new Set();
    }

    get available()         { return this.transport.available; }
    get unavailableReason() { return this.transport.unavailableReason || ""; }
    get warnings()          { return this.transport.warnings || []; }
    get transportName()     { return this.transport.name; }

    get connected() {
        return !!this.transport.connected;
    }

    // ---------- connection lifecycle ---------- #

    /**
     * Connect to a pi-ble-config device.
     *
     * Strategy: open the device chooser once (on the web this NEEDS to
     * happen on the user's click — browsers won't let us call
     * requestDevice again without a fresh gesture). Then retry the
     * actual GATT connect and service discovery up to ``maxAttempts``
     * times with a short backoff. Each attempt fires a
     * ``connect-attempt`` event so the UI can render "trying X of N".
     */
    async connect({ maxAttempts = 5, backoffMs = 1500 } = {}) {
        if (!this.available) {
            const err = new Error(this.unavailableReason);
            log.error(`${this.transportName}: transport unavailable`, err);
            throw err;
        }

        log.info(`requesting device via ${this.transportName} (will show chooser)`);
        const t0 = performance.now();
        const device = await this.transport.requestDevice(SERVICE_UUID);
        log.info(`device chosen in ${(performance.now() - t0).toFixed(0)}ms`, {
            id: device.id, name: device.name,
        });
        this.device = device;

        let lastErr = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            this.dispatchEvent(new CustomEvent("connect-attempt", {
                detail: { attempt, max: maxAttempts },
            }));
            log.info(`connect attempt ${attempt}/${maxAttempts}`);
            try {
                await this._tryConnectOnce();
                this.dispatchEvent(new CustomEvent("connected", { detail: { device, attempts: attempt } }));
                log.info(`connected on attempt ${attempt}/${maxAttempts}`);
                return;
            } catch (err) {
                lastErr = err;
                log.warn(`attempt ${attempt}/${maxAttempts} failed`, err);
                // Tear down any partial state before retrying so the
                // next pass has a clean slate.
                await this._reset();
                if (attempt < maxAttempts) {
                    await new Promise(r => setTimeout(r, backoffMs));
                }
            }
        }
        throw new Error(
            `failed to connect after ${maxAttempts} attempts: ${lastErr?.message || lastErr}`
        );
    }

    async _tryConnectOnce() {
        log.debug("connecting GATT");
        await this.transport.connect(() => this._handleDisconnected());
        log.info("GATT connected");

        // Discover the service and pre-cache each characteristic so
        // later ops avoid the round-trip. A missing characteristic is
        // a bad connect (firmware mismatch or truncated discovery) —
        // the transport throws and the retry loop handles it.
        log.debug("discover service", { uuid: SERVICE_UUID });
        this.chars = await this.transport.discover(SERVICE_UUID, ALL_CHAR_UUIDS);
        for (const [uuid, props] of this.chars) {
            log.debug(`got characteristic ${shortUuid(uuid)}`, { properties: propSummary(props) });
        }
    }

    _handleDisconnected() {
        // Drop cached handles so a stray read/write after the link went
        // away fails fast with a clear message instead of a transport
        // error, and so a reconnect starts from a clean slate.
        this._listeners.clear();
        this._notifying.clear();
        this.chars = new Map();
        this.dispatchEvent(new CustomEvent("disconnected"));
    }

    async _reset() {
        this._listeners.clear();
        this._notifying.clear();
        this.chars = new Map();
        try { await this.transport.disconnect(); } catch { /* ignore */ }
    }

    async disconnect() {
        if (this.connected) {
            log.info("disconnecting GATT");
        }
        await this._reset();
    }

    // ---------- raw IO ---------- #

    _requireChar(uuid) {
        const props = this.chars.get(uuid);
        if (!props) throw new Error(`characteristic not available: ${uuid}`);
        return props;
    }

    async readBytes(uuid) {
        this._requireChar(uuid);
        log.debug(`read ${shortUuid(uuid)} -> requesting`);
        const t0 = performance.now();
        const bytes = await this.transport.read(uuid);
        log.debug(
            `read ${shortUuid(uuid)} <- ${bytes.length}B in ${(performance.now() - t0).toFixed(0)}ms`,
            bytes,
        );
        return bytes;
    }

    async writeBytes(uuid, data, { withResponse = true } = {}) {
        this._requireChar(uuid);
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        log.debug(`write ${shortUuid(uuid)} -> ${bytes.length}B (response=${withResponse})`, bytes);
        const t0 = performance.now();
        await this.transport.write(uuid, bytes, { withResponse });
        log.debug(`write ${shortUuid(uuid)} ok in ${(performance.now() - t0).toFixed(0)}ms`);
    }

    async readJson(uuid) {
        const bytes = await this.readBytes(uuid);
        const text = decoder.decode(bytes);
        if (!text) {
            // BLE read sometimes returns an empty payload — most often
            // because the peripheral was still computing the value when
            // the central's ATT timeout fired. Treat as "no data yet"
            // and let the caller retry/fall back instead of throwing a
            // confusing "Unexpected end of JSON input" SyntaxError.
            log.warn(`read ${shortUuid(uuid)} returned 0 bytes`);
            return null;
        }
        try {
            const obj = JSON.parse(text);
            log.debug(`read ${shortUuid(uuid)} decoded JSON`, obj);
            return obj;
        } catch (err) {
            log.error(`read ${shortUuid(uuid)} JSON parse failed`, { text, err });
            throw err;
        }
    }

    async writeJson(uuid, obj) {
        log.info(`write ${shortUuid(uuid)} JSON`, obj);
        await this.writeBytes(uuid, encoder.encode(JSON.stringify(obj)));
    }

    /**
     * Register ``onValue`` for notifications on ``uuid``. Several
     * listeners per characteristic are fine; notifications are enabled
     * on the link once and fanned out from here. Listeners are dropped
     * automatically on disconnect.
     */
    async subscribe(uuid, onValue) {
        const props = this._requireChar(uuid);
        if (!props.notify && !props.indicate) {
            log.warn(`subscribe skipped, ${shortUuid(uuid)} has no notify property`);
            return;
        }
        this._addListener(uuid, onValue);
        await this._ensureNotifying(uuid);
    }

    unsubscribe(uuid, onValue) {
        const set = this._listeners.get(uuid);
        if (set) set.delete(onValue);
    }

    _addListener(uuid, fn) {
        let set = this._listeners.get(uuid);
        if (!set) { set = new Set(); this._listeners.set(uuid, set); }
        set.add(fn);
    }

    async _ensureNotifying(uuid) {
        if (this._notifying.has(uuid)) return;
        log.info(`subscribe ${shortUuid(uuid)}`);
        await this.transport.startNotifications(uuid, (bytes) => {
            log.debug(`notify ${shortUuid(uuid)} <- ${bytes.length}B`, bytes);
            // Snapshot: a handler may unsubscribe itself mid-iteration.
            const fns = Array.from(this._listeners.get(uuid) || []);
            for (const fn of fns) {
                try {
                    fn(bytes);
                } catch (err) {
                    log.error(`notify handler for ${shortUuid(uuid)} threw`, err);
                }
            }
        });
        this._notifying.add(uuid);
    }

    // ---------- high-level domain helpers ---------- #

    async scanWifi() {
        // Legacy single-read path. Capped at ~5 networks by the
        // firmware so it stays under the 512-byte GATT value limit.
        // Prefer streamWifi() for the full list.
        log.info("scanWifi: reading scan characteristic (legacy/fallback)");
        const data = await this.readJson(CHAR_WIFI_SCAN_UUID);
        if (data && data.error) throw new Error(data.error);
        if (data === null) return [];
        return Array.isArray(data) ? data : [];
    }

    /**
     * Stream the WiFi scan results, one network per notification.
     *
     * Protocol: subscribe to the scan characteristic, write any byte
     * to trigger, then receive a sequence of frames:
     *   {t:"begin"}                        → handlers.onBegin()
     *   {t:"net", ssid, sig, sec, in}      → handlers.onNetwork(net)
     *   {t:"end", n}                       → handlers.onEnd(count)
     *   {t:"err", msg}                     → handlers.onError(msg)
     *
     * The returned promise resolves with the network array on end, or
     * rejects on err / timeout.
     */
    async streamWifi({ onBegin, onNetwork, onEnd, onError, timeoutMs = 20000 } = {}) {
        this._requireChar(CHAR_WIFI_SCAN_UUID);

        const networks = [];
        let resolve, reject;
        const done = new Promise((res, rej) => { resolve = res; reject = rej; });

        const handler = (bytes) => {
            const text = decoder.decode(bytes);
            let frame;
            try { frame = JSON.parse(text); }
            catch (err) {
                log.warn("streamWifi: non-JSON frame ignored", { text });
                return;
            }
            log.debug("streamWifi frame", frame);
            switch (frame.t) {
                case "begin":
                    networks.length = 0;
                    if (onBegin) onBegin();
                    break;
                case "net":
                    // Normalise to the shape the UI already knows.
                    const net = {
                        ssid:     frame.ssid,
                        signal:   frame.sig,
                        security: frame.sec,
                        in_use:   frame.in,
                    };
                    networks.push(net);
                    if (onNetwork) onNetwork(net, networks.length);
                    break;
                case "end":
                    cleanup();
                    if (onEnd) onEnd(networks.length);
                    resolve(networks);
                    break;
                case "err":
                    cleanup();
                    const err = new Error(frame.msg || "scan error");
                    if (onError) onError(err);
                    reject(err);
                    break;
                default:
                    log.warn("streamWifi: unknown frame type", frame);
            }
        };

        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`streamWifi timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        const cleanup = () => {
            clearTimeout(timer);
            this.unsubscribe(CHAR_WIFI_SCAN_UUID, handler);
        };

        this._addListener(CHAR_WIFI_SCAN_UUID, handler);
        try {
            await this._ensureNotifying(CHAR_WIFI_SCAN_UUID);
        } catch (err) {
            cleanup();
            throw err;
        }

        log.info("streamWifi: subscribed, writing trigger");
        // Single-byte trigger is enough; firmware ignores the payload.
        await this.writeBytes(CHAR_WIFI_SCAN_UUID, new Uint8Array([1]));

        return done;
    }

    async connectWifi(ssid, password, hidden = false) {
        // Bypasses the generic writeJson/writeBytes helpers on purpose:
        // those log the full payload, which would dump the password
        // into the on-page log panel (and the downloaded .log file).
        // We log a redacted summary instead, then hand the bytes
        // straight to the transport (which never logs payloads).
        this._requireChar(CHAR_WIFI_CONNECT_UUID);
        const payload = JSON.stringify({
            ssid,
            password: password || "",
            hidden: !!hidden,
        });
        const bytes = encoder.encode(payload);

        log.info("connectWifi (password redacted)", {
            ssid,
            hidden: !!hidden,
            hasPassword: !!password,
            payloadBytes: bytes.length,
        });

        const t0 = performance.now();
        await this.transport.write(CHAR_WIFI_CONNECT_UUID, bytes, { withResponse: true });
        log.debug(
            `write ${shortUuid(CHAR_WIFI_CONNECT_UUID)} ${bytes.length}B in ${(performance.now() - t0).toFixed(0)}ms (contents redacted)`
        );
    }

    async wifiStatus() {
        return await this.readJson(CHAR_WIFI_STATUS_UUID);
    }

    async readSsh() {
        const bytes = await this.readBytes(CHAR_SSH_UUID);
        const enabled = !!(bytes[0]);
        log.info(`readSsh: ${enabled ? "ON" : "OFF"}`);
        return enabled;
    }

    async setSsh(enabled) {
        log.info(`setSsh: ${enabled ? "ON" : "OFF"}`);
        await this.writeBytes(CHAR_SSH_UUID, new Uint8Array([enabled ? 1 : 0]));
    }

    async readIp() {
        // Returns ``{primary: "x.x.x.x", ifaces: [{iface,type,ip,state,mac}, ...]}``.
        // Legacy firmware returned a bare UTF-8 string — we accept that
        // shape too and synthesise the structured form so an older
        // firmware doesn't crash the UI.
        const bytes = await this.readBytes(CHAR_IP_UUID);
        const text = decoder.decode(bytes);
        if (!text) {
            log.warn("readIp: empty payload");
            return { primary: "", ifaces: [] };
        }
        try {
            const obj = JSON.parse(text);
            log.info(`readIp: primary=${obj.primary || "(none)"}, ${obj.ifaces?.length ?? 0} ifaces`);
            return { primary: obj.primary || "", ifaces: obj.ifaces || [] };
        } catch {
            // Legacy: plain string IP.
            log.info(`readIp (legacy string): ${text}`);
            return { primary: text, ifaces: [] };
        }
    }
}

// ---------- helpers ---------- #

export function viewToBytes(view) {
    // Copy out of the DataView: Web Bluetooth reuses the underlying
    // buffer for the next notification on some platforms.
    return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
}

function shortUuid(uuid) {
    // First 8 hex chars uniquely identify our chars; full UUIDs are noisy.
    return uuid.slice(0, 8);
}

function propSummary(p) {
    const f = [];
    if (p.read)                  f.push("read");
    if (p.write)                 f.push("write");
    if (p.writeWithoutResponse)  f.push("writeWoResp");
    if (p.notify)                f.push("notify");
    if (p.indicate)              f.push("indicate");
    return f.join("|");
}

export { decoder, encoder };
