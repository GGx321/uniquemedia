// Instances the variable OFL fonts to the static weights the plan fixes, via fontTools' instancer (uvx).
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const cache = join(import.meta.dir, "..", "..", ".cache", "text-raster");
const src = join(cache, "src");
const out = join(cache, "fonts");
await mkdir(out, { recursive: true });

const specs: [string, number][] = [
  ["Manrope", 800],
  ["PlayfairDisplay", 600],
  ["Oswald", 600],
  ["Caveat", 600],
];
for (const [name, wght] of specs) {
  const dst = join(out, `${name}-${wght}.ttf`);
  const p = Bun.spawn(
    ["uvx", "--from", "fonttools", "fonttools", "varLib.instancer", join(src, `${name}[wght].ttf`), `wght=${wght}`, "-o", dst],
    { stdout: "inherit", stderr: "inherit" },
  );
  const code = await p.exited;
  console.log(name, wght, "exit", code, Bun.file(dst).size, "bytes");
}
await copyFile(join(src, "PTM55FT.ttf"), join(out, "PTMono-400.ttf"));
console.log("PTMono-400", Bun.file(join(out, "PTMono-400.ttf")).size, "bytes");
