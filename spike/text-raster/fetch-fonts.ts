// Downloads the OFL sources into ../../.cache/text-raster/src (gitignored) and prints sha256 + size.
import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const dest = join(import.meta.dir, "..", "..", ".cache", "text-raster", "src");
await mkdir(dest, { recursive: true });

const gf = "https://raw.githubusercontent.com/google/fonts/main/ofl/";
const noto = "https://raw.githubusercontent.com/googlefonts/noto-emoji/main/";
const files: [string, string][] = [
  ["Manrope[wght].ttf", gf + "manrope/Manrope%5Bwght%5D.ttf"],
  ["Manrope-OFL.txt", gf + "manrope/OFL.txt"],
  ["PlayfairDisplay[wght].ttf", gf + "playfairdisplay/PlayfairDisplay%5Bwght%5D.ttf"],
  ["PlayfairDisplay-OFL.txt", gf + "playfairdisplay/OFL.txt"],
  ["Oswald[wght].ttf", gf + "oswald/Oswald%5Bwght%5D.ttf"],
  ["Oswald-OFL.txt", gf + "oswald/OFL.txt"],
  ["PTM55FT.ttf", gf + "ptmono/PTM55FT.ttf"],
  ["PTMono-OFL.txt", gf + "ptmono/OFL.txt"],
  ["Caveat[wght].ttf", gf + "caveat/Caveat%5Bwght%5D.ttf"],
  ["Caveat-OFL.txt", gf + "caveat/OFL.txt"],
  ["NotoColorEmoji-gf.ttf", gf + "notocoloremoji/NotoColorEmoji-Regular.ttf"],
  ["NotoEmoji-OFL.txt", gf + "notocoloremoji/OFL.txt"],
  ["Noto-COLRv1.ttf", noto + "v2.051/fonts/Noto-COLRv1.ttf"],
  ["NotoColorEmoji-CBDT.ttf", noto + "v2.051/fonts/NotoColorEmoji.ttf"],
];
for (const [name, url] of files) {
  const r = await fetch(url);
  if (!r.ok) {
    console.log("FAIL", name, r.status, url);
    continue;
  }
  const buf = new Uint8Array(await r.arrayBuffer());
  await Bun.write(join(dest, name), buf);
  const sha = createHash("sha256").update(buf).digest("hex").slice(0, 16);
  console.log(name.padEnd(30), String(buf.length).padStart(9), sha);
}
