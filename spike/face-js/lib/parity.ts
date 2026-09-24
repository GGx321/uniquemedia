import { readFile } from "node:fs/promises";
import { z } from "zod";

/** One row of spike/studio-api/out/face.json (written by face.py). */
const PyEntry = z.object({
  faces: z.number().int(),
  headRatio: z.number().nullable(),
  cosMaster: z.number().nullable(),
  cosFront: z.number().nullable(),
});
const PyFile = z.record(z.string(), PyEntry);
export type PyResults = z.infer<typeof PyFile>;

export interface JsEntry {
  faces: number;
  headRatio: number | null;
  cosMaster: number | null;
  cosFront: number | null;
}

export async function readPyResults(path: string): Promise<PyResults> {
  const parsed = PyFile.safeParse(JSON.parse(await readFile(path, "utf8")));
  if (!parsed.success) throw new Error(`${path}: ${parsed.error.message.slice(0, 300)}`);
  return parsed.data;
}

/** The `images` map of a face-js*.json written by run.ts or the Electron check. */
const JsFile = z.object({ images: z.record(z.string(), PyEntry) });

export async function readJsResults(path: string): Promise<Record<string, JsEntry>> {
  const parsed = JsFile.safeParse(JSON.parse(await readFile(path, "utf8")));
  if (!parsed.success) throw new Error(`${path}: ${parsed.error.message.slice(0, 300)}`);
  return parsed.data.images;
}

export const THRESHOLD = 0.7;
const DIFFERENT_PEOPLE = ["avatar/candidate-1.jpg", "avatar/candidate-2.jpg", "avatar/candidate-3.jpg"];

interface DiffStats {
  n: number;
  max: number;
  maxKey: string;
  mean: number;
  worst: Array<{ key: string; py: number; js: number; diff: number }>;
}

function diffStats(keys: string[], py: PyResults, js: Record<string, JsEntry>, field: "cosMaster" | "cosFront" | "headRatio"): DiffStats {
  const rows: Array<{ key: string; py: number; js: number; diff: number }> = [];
  for (const key of keys) {
    const p = py[key][field];
    const j = js[key][field];
    if (p === null || j === null) continue;
    // A reference compared with itself (or a byte-identical copy) is 1.0 on both sides by construction.
    if (field !== "headRatio" && p === 1) continue;
    rows.push({ key, py: p, js: round(j, 4), diff: Math.abs(j - p) });
  }
  rows.sort((a, b) => b.diff - a.diff);
  const mean = rows.reduce((s, r) => s + r.diff, 0) / Math.max(rows.length, 1);
  return { n: rows.length, max: rows[0]?.diff ?? 0, maxKey: rows[0]?.key ?? "", mean, worst: rows.slice(0, 5) };
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function summary(values: number[]): { n: number; min: number; p25: number; median: number; p75: number; max: number; mean: number } {
  const s = [...values].sort((a, b) => a - b);
  return {
    n: s.length,
    min: round(s[0], 4),
    p25: round(quantile(s, 0.25), 4),
    median: round(quantile(s, 0.5), 4),
    p75: round(quantile(s, 0.75), 4),
    max: round(s[s.length - 1], 4),
    mean: round(s.reduce((a, b) => a + b, 0) / s.length, 4),
  };
}

function ranks(values: number[]): number[] {
  const idx = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(values.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2;
    i = j + 1;
  }
  return r;
}

function spearman(a: number[], b: number[]): number {
  const ra = ranks(a);
  const rb = ranks(b);
  const n = a.length;
  const ma = ra.reduce((s, v) => s + v, 0) / n;
  const mb = rb.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) ** 2;
    db += (rb[i] - mb) ** 2;
  }
  return num / Math.sqrt(da * db);
}

export function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function separation(renders: number[], candidates: number[]) {
  return {
    renders: summary(renders),
    candidates: candidates.map((v) => round(v, 4)),
    rendersAtOrAboveThreshold: renders.filter((v) => v >= THRESHOLD).length,
    candidatesAtOrAboveThreshold: candidates.filter((v) => v >= THRESHOLD).length,
    rendersBelowBestCandidate: renders.filter((v) => v < Math.max(...candidates)).length,
    /** Distance from the threshold down to the closest different-person score. */
    marginBelowThreshold: round(THRESHOLD - Math.max(...candidates), 4),
  };
}

export function parityReport(py: PyResults, js: Record<string, JsEntry>) {
  const keys = Object.keys(py).filter((k) => k in js).sort();
  const onlyPy = Object.keys(py).filter((k) => !(k in js));
  const onlyJs = Object.keys(js).filter((k) => !(k in py));
  const faceMismatch = keys.filter((k) => py[k].faces !== js[k].faces).map((k) => ({ key: k, py: py[k].faces, js: js[k].faces }));

  const renderKeys = keys.filter((k) => k.startsWith("render/") && py[k].cosMaster !== null && js[k].cosMaster !== null);
  const pyRenders = renderKeys.map((k) => py[k].cosMaster ?? NaN);
  const jsRenders = renderKeys.map((k) => js[k].cosMaster ?? NaN);
  const candKeys = DIFFERENT_PEOPLE.filter((k) => keys.includes(k));
  const pyCands = candKeys.map((k) => py[k].cosMaster ?? NaN);
  const jsCands = candKeys.map((k) => js[k].cosMaster ?? NaN);
  const flips = keys
    .filter((k) => py[k].cosMaster !== null && js[k].cosMaster !== null)
    .filter((k) => ((py[k].cosMaster ?? 0) >= THRESHOLD) !== ((js[k].cosMaster ?? 0) >= THRESHOLD))
    .map((k) => ({ key: k, py: py[k].cosMaster, js: round(js[k].cosMaster ?? NaN, 4) }));

  return {
    compared: keys.length,
    onlyPy,
    onlyJs,
    faceCountAgreement: `${keys.length - faceMismatch.length}/${keys.length}`,
    faceMismatch,
    cosMaster: diffStats(keys, py, js, "cosMaster"),
    cosFront: diffStats(keys, py, js, "cosFront"),
    headRatio: diffStats(keys, py, js, "headRatio"),
    spearmanRenderCosMaster: round(spearman(pyRenders, jsRenders), 4),
    threshold: THRESHOLD,
    thresholdFlips: flips,
    py: separation(pyRenders, pyCands),
    js: separation(jsRenders, jsCands),
  };
}

/** One-line digest of a parity report for the console. */
export function parityDigest(report: ReturnType<typeof parityReport>) {
  const brief = (s: DiffStats) => ({ n: s.n, max: round(s.max, 4), maxKey: s.maxKey, mean: round(s.mean, 5) });
  return {
    faceCountAgreement: report.faceCountAgreement,
    cosMaster: brief(report.cosMaster),
    cosFront: brief(report.cosFront),
    headRatio: { max: round(report.headRatio.max, 4), mean: round(report.headRatio.mean, 5) },
    spearman: report.spearmanRenderCosMaster,
    thresholdFlips: report.thresholdFlips,
  };
}
