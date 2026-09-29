// Q1b: time per 4 s clip and PEAK RSS of the ffmpeg process, per technique and clip kind.
// Pass-1 shape: graph -> x264 CRF 8 ultrafast, -threads 2, mkv (the plan's intermediate).
// Usage: bun spike/render-bench/clips.ts [outName] [runs]
import { bench, ff, OUT, PHOTOS, saveResult, machine, frameCount } from "./common";
import { pass1Args, INTERS, type ClipSpec, type Tech, type Kind, type Motion } from "./graphs";
import { loadavg } from "node:os";

const outName = process.argv[2] ?? "clips";
const RUNS = Number(process.argv[3] ?? 3);

const KB: Tech[] = ["zp1", "zp2", "zp4", "sc2", "sc4"];
const PAN: Tech[] = ["zp1", "zp2", "zp4", "cv2e", "cv4e"];
const CASES: [Kind, Motion, Tech[]][] = [
  ["photo", "kb", KB],
  ["photo", "pan", PAN],
  ["collage2", "kb", KB],
  ["collage3", "kb", KB],
  ["collage4", "kb", KB],
  ["collage4", "pan", PAN],
];
const NCELLS = { photo: 1, collage2: 2, collage3: 3, collage4: 4 } as const;

// CAPS=1 adds -filter_threads 2 -filter_complex_threads 2; TECHS=zp4,zp2 restricts the set.
const CAPS = process.env.CAPS === "1" ? ["-filter_threads", "2", "-filter_complex_threads", "2"] : [];
const ONLY = process.env.TECHS?.split(",");
const rows: Record<string, unknown>[] = [];
const started = { ...machine(), caps: CAPS.join(" ") || "none" };
for (const [kind, motion, allTechs] of CASES) {
  for (const tech of allTechs.filter((t) => !ONLY || ONLY.includes(t))) {
    const photos = Array.from({ length: NCELLS[kind] }, (_, i) => PHOTOS[i % PHOTOS.length]!);
    const spec: ClipSpec = { kind, seconds: 4, motion, photos, stagger: kind !== "photo", dir: 1 };
    const out = `${OUT}/clip-${outName}-${kind}-${motion}-${tech}.mkv`;
    const r = await bench(RUNS, () => ff([...CAPS, ...pass1Args(spec, tech, out, INTERS[1]!)]));
    const frames = await frameCount(out);
    const row = { kind, motion, tech, frames, ...r };
    rows.push(row);
    console.log(kind.padEnd(9), motion.padEnd(4), tech.padEnd(5), JSON.stringify(row));
  }
}
saveResult(outName, { machine: started, loadavgEnd: loadavg().map((x) => Math.round(x * 10) / 10), runs: RUNS, rows });
