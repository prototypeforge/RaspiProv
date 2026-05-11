// UI orchestration: wires DOM controls to the BLE client, manages the
// password modal, and reflects notifications back into the UI.
//
// All meaningful actions are logged via ./logger.js so the in-page log
// panel doubles as a live transcript of the session.

import { log } from "./logger.js";
import {
    PiBleClient,
    CHAR_WIFI_STATUS_UUID,
    CHAR_IP_UUID,
    CHAR_RESULT_UUID,
    decoder,
} from "./ble.js";

// -------- DOM lookups -------- //
const $ = (id) => document.getElementById(id);

const ui = {
    // layout containers
    hero:        $("hero"),
    layout:      $("layout"),

    // top bar
    connState:   $("conn-state"),
    connSub:     $("conn-substate"),
    btnConnect:  $("btn-connect"),
    btnDisc:     $("btn-disconnect"),
    heroStatus:  $("hero-status"),

    // status card
    btnRefresh:  $("btn-refresh"),
    lastUpdate:  $("last-update"),
    statusDevice:$("status-device"),
    statusWifi:  $("status-wifi"),
    statusSsid:  $("status-ssid"),
    statusIp:    $("status-ip"),
    statusSsh:   $("status-ssh"),
    statusResult:$("status-result"),
    ifacesTbody: $("ifaces-tbody"),

    // ssh
    inSsh:       $("in-ssh"),
    sshLabel:    $("ssh-label"),

    // wifi
    btnScan:     $("btn-scan"),
    btnRescan:   $("btn-rescan"),
    scanCount:   $("scan-count"),
    wifiList:    $("wifi-list"),
    btnAddHidden: $("btn-add-hidden"),
    hiddenDetails: document.querySelector(".hidden-net"),

    // log
    logPanel:    $("log-panel"),
    logLevel:    $("log-level"),
    btnLogClear: $("btn-log-clear"),
    btnLogSave:  $("btn-log-save"),

    // modal
    modalOverlay: $("modal-overlay"),
    modalForm:    $("modal-form"),
    modalTitle:   $("modal-title"),
    modalMeta:    $("modal-meta"),
    modalSsid:    $("modal-ssid"),
    modalPass:    $("modal-pass"),
    modalPassToggle: $("modal-pass-toggle"),
    modalHiddenRow: $("modal-hidden-row"),
    modalHidden:  $("modal-hidden"),
    modalCancel:  $("modal-cancel"),
    modalClose:   $("modal-close"),
    modalSubmit:  $("modal-submit"),
    modalError:   $("modal-error"),
    modalErrorMsg:$("modal-error-msg"),
};


// -------- Logger bootstrap -------- //

log.attach(ui.logPanel);
log.info("page loaded", {
    userAgent: navigator.userAgent,
    webBluetooth: "bluetooth" in navigator,
    secureContext: window.isSecureContext,
});

if (!("bluetooth" in navigator)) {
    log.error("Web Bluetooth not available in this browser");
    ui.btnConnect.disabled = true;
    ui.btnConnect.title = "Web Bluetooth not supported. Use Chrome or Edge.";
} else if (!window.isSecureContext) {
    log.warn("Insecure context — Web Bluetooth requires HTTPS or localhost");
}

ui.logLevel.addEventListener("change", (e) => {
    log.setLevel(e.target.value);
    log.info(`log level set to ${e.target.value}`);
});
ui.btnLogClear.addEventListener("click", () => log.clear());
ui.btnLogSave.addEventListener("click", () => log.download());


// -------- BLE client wiring -------- //

const client = new PiBleClient();

// Timestamp (ms) of the most recent notification of any kind — used to
// power the "last update Xs ago" pill in the Status card header. Any
// time we observe a frame from the firmware (status / ip / result /
// scan), we bump it. A small setInterval rerenders the relative age.
let lastNotifyAt = 0;
function markFresh() { lastNotifyAt = Date.now(); }

client.addEventListener("connect-attempt", (e) => {
    const { attempt, max } = e.detail;
    // Top bar: stays as the at-a-glance state. No attempt counter here
    // — that would duplicate the same number in three places.
    ui.connState.textContent = "connecting";
    ui.connState.classList.remove("badge-on");
    ui.connState.classList.add("badge-off");
    ui.connSub.textContent = "";
    ui.connSub.classList.remove("err", "attempting");

    // Button: signals "in progress" without naming the attempt count.
    ui.btnConnect.disabled = true;
    ui.btnConnect.textContent = "Connecting…";

    // Hero status line under the button is the single place the
    // attempt counter shows. One number, one location.
    setHeroStatus(`Attempt ${attempt} of ${max}`, "attempting");
});

client.addEventListener("connected", (e) => {
    ui.connSub.classList.remove("attempting", "err");
    ui.connSub.textContent = e.detail.attempts > 1
        ? `connected (after ${e.detail.attempts} attempts)`
        : "";
    setHeroStatus("", null);
    ui.btnConnect.textContent = "Connect to Pi";
});

client.addEventListener("disconnected", () => {
    setConnectedUi(false);
    log.warn("client reports disconnected");
});

ui.btnConnect.addEventListener("click", async () => {
    try {
        await client.connect({ maxAttempts: 5, backoffMs: 1500 });
        ui.statusDevice.textContent = displayDeviceName(client.device);
        setConnectedUi(true);
        await subscribeAll();
        await refreshAll();
        // Kick off a WiFi scan immediately so the user lands in a
        // ready-to-go state — no extra click needed to see networks.
        // Fire-and-forget; doScan handles its own errors and UI state.
        doScan().catch((err) => log.warn("post-connect auto scan failed", err));
    } catch (err) {
        log.error("connect failed (all attempts exhausted)", err);
        ui.connSub.classList.remove("attempting");
        ui.connSub.classList.add("err");
        ui.connSub.textContent = "failed";
        setHeroStatus(`Connection failed — ${err.message || err}`, "err");
        ui.btnConnect.disabled = false;
        ui.btnConnect.textContent = "Try again";
        setConnectedUi(false);
    }
});

function setHeroStatus(text, variant) {
    if (!ui.heroStatus) return;
    ui.heroStatus.textContent = text || "";
    ui.heroStatus.classList.remove("attempting", "err");
    if (variant) ui.heroStatus.classList.add(variant);
}

function displayDeviceName(device) {
    if (!device) return "(unknown)";
    if (device.name) return device.name;
    // Chrome didn't capture the LocalName during scan — fall back to a
    // short, *labelled* form of the opaque internal ID so the user
    // knows what they're looking at instead of seeing a random base64
    // blob with no context.
    const shortId = (device.id || "").slice(0, 8);
    return `(no name; id ${shortId}…)`;
}

ui.btnDisc.addEventListener("click", async () => {
    try { await client.disconnect(); }
    catch (err) { log.error("disconnect threw", err); }
    setConnectedUi(false);
});

ui.btnRefresh.addEventListener("click", refreshAll);
ui.btnScan.addEventListener("click", doScan);
ui.btnRescan.addEventListener("click", doScan);
ui.btnAddHidden.addEventListener("click", () => openModal({ hidden: true }));

ui.inSsh.addEventListener("change", async (e) => {
    const desired = e.target.checked;
    log.info(`SSH toggle -> ${desired ? "ON" : "OFF"}`);
    try {
        await client.setSsh(desired);
    } catch (err) {
        log.error("setSsh failed", err);
        await safeReadSsh();
    }
});


// -------- Subscriptions & refresh -------- //

async function subscribeAll() {
    await client.subscribe(CHAR_WIFI_STATUS_UUID, onStatusBytes);
    await client.subscribe(CHAR_IP_UUID, onIpBytes);
    await client.subscribe(CHAR_RESULT_UUID, onResultBytes);
}

function onStatusBytes(bytes) {
    markFresh();
    try {
        const obj = JSON.parse(decoder.decode(bytes));
        applyStatus(obj);
    } catch (err) {
        log.error("status notification: bad JSON", err);
    }
}

function onIpBytes(bytes) {
    markFresh();
    const text = decoder.decode(bytes);
    if (!text) { log.warn("IP notification: empty payload"); return; }
    let obj;
    try { obj = JSON.parse(text); }
    catch {
        ui.statusIp.textContent = text || "—";
        log.info(`IP notification (legacy string): ${text}`);
        return;
    }
    applyIpPayload(obj);
}

function onResultBytes(bytes) {
    markFresh();
    let obj;
    try {
        obj = JSON.parse(decoder.decode(bytes));
    } catch (err) {
        log.error("result notification: bad JSON", err);
        return;
    }

    const summary = `${obj.op}: ${obj.ok ? "OK" : "FAIL"} — ${obj.msg || ""}`;
    ui.statusResult.textContent = summary;

    // Failures get error-level logs so they stand out in the panel.
    // (Earlier we used log.warn — a wrong password is the user's most
    // common interaction failure and deserves to be loud.)
    if (obj.ok) {
        log.info(`result: ${summary}`, obj);
    } else {
        log.error(`result: ${summary}`, obj);
    }

    if (obj.op === "ssh") safeReadSsh();

    if (obj.op === "connect") {
        if (obj.ok) {
            // Success: close the modal and refresh state.
            if (!ui.modalOverlay.hidden) closeModal();
            refreshAll().catch(() => {});
            // Re-stream the WiFi list a moment later so the new
            // "in_use" marker shows on the network we just joined
            // (and the previously-connected one stops being marked).
            // 2.5 s gives nmcli's IN-USE column time to flip.
            setTimeout(() => {
                if (client.connected) doScan().catch(() => {});
            }, 2500);
        } else {
            // Failure: keep the modal open, show the firmware's error
            // message in-place, re-arm the Connect button so the user
            // can fix the password and try again immediately.
            if (!ui.modalOverlay.hidden) {
                showModalError(obj.msg || "Connection failed.");
                ui.modalSubmit.disabled = false;
                ui.modalSubmit.textContent = "Connect";
                // Focus the password field so the user can edit it.
                ui.modalPass.focus();
                ui.modalPass.select();
            }
        }
    }
}

function applyStatus(s) {
    ui.statusWifi.textContent = s.connected ? "connected" : "disconnected";
    ui.statusSsid.textContent = s.ssid || "—";
    if (s.ip) ui.statusIp.textContent = s.ip;
    log.debug("status applied", s);
}

function applyIpPayload(obj) {
    ui.statusIp.textContent = obj.primary || "—";
    renderInterfaces(obj.ifaces || []);
    log.debug("IP applied", obj);
}

async function refreshAll() {
    if (!client.connected) return;
    log.info("refreshing all state");
    await Promise.allSettled([
        (async () => applyStatus(await client.wifiStatus()))(),
        (async () => applyIpPayload(await client.readIp()))(),
        safeReadSsh(),
    ]);
}

async function safeReadSsh() {
    try {
        const enabled = await client.readSsh();
        ui.inSsh.checked = enabled;
        ui.inSsh.disabled = !client.connected;
        ui.sshLabel.textContent = enabled ? "running" : "stopped";
        ui.statusSsh.textContent = enabled ? "ON" : "OFF";
    } catch (err) {
        log.error("readSsh failed", err);
    }
}


// -------- Interfaces table -------- //

function renderInterfaces(ifaces) {
    ui.ifacesTbody.innerHTML = "";
    if (!ifaces.length) {
        ui.ifacesTbody.innerHTML = `<tr><td colspan="4" class="muted">No interfaces.</td></tr>`;
        return;
    }
    for (const i of ifaces) {
        const tr = document.createElement("tr");

        const tdName = document.createElement("td");
        tdName.textContent = i.iface;
        tdName.className = "mono";

        const tdType = document.createElement("td");
        tdType.append(typeBadge(i.type));

        const tdIp = document.createElement("td");
        tdIp.textContent = i.ip || "—";
        tdIp.className = "mono";

        const tdState = document.createElement("td");
        tdState.textContent = i.state || "—";
        tdState.className = `state state-${(i.state || "unknown").toLowerCase()}`;

        tr.append(tdName, tdType, tdIp, tdState);
        ui.ifacesTbody.appendChild(tr);
    }
}

function typeBadge(type) {
    const span = document.createElement("span");
    span.className = `type-badge type-${type || "other"}`;
    span.textContent = type || "?";
    return span;
}


// -------- WiFi scan + list -------- //

async function doScan() {
    if (!client.connected) return;
    ui.btnScan.disabled = true;
    ui.btnRescan.disabled = true;
    ui.scanCount.textContent = "scanning…";
    ui.wifiList.innerHTML = `<li class="wifi-empty muted">Scanning…</li>`;

    const collected = [];

    try {
        await client.streamWifi({
            onBegin: () => {
                markFresh();
                collected.length = 0;
                ui.wifiList.innerHTML = "";
            },
            onNetwork: (net, count) => {
                markFresh();
                collected.push(net);
                renderNetworks(collected);
                ui.scanCount.textContent = `${count} so far…`;
            },
            onEnd: (count) => {
                markFresh();
                ui.scanCount.textContent = `${count} network${count === 1 ? "" : "s"}`;
                if (count === 0) {
                    ui.wifiList.innerHTML = `<li class="wifi-empty muted">No networks visible.</li>`;
                }
                log.info(`scan complete: ${count} networks`);
            },
            onError: (err) => log.error("scan stream reported error", err),
        });
    } catch (err) {
        log.error("scan failed", err);
        ui.scanCount.textContent = "scan failed";
        ui.wifiList.innerHTML = `<li class="wifi-empty muted">Scan failed: ${escapeHtml(err.message || err)}</li>`;
    } finally {
        ui.btnScan.disabled = !client.connected;
        ui.btnRescan.disabled = !client.connected;
    }
}

function renderNetworks(nets) {
    ui.wifiList.innerHTML = "";
    if (!nets.length) {
        ui.wifiList.innerHTML = `<li class="wifi-empty muted">No networks visible.</li>`;
        return;
    }
    for (const n of nets.slice(0, 30)) {
        const li = document.createElement("li");
        li.className = `wifi-row${n.in_use ? " in-use" : ""}`;
        li.tabIndex = 0;
        li.setAttribute("role", "button");
        li.setAttribute("aria-label", `Connect to ${n.ssid}`);

        const open = isOpen(n.security);

        const iconEl = document.createElement("span");
        iconEl.className = `wifi-icon strength-${signalStep(n.signal)}`;
        iconEl.textContent = signalGlyph(n.signal);

        const nameEl = document.createElement("span");
        nameEl.className = "wifi-name";
        nameEl.textContent = n.ssid;

        const secEl = document.createElement("span");
        secEl.className = `wifi-sec${open ? " sec-open" : ""}`;
        secEl.textContent = open ? "open" : (n.security || "secured");

        const sigEl = document.createElement("span");
        sigEl.className = "wifi-sig";
        sigEl.textContent = `${n.signal}%`;

        li.append(iconEl, nameEl, secEl, sigEl);

        const onActivate = () => openModal({ network: n });
        li.addEventListener("click", onActivate);
        li.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onActivate();
            }
        });

        ui.wifiList.appendChild(li);
    }
}

function isOpen(security) {
    if (!security) return true;
    const s = security.toString().trim();
    return s === "" || s === "--" || s.toLowerCase() === "open" || s.toLowerCase() === "none";
}

function signalStep(pct) {
    if (pct >= 75) return 3;
    if (pct >= 50) return 2;
    if (pct >= 25) return 1;
    return 0;
}

function signalGlyph(pct) {
    return ["▁", "▃", "▅", "▇"][signalStep(pct)];
}


// -------- Password modal -------- //

let modalContext = { hidden: false, network: null };

function openModal({ network = null, hidden = false } = {}) {
    modalContext = { network, hidden };

    if (network) {
        ui.modalTitle.textContent = `Connect to ${network.ssid}`;
        ui.modalSsid.value = network.ssid;
        ui.modalSsid.readOnly = true;
        ui.modalMeta.textContent = `${isOpen(network.security) ? "Open network" : `Security: ${network.security}`} • Signal ${network.signal}%`;
        ui.modalMeta.hidden = false;
        ui.modalHiddenRow.hidden = true;
        ui.modalHidden.checked = false;
        ui.modalPass.placeholder = isOpen(network.security) ? "Leave empty for open network" : "Enter password";
    } else if (hidden) {
        ui.modalTitle.textContent = "Connect to hidden network";
        ui.modalSsid.value = "";
        ui.modalSsid.readOnly = false;
        ui.modalMeta.hidden = true;
        ui.modalHiddenRow.hidden = false;
        ui.modalHidden.checked = true;
        ui.modalPass.placeholder = "Enter password";
    }

    ui.modalPass.value = "";
    setPassVisibility(false);
    clearModalError();
    ui.modalSubmit.disabled = false;
    ui.modalSubmit.textContent = "Connect";
    ui.modalOverlay.hidden = false;

    // Defer focus until the element is actually visible.
    setTimeout(() => {
        if (network) ui.modalPass.focus();
        else ui.modalSsid.focus();
    }, 0);
}

function closeModal() {
    ui.modalOverlay.hidden = true;
    ui.modalPass.value = "";
    setPassVisibility(false);
    clearModalError();
}

function showModalError(msg) {
    ui.modalErrorMsg.textContent = msg;
    ui.modalError.hidden = false;
}

function clearModalError() {
    ui.modalError.hidden = true;
    ui.modalErrorMsg.textContent = "";
}

function setPassVisibility(show) {
    ui.modalPass.type = show ? "text" : "password";
    ui.modalPassToggle.textContent = show ? "hide" : "show";
    ui.modalPassToggle.setAttribute("aria-label", show ? "Hide password" : "Show password");
}

ui.modalPassToggle.addEventListener("click", () => {
    setPassVisibility(ui.modalPass.type === "password");
});

// Clear a stale error as soon as the user starts fixing the inputs —
// keeps the prompt feeling responsive instead of "yelling" at them.
ui.modalPass.addEventListener("input", clearModalError);
ui.modalSsid.addEventListener("input", clearModalError);

ui.modalCancel.addEventListener("click", closeModal);
ui.modalClose.addEventListener("click", closeModal);
ui.modalOverlay.addEventListener("click", (e) => {
    if (e.target === ui.modalOverlay) closeModal();
});
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !ui.modalOverlay.hidden) closeModal();
});

ui.modalForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const ssid = ui.modalSsid.value.trim();
    const password = ui.modalPass.value;
    const hidden = !ui.modalHiddenRow.hidden && ui.modalHidden.checked;
    if (!ssid) {
        showModalError("SSID is empty.");
        log.warn("modal: ssid is empty");
        return;
    }
    if (!client.connected) {
        showModalError("Not connected to the Pi.");
        log.warn("modal: not connected");
        return;
    }

    log.info("modal: submitting connect", { ssid, hidden, hasPassword: !!password });
    clearModalError();
    ui.modalSubmit.disabled = true;
    ui.modalSubmit.textContent = "Connecting…";

    try {
        await client.connectWifi(ssid, password, hidden);
        log.info("modal: write OK, waiting for connect result notification");
        // The result notification handler (`onResultBytes`) takes it
        // from here: on success it closes the modal, on failure it
        // calls showModalError() and re-arms the Connect button.
        //
        // We keep a watchdog so a totally silent firmware doesn't
        // leave the user staring at "Connecting…" forever.
        setTimeout(() => {
            if (ui.modalSubmit.textContent === "Connecting…" && !ui.modalOverlay.hidden) {
                showModalError("No response from the Pi after 15 seconds. Check the log for details.");
                ui.modalSubmit.disabled = false;
                ui.modalSubmit.textContent = "Connect";
                log.warn("modal: connect watchdog fired — no result notification within 15s");
            }
        }, 15000);
    } catch (err) {
        log.error("modal: connectWifi failed at GATT write", err);
        showModalError(err.message || String(err));
        ui.modalSubmit.disabled = false;
        ui.modalSubmit.textContent = "Connect";
    }
});


// -------- UI state helpers -------- //

function setConnectedUi(connected) {
    // Top-bar badge — still useful as a small persistent indicator
    // once you're in the connected view.
    ui.connState.textContent = connected ? "connected" : "disconnected";
    ui.connState.classList.toggle("badge-on", connected);
    ui.connState.classList.toggle("badge-off", !connected);

    // Hero (disconnected CTA) vs cards (connected view) are mutually
    // exclusive. When disconnected the WiFi/Status/SSH cards are
    // useless, so we hide the whole grid and surface the connect
    // button as the page's primary affordance.
    ui.hero.hidden   = connected;
    ui.layout.hidden = !connected;

    // Disconnect button only shows once we're connected; pre-connect
    // the hero owns the only action.
    ui.btnDisc.hidden   = !connected;
    ui.btnDisc.disabled = !connected;

    ui.btnConnect.disabled = false;
    ui.btnConnect.textContent = "Connect to Pi";

    ui.btnRefresh.disabled = !connected;
    ui.btnScan.disabled = !connected;
    ui.btnRescan.disabled = !connected;
    ui.btnAddHidden.disabled = !connected;
    ui.inSsh.disabled = !connected;

    if (!connected) {
        ui.statusDevice.textContent = "—";
        ui.statusWifi.textContent = "—";
        ui.statusSsid.textContent = "—";
        ui.statusIp.textContent = "—";
        ui.statusSsh.textContent = "—";
        ui.sshLabel.textContent = "unknown";
        ui.ifacesTbody.innerHTML = `<tr><td colspan="4" class="muted">—</td></tr>`;
        ui.wifiList.innerHTML = `<li class="wifi-empty muted">Not scanned yet.</li>`;
        ui.scanCount.textContent = "—";
        if (!ui.modalOverlay.hidden) closeModal();
        lastNotifyAt = 0;
    } else {
        // Treat the first state as fresh so the badge starts green
        // rather than blank.
        markFresh();
        // Clear any leftover error from a previous attempt.
        setHeroStatus("", null);
    }
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
}

// -------- last-update age display -------- //

function fmtAge(ms) {
    if (ms < 1000) return "just now";
    const s = Math.floor(ms / 1000);
    if (s < 60)   return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60)   return `${m}m ${s % 60}s ago`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m ago`;
}

function renderLastUpdate() {
    if (!client.connected || !lastNotifyAt) {
        ui.lastUpdate.textContent = "—";
        ui.lastUpdate.classList.remove("fresh", "stale", "dead");
        return;
    }
    const age = Date.now() - lastNotifyAt;
    ui.lastUpdate.textContent = `last update ${fmtAge(age)}`;
    ui.lastUpdate.classList.toggle("fresh", age < 15_000);
    ui.lastUpdate.classList.toggle("stale", age >= 15_000 && age < 45_000);
    ui.lastUpdate.classList.toggle("dead",  age >= 45_000);
}

setInterval(renderLastUpdate, 500);

setConnectedUi(false);
