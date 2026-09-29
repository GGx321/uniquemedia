// Follow-up on the timeline outputs (run timeline.ts first): every final encode compared with
// the LOSSLESS concat of the same clips, to separate "encoder noise" from "intermediate loss".
// Also prints the «Авто» concurrency formula for the machines named in the task.
// Usage: bun spike/render-bench/extra.ts
import { join } from "node:path";
import { totalmem, cpus } from "node:os";
import { ff, OUT, saveResult } from "./common";

const dir = join(OUT, "tl-zp4");

async function compare(a: string, b: string) {
  const r1 = await ff(["-i", a, "-i", b, "-lavfi", "[0:v][1:v]ssim", "-f", "null", "-"]);
  const r2 = await ff(["-i", a, "-i", b, "-lavfi", "[0:v][1:v]psnr", "-f", "null", "-"]);
  return {
    ssim: Number(/All:([\d.]+)/.exec(r1.stderr)?.[1]),
    psnr: Number(/average:([\d.]+)/.exec(r2.stderr)?.[1]),
  };
}

const lossless = join(dir, "qp0-concat.mkv");
const finals: Record<string, string> = {
  "single graph, medium": join(dir, "single-medium.mp4"),
  "two-pass qp0, medium": join(dir, "two-qp0-medium.mp4"),
  "two-pass crf8, medium": join(dir, "two-crf8-medium.mp4"),
  "two-pass crf10, medium": join(dir, "two-crf10-medium.mp4"),
};
const out: Record<string, unknown> = {};
for (const [k, f] of Object.entries(finals)) {
  out[k] = await compare(f, lossless);
  console.log(k.padEnd(26), JSON.stringify(out[k]));
}

// «Авто»: min(clamp(floor((cores-1)/2),1,4), max(1, floor(0.25*totalmem/peakRSS)))
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const auto = (cores: number, mem: number, peak: number) =>
  Math.min(Math.min(4, Math.max(1, Math.floor((cores - 1) / 2))), Math.max(1, Math.floor((0.25 * mem) / peak)));
const table: Record<string, unknown>[] = [];
for (const peak of [768 * MiB]) {
  for (const [name, cores, mem] of [
    ["this Mac", cpus().length, totalmem()],
    ["16 GB, 8 cores", 8, 16 * GiB],
    ["16 GB, 4 cores", 4, 16 * GiB],
    ["8 GB, 8 cores", 8, 8 * GiB],
    ["8 GB, 4 cores", 4, 8 * GiB],
  ] as const) {
    table.push({
      machine: name, cores, ramGiB: +(mem / GiB).toFixed(1), peakRssMiB: peak / MiB,
      coresTerm: Math.min(4, Math.max(1, Math.floor((cores - 1) / 2))),
      ramTerm: Math.max(1, Math.floor((0.25 * mem) / peak)),
      auto: auto(cores, mem, peak),
    });
  }
}
console.table(table);
saveResult("finals-vs-lossless", { finals: out, autoFormula: table });
