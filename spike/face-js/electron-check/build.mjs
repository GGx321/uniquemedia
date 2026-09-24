/**
 * Bundles electron-check/renderer.ts for the browser: bun run spike/face-js/electron-check/build.mjs
 *
 * Every "onnxruntime-web" import (renderer.ts and lib/*.ts) is pointed at dist/ort.wasm.min.mjs:
 * the CPU-only WASM build (no WebGPU/JSEP, so it loads the 14 MB ort-wasm-simd-threaded.wasm
 * instead of the 28 MB jsep one) that loads its glue from env.wasm.wasmPaths. The default
 * bundle builds start their pthread workers from import.meta.url, i.e. from this whole bundle,
 * which breaks inside the worker and hangs a multi-threaded session.
 */
import { join } from "node:path";

const ROOT = process.cwd();
const ORT = join(ROOT, "node_modules/onnxruntime-web/dist/ort.wasm.min.mjs");

const result = await Bun.build({
  entrypoints: [join(ROOT, "spike/face-js/electron-check/renderer.ts")],
  outdir: join(ROOT, "spike/face-js/out/electron-check"),
  target: "browser",
  plugins: [
    {
      name: "ort-wasm-only",
      setup(build) {
        build.onResolve({ filter: /^onnxruntime-web$/ }, () => ({ path: ORT }));
      },
    },
  ],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
for (const out of result.outputs) console.log(`${out.path} ${(out.size / 1024).toFixed(0)} KiB`);
