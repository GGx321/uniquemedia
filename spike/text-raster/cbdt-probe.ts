import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cacheDir, outDir } from "./common";
import { readCbdt } from "./cbdt";

const e = readCbdt(new Uint8Array(readFileSync(join(cacheDir, "src", "NotoColorEmoji-CBDT.ttf"))));
console.log("bitmap glyphs", e.count, "png bytes total", e.totalPngBytes, "ppem", e.ppem);
const cases: Record<string, number[]> = {
  palm: [0x1f334],
  sparkles: [0x2728],
  thumbsMedium: [0x1f44d, 0x1f3fd],
  family: [0x1f469, 0x200d, 0x1f469, 0x200d, 0x1f467].filter((c) => c !== 0x200d),
  flagUA: [0x1f1fa, 0x1f1e6],
  keycap1: [0x31, 0x20e3],
  heartVS: [0x2764, 0xfe0f],
  youthBaby: [0x1f476],
};
for (const [k, cps] of Object.entries(cases)) {
  // sequences are stored by name with ZWJ (200D) kept, so retry with it for the family
  const withZwj = k === "family" ? [0x1f469, 0x200d, 0x1f469, 0x200d, 0x1f467] : cps;
  const png = e.get(withZwj);
  console.log(k.padEnd(12), png ? `${png.length} B, ${new DataView(png.buffer, png.byteOffset).getUint32(16)}x${new DataView(png.buffer, png.byteOffset).getUint32(20)}` : "MISSING");
  if (png && k === "family") writeFileSync(join(outDir, "cbdt-family.png"), png);
}
