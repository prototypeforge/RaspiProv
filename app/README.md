# RaspiProv for Android

The same client as [`web/`](../web/), packaged as a native Android app
with [Capacitor](https://capacitorjs.com/). It talks to the Pi over the
phone's Bluetooth radio and needs **no internet connection, ever**:

- every HTML/CSS/JS byte ships inside the APK (`www/` is bundled, no CDN,
  no fonts, no analytics);
- the Pi is reached over BLE only;
- the app does not even hold the `INTERNET` permission, so it *cannot*
  open a network socket.

## How it fits together

```
web/            shared UI + protocol (unchanged, still works in Chrome)
 ├─ ble.js      PiBleClient + transport interface + WebBluetoothTransport
 ├─ app.js      UI
 └─ ...
app/
 ├─ src/
 │   ├─ capacitor-transport.js   native BLE transport (@capacitor-community/bluetooth-le)
 │   ├─ native-setup.js          registers that transport, adds log sharing
 │   └─ main.js                  entry: native-setup.js first, then ../../web/app.js
 ├─ build.mjs                    web/ -> www/ (copies index.html + styles.css, esbuild-bundles main.js)
 ├─ capacitor.config.json
 └─ android/                     the native project (committed; edit it like any Android app)
```

Android's WebView does not expose Web Bluetooth, so `web/ble.js` was
split into the protocol client and a small *transport* behind it. The
browser keeps using `WebBluetoothTransport`; the app registers
`CapacitorBleTransport` before the UI module evaluates, and everything
above that line — scan streaming, status notifications, the password
modal — is the exact same code.

## Build it

Requirements: Node 22+, JDK 21, Android SDK (platform 36 + build-tools;
Android Studio installs these for you).

```bash
cd app
npm ci
npm run build            # web/ -> www/
npx cap sync android     # www/ + plugins -> android/
cd android && ./gradlew assembleDebug
# -> android/app/build/outputs/apk/debug/app-debug.apk
```

or, all in one: `npm run apk`. `npm test` runs the transport-agnostic
tests of the BLE client (`test/`) under plain Node. `npm run open` launches Android Studio on
the project if you prefer building/installing from there.

Install on a phone with `adb install -r app-debug.apk` (enable *USB
debugging*) or copy the file over and open it (allow *Install unknown
apps* for your file manager).

There is also a GitHub Actions workflow
([`.github/workflows/android.yml`](../.github/workflows/android.yml))
that builds the debug APK on every push touching `web/` or `app/`, keeps
it as a workflow artifact, and attaches it to the release on `v*` tags.

### Release builds

`assembleDebug` produces an APK signed with the Android debug key, which
is fine for sideloading. For a Play Store / long-lived build create a
keystore, add a `signingConfigs.release` block to
`android/app/build.gradle`, and run `./gradlew assembleRelease` (or
`bundleRelease`). The usual
[Android docs](https://developer.android.com/studio/publish/app-signing)
apply; nothing in this project is special.

## Using the app

1. Tap **Connect to Pi**. The first time, Android asks for the *Nearby
   devices* permission (Android 12+) or *Location* (Android 11 and
   older — the OS gates BLE scanning behind it; the app never reads your
   location). If Bluetooth is off you get the system "turn on" prompt.
2. A chooser lists devices advertising the `pi-ble-config` service.
   Pick `PiCfg-<hostname>-<XXXX>`.
3. From here on it is the web UI: status, interfaces, Wi-Fi scan, join,
   SSH toggle, and the log panel. **Download** in the log card opens the
   share sheet (save to Files, send by mail, ...) instead of a browser
   download.

## Permissions, exactly

| Permission                      | Why                                              |
|---------------------------------|--------------------------------------------------|
| `BLUETOOTH_SCAN` (12+)          | find the Pi; flagged `neverForLocation`           |
| `BLUETOOTH_CONNECT` (12+)       | connect / read / write GATT                       |
| `BLUETOOTH`, `BLUETOOTH_ADMIN`  | the same, on Android 11 and older                 |
| `ACCESS_*_LOCATION` (≤ 11 only) | Android ≤ 11 refuses to BLE-scan without it       |

No `INTERNET`, no storage, no camera. The log export writes to the app's
own cache directory and hands the file to the share sheet via a
`FileProvider`.

## Changing things

- **App id / name**: `appId` and `appName` in `capacitor.config.json`
  were used when the Android project was generated. Changing them later
  means editing `android/app/build.gradle` (`namespace`,
  `applicationId`), `strings.xml`, and moving `MainActivity.java` to the
  new package — or deleting `android/` and running `npx cap add android`
  again, then re-applying the manifest permissions and icons.
- **Icons / splash**: PNGs under `android/app/src/main/res/mipmap-*` and
  `drawable-*`. Replace them with your own (same sizes), e.g. via
  `@capacitor/assets`.
- **The UI**: edit `web/` — then `npm run build && npx cap sync android`
  and rebuild. Nothing in `app/src/` needs to change unless you touch the
  transport contract documented at the top of `web/ble.js`.
- **Live reload** (`npx cap run android --livereload`) needs the
  `INTERNET` permission, which was deliberately removed from
  `android/app/src/main/AndroidManifest.xml`. Put it back temporarily if
  you want that workflow.

## Troubleshooting

- **The chooser is empty.** Bluetooth on? On Android ≤ 11, Location
  services on? Is the Pi actually advertising
  (`sudo systemctl status pi-ble-config` → "advertising as 'PiCfg-…'")?
  Another central (your PC's browser tab, an earlier app instance) may
  still be connected — a BLE peripheral only takes one connection.
- **Permission denied / chooser never appears.** You declined the
  permission prompt once; Android stops asking. Settings → Apps →
  RaspiProv → Permissions → allow *Nearby devices* (or *Location* on old
  versions).
- **Notifications truncated / "Unexpected end of JSON".** The plugin
  negotiates MTU 512 on connect and the log prints the result
  (`capacitor-ble: MTU …`). Anything under ~100 means the phone's stack
  refused — reconnecting usually fixes it.
- **Everything else**: the Log card is the same transcript as on the
  web; `Download` → share → attach it to an issue.
