// Q2/Q3: five fonts x three styles through the full engine path (layout + fixed SVG + emoji bitmaps), as
// PNGs plus a contact sheet. The sheet embeds the PNGs as data: URIs; that is spike-only, never the template.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-wasm";
import { FONTS, initResvg, outDir, type FontKey, type Style } from "./common";
import { layerSvg, layoutText, measureBbox, rasterise } from "./layout";

await initResvg();
mkdirSync(outDir, { recursive: true });
const text = process.argv[2] ?? "Beach day 🌴✨ with 👩‍👩‍👧 and 👍🏽";
const tag = process.argv[3] ?? "sheet";
const styles: Style[] = ["pill", "outline", "shadow"];
const keys = Object.keys(FONTS) as FontKey[];
const cellW = 940;
const cellH = 190;

let images = "";
keys.forEach((k, r) => {
  styles.forEach((s, c) => {
    const l = layoutText({ text, font: k, baseSize: 56, scale: 1, maxWidth: 1080, measure: measureBbox });
    const layer = layerSvg(l, s);
    const png = rasterise(layer, k);
    writeFileSync(join(outDir, `layer-${tag}-${k}-${s}.png`), png);
    const b64 = Buffer.from(png).toString("base64");
    images += `<image x="${c * cellW + 10}" y="${r * cellH + 20}" width="${layer.width}" height="${layer.height}" href="data:image/png;base64,${b64}"/>`;
  });
});
const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${cellW * 3}" height="${cellH * 5}"><rect width="100%" height="100%" fill="#5b6b8c"/>${images}</svg>`;
const out = new Resvg(sheet).render().asPng();
writeFileSync(join(outDir, `${tag}.png`), out);
console.log("wrote", join(outDir, `${tag}.png`));
