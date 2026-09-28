// Q1: does resvg-wasm load from a .wasm on disk and render, in this runtime?
import { buildSvg, FONTS, initResvg, outDir, render, sha, type FontKey } from "./common";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const runtime = process.versions.electron ? `electron-node ${process.version}` : process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}`;
const tag = process.versions.electron ? "electron" : "bun";
mkdirSync(outDir, { recursive: true });

const init = await initResvg();
console.log(`[${runtime}] wasm ${init.wasmBytes} bytes, read+compile+init ${init.initMs.toFixed(1)} ms`);

for (const key of Object.keys(FONTS) as FontKey[]) {
  const svg = buildSvg({ lines: ["Hello, Studio 2026"], font: key, style: "pill", fontSize: 64, width: 900, height: 200 });
  const t0 = performance.now();
  const r = render(svg, key, "none");
  const ms = performance.now() - t0;
  writeFileSync(join(outDir, `smoke-${tag}-${key}.png`), r.png);
  console.log(`[${tag}] ${key.padEnd(8)} ${r.w}x${r.h} ${r.png.length} B sha ${await sha(r.png)} ${ms.toFixed(1)} ms`);
}
