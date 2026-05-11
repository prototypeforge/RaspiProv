// Logger: timestamped, levelled, rendered into #log-panel and mirrored to
// the browser devtools console. Keep this file framework-free.
//
// Usage:
//   import { log } from "./logger.js";
//   log.info("connecting", { deviceId });
//   log.debug("raw bytes", bytes);
//   log.error("write failed", err);

const LEVELS = ["debug", "info", "warn", "error"];
const LEVEL_COLOR = {
    debug: "#7a8a99",
    info:  "#7ec7ff",
    warn:  "#ffcc66",
    error: "#ff6b6b",
};

class Logger {
    constructor() {
        /** @type {{ts:string, level:string, msg:string, extra:any}[]} */
        this.entries = [];
        this.panel = null;
        this.minLevel = "debug";
        this.maxRendered = 2000;       // cap DOM growth
        this._mirror = true;
    }

    attach(panel) {
        this.panel = panel;
        // Render anything that was logged before the panel mounted.
        // _render prepends, so iterating in order naturally yields
        // oldest-at-bottom / newest-at-top.
        for (const e of this.entries) this._render(e);
    }

    setLevel(level) {
        if (LEVELS.includes(level)) this.minLevel = level;
    }

    _shouldLog(level) {
        return LEVELS.indexOf(level) >= LEVELS.indexOf(this.minLevel);
    }

    _stamp() {
        const d = new Date();
        const pad = (n, w = 2) => String(n).padStart(w, "0");
        return (
            pad(d.getHours()) + ":" +
            pad(d.getMinutes()) + ":" +
            pad(d.getSeconds()) + "." +
            pad(d.getMilliseconds(), 3)
        );
    }

    _record(level, msg, extra) {
        const entry = { ts: this._stamp(), level, msg: String(msg), extra };
        this.entries.push(entry);
        if (this._mirror) {
            const fn = console[level] || console.log;
            if (extra !== undefined) fn.call(console, `[${entry.ts}] ${msg}`, extra);
            else fn.call(console, `[${entry.ts}] ${msg}`);
        }
        if (this.panel && this._shouldLog(level)) this._render(entry);
    }

    _render(entry) {
        const row = document.createElement("div");
        row.className = `log-row log-${entry.level}`;
        row.style.color = LEVEL_COLOR[entry.level] || "inherit";

        const ts = document.createElement("span");
        ts.className = "log-ts";
        ts.textContent = entry.ts;

        const lvl = document.createElement("span");
        lvl.className = "log-lvl";
        lvl.textContent = entry.level.toUpperCase().padEnd(5);

        const msg = document.createElement("span");
        msg.className = "log-msg";
        msg.textContent = entry.msg;

        row.append(ts, " ", lvl, " ", msg);

        if (entry.extra !== undefined) {
            const extra = document.createElement("pre");
            extra.className = "log-extra";
            extra.textContent = formatExtra(entry.extra);
            row.appendChild(extra);
        }

        // Newest entries on top. Insert before the current first child;
        // we only snap-scroll back to the top if the user is already
        // near it, so scrolling down to read older entries isn't
        // disrupted by new ones arriving.
        const nearTop = this.panel.scrollTop < 80;
        this.panel.insertBefore(row, this.panel.firstChild);
        if (nearTop) this.panel.scrollTop = 0;

        // Keep DOM bounded by trimming the oldest entries — now at the
        // bottom of the panel rather than the top.
        while (this.panel.childElementCount > this.maxRendered) {
            this.panel.removeChild(this.panel.lastElementChild);
        }
    }

    debug(msg, extra) { this._record("debug", msg, extra); }
    info(msg, extra)  { this._record("info",  msg, extra); }
    warn(msg, extra)  { this._record("warn",  msg, extra); }
    error(msg, extra) { this._record("error", msg, extra); }

    clear() {
        this.entries = [];
        if (this.panel) this.panel.innerHTML = "";
    }

    download() {
        const lines = this.entries.map(e => {
            const base = `[${e.ts}] ${e.level.toUpperCase().padEnd(5)} ${e.msg}`;
            return e.extra !== undefined
                ? base + " | " + formatExtra(e.extra).replace(/\n/g, " ")
                : base;
        });
        const blob = new Blob([lines.join("\n") + "\n"], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `pi-ble-config-${Date.now()}.log`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }
}

function formatExtra(extra) {
    if (extra instanceof Error) {
        return `${extra.name}: ${extra.message}\n${extra.stack || ""}`;
    }
    if (extra instanceof ArrayBuffer || ArrayBuffer.isView(extra)) {
        const bytes = extra instanceof ArrayBuffer
            ? new Uint8Array(extra)
            : new Uint8Array(extra.buffer, extra.byteOffset, extra.byteLength);
        const hex = Array.from(bytes)
            .map(b => b.toString(16).padStart(2, "0"))
            .join(" ");
        let ascii = "";
        try { ascii = new TextDecoder("utf-8", { fatal: false }).decode(bytes); }
        catch { /* not utf-8 */ }
        return `bytes(${bytes.length}) hex: ${hex}${ascii ? `\nascii: ${ascii}` : ""}`;
    }
    if (typeof extra === "object") {
        try { return JSON.stringify(extra, null, 2); }
        catch { return String(extra); }
    }
    return String(extra);
}

export const log = new Logger();
