// Drives PiBleClient (web/ble.js) through a fake transport: connect
// retries, notification fan-out, Wi-Fi scan streaming, password
// redaction and disconnect cleanup. Runs under plain Node:
//
//   npm test
//
// It is transport-agnostic on purpose — the same client runs on Web
// Bluetooth in the browser and on the native plugin in the app.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
    PiBleClient, SERVICE_UUID, CHAR_WIFI_SCAN_UUID, CHAR_WIFI_STATUS_UUID,
    CHAR_WIFI_CONNECT_UUID, CHAR_SSH_UUID, CHAR_IP_UUID,
} from "../../web/ble.js";
import { log } from "../../web/logger.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const json = (o) => enc.encode(JSON.stringify(o));

globalThis.performance ??= { now: () => Date.now() };
log._mirror = false;   // keep the test output quiet

class FakeTransport {
    constructor({ failFirst = 0 } = {}) {
        this.name = "fake";
        this.connected = false;
        this.failFirst = failFirst;
        this.subs = new Map();          // uuid -> notification callback
        this.writes = [];
        this.values = new Map([
            [CHAR_SSH_UUID,         new Uint8Array([1])],
            [CHAR_IP_UUID,          json({ primary: "10.0.0.5", ifaces: [{ iface: "wlan0" }] })],
            [CHAR_WIFI_STATUS_UUID, json({ connected: true, ssid: "home" })],
        ]);
        this.startCalls = 0;
        this.disconnects = 0;
    }
    get available() { return true; }
    get warnings()  { return []; }
    async requestDevice(svc) {
        assert.equal(svc, SERVICE_UUID);
        return { id: "AA:BB:CC:DD:EE:FF", name: "PiCfg-test-1234" };
    }
    async connect(onDisconnected) {
        if (this.failFirst-- > 0) throw new Error("boom");
        this.onDisconnected = onDisconnected;
        this.connected = true;
    }
    async discover(_svc, uuids) {
        const m = new Map();
        for (const u of uuids) {
            m.set(u, { read: true, write: true, writeWithoutResponse: false, notify: true, indicate: false });
        }
        return m;
    }
    async read(uuid) { return this.values.get(uuid) || new Uint8Array(); }
    async write(uuid, bytes, opts) {
        this.writes.push({ uuid, text: dec.decode(bytes), opts });
        if (uuid === CHAR_WIFI_SCAN_UUID) {
            // Firmware streams the scan back over the same characteristic.
            setTimeout(() => {
                const cb = this.subs.get(uuid);
                for (const f of [
                    { t: "begin" },
                    { t: "net", ssid: "a", sig: 70, sec: "WPA2", in: false },
                    { t: "net", ssid: "b", sig: 30, sec: "", in: true },
                    { t: "end", n: 2 },
                ]) cb(json(f));
            }, 5);
        }
    }
    async startNotifications(uuid, cb) {
        this.startCalls++;
        assert.ok(!this.subs.has(uuid), `startNotifications called twice for ${uuid}`);
        this.subs.set(uuid, cb);
    }
    async disconnect() {
        this.disconnects++;
        this.connected = false;
        this.subs.clear();
    }
}

test("connect retries until the transport succeeds", async () => {
    const t = new FakeTransport({ failFirst: 2 });
    const c = new PiBleClient({ transport: t });
    const attempts = [];
    let connected = null;
    c.addEventListener("connect-attempt", (e) => attempts.push(e.detail.attempt));
    c.addEventListener("connected", (e) => { connected = e.detail; });

    await c.connect({ maxAttempts: 5, backoffMs: 1 });

    assert.deepEqual(attempts, [1, 2, 3]);
    assert.equal(connected.attempts, 3);
    assert.equal(c.connected, true);
    assert.equal(c.device.name, "PiCfg-test-1234");
    assert.equal(c.chars.size, 6);
    assert.equal(t.disconnects, 2, "partial state torn down between attempts");
});

test("connect gives up after maxAttempts", async () => {
    const c = new PiBleClient({ transport: new FakeTransport({ failFirst: 9 }) });
    await assert.rejects(
        c.connect({ maxAttempts: 2, backoffMs: 1 }),
        /failed to connect after 2 attempts: boom/,
    );
    assert.equal(c.connected, false);
});

test("notifications fan out to every subscriber, enabled once per characteristic", async () => {
    const t = new FakeTransport();
    const c = new PiBleClient({ transport: t });
    await c.connect({ maxAttempts: 1 });

    const got = [];
    await c.subscribe(CHAR_WIFI_STATUS_UUID, (b) => got.push("A:" + dec.decode(b)));
    await c.subscribe(CHAR_WIFI_STATUS_UUID, (b) => got.push("B:" + dec.decode(b)));
    assert.equal(t.startCalls, 1);

    t.subs.get(CHAR_WIFI_STATUS_UUID)(enc.encode("{}"));
    assert.deepEqual(got, ["A:{}", "B:{}"]);
});

test("streamWifi collects frames and leaves the subscription reusable", async () => {
    const t = new FakeTransport();
    const c = new PiBleClient({ transport: t });
    await c.connect({ maxAttempts: 1 });

    const seen = [];
    let ended = 0;
    const nets = await c.streamWifi({
        onNetwork: (n) => seen.push(n.ssid),
        onEnd: (n) => { ended = n; },
        timeoutMs: 1000,
    });
    assert.deepEqual(nets.map((n) => n.ssid), ["a", "b"]);
    assert.deepEqual(seen, ["a", "b"]);
    assert.equal(ended, 2);
    assert.deepEqual(nets[1], { ssid: "b", signal: 30, security: "", in_use: true });
    assert.equal(t.writes.at(-1).uuid, CHAR_WIFI_SCAN_UUID, "trigger byte written");

    // Handler removed after "end"; a second scan reuses the link-level subscription.
    assert.equal(c._listeners.get(CHAR_WIFI_SCAN_UUID).size, 0);
    const again = await c.streamWifi({ timeoutMs: 1000 });
    assert.equal(again.length, 2);
    assert.equal(t.startCalls, 1);
});

test("domain helpers read and write the right characteristics", async () => {
    const t = new FakeTransport();
    const c = new PiBleClient({ transport: t });
    await c.connect({ maxAttempts: 1 });

    assert.equal(await c.readSsh(), true);
    await c.setSsh(false);
    assert.equal(t.writes.at(-1).uuid, CHAR_SSH_UUID);
    assert.equal(t.writes.at(-1).text, "\0");

    assert.deepEqual(await c.readIp(), { primary: "10.0.0.5", ifaces: [{ iface: "wlan0" }] });
    assert.deepEqual(await c.wifiStatus(), { connected: true, ssid: "home" });
});

test("connectWifi sends the password but never logs it", async () => {
    const t = new FakeTransport();
    const c = new PiBleClient({ transport: t });
    await c.connect({ maxAttempts: 1 });

    log.clear();
    await c.connectWifi("home", "s3cret-pass", false);

    const w = t.writes.at(-1);
    assert.equal(w.uuid, CHAR_WIFI_CONNECT_UUID);
    assert.deepEqual(JSON.parse(w.text), { ssid: "home", password: "s3cret-pass", hidden: false });
    assert.ok(!log.toText().includes("s3cret-pass"), "password leaked into the log");
    assert.ok(log.toText().includes("password redacted"));
});

test("a peripheral-side disconnect clears state and fires 'disconnected'", async () => {
    const t = new FakeTransport();
    const c = new PiBleClient({ transport: t });
    await c.connect({ maxAttempts: 1 });
    await c.subscribe(CHAR_WIFI_STATUS_UUID, () => {});

    let events = 0;
    c.addEventListener("disconnected", () => events++);
    t.connected = false;
    t.onDisconnected();

    assert.equal(events, 1);
    assert.equal(c.connected, false);
    assert.equal(c._notifying.size, 0);
    assert.equal(c._listeners.size, 0);
    await assert.rejects(c.readSsh(), /characteristic not available/);
});
