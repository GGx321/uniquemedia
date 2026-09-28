// Q1 (optional): the resvg .wasm and a font read from INSIDE an app.asar by Electron's patched fs, then rendered.
// Usage: bun asar-test.ts   (packs the assets, then runs the bundled reader under ELECTRON_RUN_AS_NODE=1 electron)
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const stage = join(root, ".cache", "text-raster", "asar-stage");
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "assets"), { recursive: true });
copyFileSync(join(import.meta.dir, "node_modules", "@resvg", "resvg-wasm", "index_bg.wasm"), join(stage, "assets", "index_bg.wasm"));
copyFileSync(join(root, ".cache", "text-raster", "fonts", "Manrope-800.ttf"), join(stage, "assets", "Manrope-800.ttf"));
// The reader is bundled with its resvg JS glue and placed in the stage, as electron-vite would.
const reader = join(import.meta.dir, "asar-reader.ts");
const build = Bun.spawnSync(["bun", "build", reader, "--target=node", "--format=esm", "--outfile", join(stage, "reader.mjs")], { cwd: import.meta.dir });
if (build.exitCode !== 0) throw new Error(build.stderr.toString());
const pack = Bun.spawnSync(["bunx", "@electron/asar", "pack", stage, join(root, ".cache", "text-raster", "app.asar")]);
if (pack.exitCode !== 0) throw new Error(pack.stderr.toString());
const electron = join(root, "node_modules", ".bin", "electron");
const asar = join(root, ".cache", "text-raster", "app.asar");
for (const dir of [stage, asar]) {
  const p = Bun.spawnSync([electron, join(dir, "reader.mjs"), dir], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
  console.log(p.exitCode === 0 ? p.stdout.toString().trim() : "FAILED: " + p.stderr.toString().slice(0, 400));
}
