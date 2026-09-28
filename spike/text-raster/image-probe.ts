// Probe: how does resvg-wasm 2.6.2 want external images supplied?
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-wasm";
import { initResvg, outDir } from "./common";
import { emojiSet } from "./layout";

await initResvg();
const png = emojiSet().get([0x1f334])!;
for (const href of ["emoji:0", "e0", "palm.png"]) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><image x="10" y="10" width="136" height="128" href="${href}"/></svg>`;
  const r = new Resvg(svg, { background: "#5b6b8c" });
  console.log(href, "toResolve:", JSON.stringify(r.imagesToResolve()));
  r.resolveImage(href, png);
  const out = r.render().asPng();
  console.log("  png bytes", out.length);
  writeFileSync(join(outDir, `imgprobe-${href.replace(/\W/g, "_")}.png`), out);
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="200"><image x="10" y="10" width="136" height="128" xlink:href="data:image/png;base64,${Buffer.from(png).toString("base64")}"/></svg>`;
console.log("data-uri png bytes", new Resvg(svg, { background: "#5b6b8c" }).render().asPng().length);
