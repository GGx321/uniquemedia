// Q3 probe: which Noto Color Emoji variant does resvg-wasm 2.6.2 actually render? Uses the emoji font alone by family name.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-wasm";
import { cacheDir, initResvg, outDir } from "./common";

await initResvg();
const variants: Record<string, string> = {
  colrv1: join(cacheDir, "src", "Noto-COLRv1.ttf"),
  cbdt: join(cacheDir, "src", "NotoColorEmoji-CBDT.ttf"),
  "gf-colr+svg": join(cacheDir, "src", "NotoColorEmoji-gf.ttf"),
};
for (const [name, path] of Object.entries(variants)) {
  const buf = new Uint8Array(readFileSync(path));
  const t0 = performance.now();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="160"><text x="10" y="120" font-family="Noto Color Emoji" font-size="100">🌴✨👍</text></svg>`;
  const r = new Resvg(svg, { background: "#5b6b8c", font: { fontBuffers: [buf], defaultFontFamily: "Noto Color Emoji" } });
  const png = r.render().asPng();
  const ms = performance.now() - t0;
  writeFileSync(join(outDir, `probe-${name}.png`), png);
  console.log(name, path.split("/").pop(), buf.length, "->", png.length, "B PNG", ms.toFixed(0), "ms incl. font load+render");
}
