// Bundled by asar-test.ts and run from a plain directory and from inside an app.asar.
import { readFileSync } from "node:fs";
import { initWasm, Resvg } from "@resvg/resvg-wasm";

const dir = process.argv[2]!;
const t0 = performance.now();
await initWasm(await WebAssembly.compile(readFileSync(dir + "/assets/index_bg.wasm")));
const font = new Uint8Array(readFileSync(dir + "/assets/Manrope-800.ttf"));
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100"><text x="10" y="70" font-family="Manrope" font-weight="800" font-size="60">asar ok</text></svg>';
const png = new Resvg(svg, { font: { fontBuffers: [font], defaultFontFamily: "Manrope" } }).render().asPng();
console.log(`read from ${dir}: wasm+font ok, png ${png.length} B, ${(performance.now() - t0).toFixed(0)} ms`);
