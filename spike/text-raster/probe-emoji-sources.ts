// Probes where Noto Color Emoji CBDT / COLRv1 binaries can be fetched, and prints the sfnt tables of the local copy.
import { join } from "node:path";

const root = "https://raw.githubusercontent.com/googlefonts/noto-emoji/";
for (const t of ["v2.047", "v2.048", "v2.051", "main"]) {
  for (const f of ["NotoColorEmoji.ttf", "Noto-COLRv1.ttf", "NotoColorEmoji-emojicompat.ttf"]) {
    const r = await fetch(`${root}${t}/fonts/${f}`, { method: "HEAD" });
    console.log(t, f, r.status, r.headers.get("content-length"));
  }
}

export function tables(buf: Uint8Array): string[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = dv.getUint16(4);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const o = 12 + 16 * i;
    out.push(new TextDecoder().decode(buf.subarray(o, o + 4)) + ":" + dv.getUint32(o + 12));
  }
  return out;
}
if (import.meta.main) {
  const p = join(import.meta.dir, "..", "..", ".cache", "text-raster", "src", "NotoColorEmoji-gf.ttf");
  console.log(tables(new Uint8Array(await Bun.file(p).arrayBuffer())).join(" "));
}
