// Entry point of the Android app bundle (see build.mjs).
//
// Order matters: native-setup.js must register the native BLE
// transport before web/app.js constructs its PiBleClient. ES modules
// evaluate in import order, so keep these two lines as they are.
import "./native-setup.js";
import "../../web/app.js";
