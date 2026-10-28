// Builds the Capacitor web assets into ./www from the shared ../web
// sources:
//   * index.html  — copied, with the module entry pointed at bundle.js
//   * styles.css  — copied verbatim
//   * bundle.js   — esbuild bundle of src/main.js (native setup + the
//                   unchanged web app + Capacitor plugins)
//
// Everything ends up inside the APK; the app never fetches anything
// over the network.

import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web  = join(here, "..", "web");
const out  = join(here, "www");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const html = readFileSync(join(web, "index.html"), "utf8");
const needle = '<script type="module" src="./app.js"></script>';
if (!html.includes(needle)) {
    throw new Error(`web/index.html: expected to find ${needle}`);
}
writeFileSync(
    join(out, "index.html"),
    html.replace(needle, '<script type="module" src="./bundle.js"></script>'),
);
cpSync(join(web, "styles.css"), join(out, "styles.css"));

await build({
    entryPoints: [join(here, "src", "main.js")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2020"],
    outfile: join(out, "bundle.js"),
    sourcemap: false,
    minify: false,
    logLevel: "info",
});

console.log(`built ${out}`);
