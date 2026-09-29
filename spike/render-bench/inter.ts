// Q3: pass-1 intermediate settings on 4 s clips: file size, time, peak RSS (median of 3),
// x264 preset ultrafast (the plan's), technique zp4.
// Usage: bun spike/render-bench/inter.ts [runs=3]
import { bench, ff, OUT, PHOTOS, saveResult, sizeMB, machine } from "./common";
import { pass1Args, INTERS, type ClipSpec } from "./graphs";

const RUNS = Number(process.argv[2] ?? 3);
const specs: [string, ClipSpec][] = [
  ["photo kb", { kind: "photo", seconds: 4, motion: "kb", photos: [PHOTOS[0]!], stagger: false }],
  ["photo pan", { kind: "photo", seconds: 4, motion: "pan", photos: [PHOTOS[1]!], stagger: false }],
  ["collage3 kb+stagger", { kind: "collage3", seconds: 4, motion: "kb", photos: PHOTOS, stagger: true }],
  ["collage4 kb+stagger", { kind: "collage4", seconds: 4, motion: "kb", photos: [...PHOTOS, PHOTOS[0]!], stagger: true }],
];
const rows: Record<string, unknown>[] = [];
for (const [name, spec] of specs) {
  for (const inter of INTERS) {
    const out = `${OUT}/inter-${name.replace(/\W+/g, "-")}-${inter.name}.mkv`;
    const r = await bench(RUNS, () => ff(pass1Args(spec, "zp4", out, inter)));
    const row = { clip: name, inter: inter.name, sizeMB: +sizeMB(out).toFixed(1), ...r };
    rows.push(row);
    console.log(JSON.stringify(row));
  }
}
saveResult("inter", { machine: machine(), runs: RUNS, rows });
