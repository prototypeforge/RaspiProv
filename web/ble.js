// Web Bluetooth client for the pi_ble_config GATT service.
//
// Mirrors the layout defined in pi_ble_config/protocol.py — keep the UUIDs
// here in sync with that file. All operations are logged at debug/info
// level via ./logger.js so the user can see exactly what is happening over
// the air.

import { log } from "./logger.js";

export const SERVICE_UUID         = "6f3a0001-9a2b-4f3e-8d1c-1a2b3c4d5e6f";
export const CHAR_WIFI_SCAN_UUID  = "6f3a0002-9a2b-4f3e-8d1c-1a2b3c4d5e6f";
export const CHAR_WIFI_CONNECT_UUID = "6f3a0003-9a2b-4f3e-8d1c-1a2b3c4d5e6f";
export const CHAR_WIFI_STATUS_UUID = "6f3a0004-9a2b-4f3e-8d1c-1a2b3c4d5e6f";
export const CHAR_SSH_UUID        = "6f3a0005-9a2b-4f3e-8d1c-1a2b3c4d5e6f";
export const CHAR_IP_UUID         = "6f3a0006-9a2b-4f3e-8d1c-1a2b3c4d5e6f";
export const CHAR_RESULT_UUID     = "6f3a0007-9a2b-4f3e-8d1c-1a2b3c4d5e6f";

const decoder = new TextDecoder("utf-8");
const encoder = new TextEncoder();


export class PiBleClient extends EventTarget {
    constructor() {
        super();
        /** @type {BluetoothDevice|null} */ this.device = null;
        /** @type {BluetoothRemoteGATTServer|null} */ this.server = null;
        /** @type {BluetoothRemoteGATTService|null} */ this.service = null;
        /** @type {Map<string, BluetoothRemoteGATTCharacteristic>} */
        this.chars = new Map();
    }

    get connected() {
        return !!(this.server && this.server.connected);
    }

    // ---------- connection lifecycle ---------- #

    /**
     * Connect to a pi-ble-config device.
     *
     * Strategy: open the browser chooser once (this NEEDS to happen on
     * the user's click — browsers won't let us call requestDevice again
     * without a fresh gesture). Then retry the actual GATT connect and
     * service discovery up to ``maxAttempts`` times with a short
     * backoff. Each attempt fires a ``connect-attempt`` event so the
     * UI can render "trying X of N".
     */
    async connect({ maxAttempts = 5, backoffMs = 1500 } = {}) {
        if (!("bluetooth" in navigator)) {
            const err = new Error(
                "Web Bluetooth not available. Use Chrome/Edge over HTTPS or localhost."
            );
            log.error("navigator.bluetooth missing", err);
            throw err;
        }

        log.info("requesting device (will show browser chooser)");
        const t0 = performance.now();
        const device = await navigator.bluetooth.requestDevice({
            filters: [{ services: [SERVICE_UUID] }],
            optionalServices: [SERVICE_UUID],
        });
        log.info(`device chosen in ${(performance.now() - t0).toFixed(0)}ms`, {
            id: device.id, name: device.name,
        });

        device.addEventListener("gattserverdisconnected", () => {
            log.warn("gattserverdisconnected");
            this.dispatchEvent(new CustomEvent("disconnected"));
        });
        this.device = device;

        let lastErr = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            this.dispatchEvent(new CustomEvent("connect-attempt", {
                detail: { attempt, max: maxAttempts },
            }));
            log.info(`connect attempt ${attempt}/${maxAttempts}`);
            try {
                await this._tryConnectOnce(device);
                this.dispatchEvent(new CustomEvent("connected", { detail: { device, attempts: attempt } }));
                log.info(`connected on attempt ${attempt}/${maxAttempts}`);
                return;
            } catch (err) {
                lastErr = err;
                log.warn(`attempt ${attempt}/${maxAttempts} failed`, err);
                // Tear down any partial state before retrying so the
                // next pass has a clean slate.
                try { if (device.gatt && device.gatt.connected) device.gatt.disconnect(); } catch {}
                this.chars.clear();
                this.service = null;
                this.server = null;
                if (attempt < maxAttempts) {
                    await new Promise(r => setTimeout(r, backoffMs));
                }
            }
        }
        throw new Error(
            `failed to connect after ${maxAttempts} attempts: ${lastErr?.message || lastErr}`
        );
    }

    async _tryConnectOnce(device) {
        log.debug("connecting GATT");
        this.server = await device.gatt.connect();
        log.info("GATT connected");

        log.debug("getPrimaryService", { uuid: SERVICE_UUID });
        this.service = await this.server.getPrimaryService(SERVICE_UUID);

        // Pre-cache each characteristic handle so later ops avoid the
        // round-trip. Missing characteristics are logged but non-fatal —
        // the firmware version may not yet expose them.
        const uuids = [
            CHAR_WIFI_SCAN_UUID, CHAR_WIFI_CONNECT_UUID, CHAR_WIFI_STATUS_UUID,
            CHAR_SSH_UUID, CHAR_IP_UUID, CHAR_RESULT_UUID,
        ];
        for (const uuid of uuids) {
            try {
                const ch = await this.service.getCharacteristic(uuid);
                this.chars.set(uuid, ch);
                log.debug(`got characteristic ${shortUuid(uuid)}`, {
                    properties: propSummary(ch.properties),
                });
            } catch (err) {
                log.warn(`characteristic ${shortUuid(uuid)} missing`, err);
                throw err;   // missing chars = bad connect; let retry handle it
            }
        }
    }

    async disconnect() {
        if (this.server && this.server.connected) {
            log.info("disconnecting GATT");
            this.server.disconnect();
        }
    }

    // ---------- raw IO ---------- #

    _requireChar(uuid) {
        const ch = this.chars.get(uuid);
        if (!ch) throw new Error(`characteristic not available: ${uuid}`);
        return ch;
    }

    async readBytes(uuid) {
        const ch = this._requireChar(uuid);
        log.debug(`read ${shortUuid(uuid)} -> requesting`);
        const t0 = performance.now();
        const view = await ch.readValue();
        const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        log.debug(
            `read ${shortUuid(uuid)} <- ${bytes.length}B in ${(performance.now() - t0).toFixed(0)}ms`,
            bytes,
        );
        return bytes;
    }

    async writeBytes(uuid, data, { withResponse = true } = {}) {
        const ch = this._requireChar(uuid);
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        log.debug(`write ${shortUuid(uuid)} -> ${bytes.length}B (response=${withResponse})`, bytes);
        const t0 = performance.now();
        if (withResponse && ch.writeValueWithResponse) {
            await ch.writeValueWithResponse(bytes);
        } else if (!withResponse && ch.writeValueWithoutResponse) {
            await ch.writeValueWithoutResponse(bytes);
        } else {
            // Older Web Bluetooth implementations.
            await ch.writeValue(bytes);
        }
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

    async subscribe(uuid, onValue) {
        const ch = this._requireChar(uuid);
        if (!ch.properties.notify && !ch.properties.indicate) {
            log.warn(`subscribe skipped, ${shortUuid(uuid)} has no notify property`);
            return;
        }
        log.info(`subscribe ${shortUuid(uuid)}`);
        ch.addEventListener("characteristicvaluechanged", (ev) => {
            const view = ev.target.value;
            const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
            log.debug(`notify ${shortUuid(uuid)} <- ${bytes.length}B`, bytes);
            try {
                onValue(bytes);
            } catch (err) {
                log.error(`notify handler for ${shortUuid(uuid)} threw`, err);
            }
        });
        await ch.startNotifications();
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
        const ch = this._requireChar(CHAR_WIFI_SCAN_UUID);

        const networks = [];
        let resolve, reject;
        const done = new Promise((res, rej) => { resolve = res; reject = rej; });

        const handler = (ev) => {
            const view = ev.target.value;
            const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
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
            ch.removeEventListener("characteristicvaluechanged", handler);
        };

        ch.addEventListener("characteristicvaluechanged", handler);
        try {
            await ch.startNotifications();
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
        // We log a redacted summary instead, then send the bytes
        // directly to the characteristic.
        const ch = this._requireChar(CHAR_WIFI_CONNECT_UUID);
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
        if (ch.writeValueWithResponse) {
            await ch.writeValueWithResponse(bytes);
        } else {
            await ch.writeValue(bytes);
        }
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
