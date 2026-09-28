// Q6: raw and deflate-9 sizes of everything that would ship for text.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { cacheDir } from "./common";

const files: [string, string][] = [
  ["resvg-wasm index_bg.wasm", join(import.meta.dir, "node_modules", "@resvg", "resvg-wasm", "index_bg.wasm")],
  ...readdirSync(join(cacheDir, "fonts")).map((f): [string, string] => [f, join(cacheDir, "fonts", f)]),
  ["NotoColorEmoji-CBDT.ttf (v2.051)", join(cacheDir, "src", "NotoColorEmoji-CBDT.ttf")],
  ["Noto-COLRv1.ttf (v2.051, not usable)", join(cacheDir, "src", "Noto-COLRv1.ttf")],
];
let raw = 0;
let gz = 0;
for (const [name, p] of files) {
  const b = readFileSync(p);
  const z = gzipSync(b, { level: 9 }).length;
  console.log(name.padEnd(40), String(b.length).padStart(10), String(z).padStart(10));
  if (!name.includes("COLRv1")) {
    raw += b.length;
    gz += z;
  }
}
const mib = (n: number): string => (n / 1048576).toFixed(2) + " MiB";
console.log("TOTAL shipped (excl. COLRv1)".padEnd(40), String(raw).padStart(10), String(gz).padStart(10), `=> ${mib(raw)} raw, ~${mib(gz)} compressed`);
