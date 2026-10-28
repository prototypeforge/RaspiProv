// Runs before web/app.js (main.js imports this module first, and ES
// modules evaluate in import order). It swaps the default BLE transport
// for the native one and adapts the few browser-only bits of the UI.

import { Capacitor } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { setDefaultTransport } from "../../web/ble.js";
import { log } from "../../web/logger.js";
import { CapacitorBleTransport } from "./capacitor-transport.js";

if (Capacitor.isNativePlatform()) {
    setDefaultTransport(() => new CapacitorBleTransport());
    document.documentElement.classList.add("native-app");

    // The WebView has no "download" affordance: write the log to the
    // app's cache dir and hand it to the system share sheet instead
    // (save to Files, send by mail, ...). Stays on-device unless the
    // user picks a target that isn't.
    log.downloader = async (text, filename) => {
        const { uri } = await Filesystem.writeFile({
            path: filename,
            data: text,
            directory: Directory.Cache,
            encoding: Encoding.UTF8,
        });
        await Share.share({
            title: filename,
            dialogTitle: "Save or share the session log",
            files: [uri],
        });
    };

    log.info(`running natively on ${Capacitor.getPlatform()}`);
}
