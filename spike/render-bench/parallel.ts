// Q6 support: N concurrent worst-case renders (the render pool), with and without filter
// thread caps. Reports wall time for the batch, per-process peak RSS, and the sum.
// Worst-case pass-1 clip = collage4 kb+stagger zp4; worst pass-2 = the 15 s mixed timeline.
// Usage: bun spike/render-bench/parallel.ts [runs=3]
import { join } from "node:path";
import { loadavg, cpus } from "node:os";
import { ff, OUT, PHOTOS, median, saveResult, machine, type Run } from "./common";
import { pass1Args, INTERS, type ClipSpec } from "./graphs";

const RUNS = Number(process.argv[3] ?? process.argv[2] ?? 3);
const spec: ClipSpec = { kind: "collage4", seconds: 4, motion: "kb", photos: [...PHOTOS, PHOTOS[0]!], stagger: true };
const caps: [string, string[]][] = [
  ["default threads", []],
  ["-filter_threads 2 -filter_complex_threads 2", ["-filter_threads", "2", "-filter_complex_threads", "2"]],
];

const rows: Record<string, unknown>[] = [];
for (const [label, extra] of caps) {
  for (const n of [1, 2, 4]) {
    const walls: number[] = [];
    const single: number[] = [];
    const rss: number[] = [];
    const sums: number[] = [];
    for (let r = 0; r < RUNS; r++) {
      const t0 = performance.now();
      const runs: Run[] = await Promise.all(
        Array.from({ length: n }, (_, i) => ff([...extra, ...pass1Args(spec, "zp4", join(OUT, `par-${i}.mkv`), INTERS[1]!)])),
      );
      walls.push(performance.now() - t0);
      single.push(median(runs.map((x) => x.ms)));
      rss.push(Math.max(...runs.map((x) => x.rssMB)));
      sums.push(runs.reduce((a, x) => a + x.rssMB, 0));
    }
    const row = {
      caps: label, parallel: n,
      batchWallMs: Math.round(median(walls)), perProcessMs: Math.round(median(single)),
      perProcessPeakRssMB: Math.round(Math.max(...rss)), sumRssMB: Math.round(median(sums)),
      load1: Math.round(loadavg()[0]! * 10) / 10,
    };
    rows.push(row);
    console.log(JSON.stringify(row));
  }
}
saveResult("parallel", { machine: machine(), cores: cpus().length, runs: RUNS, rows });
