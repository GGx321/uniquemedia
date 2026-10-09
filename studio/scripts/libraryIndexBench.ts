/**
 * S4.P1 measurement (not a test, not run by CI): what a launch pays for the library's photo queries.
 *
 *   bun studio/scripts/libraryIndexBench.ts
 *
 * Builds a synthetic library in a fresh temp dir (12 avatars x 1 000 photos, 300 video records, some reject marks),
 * then times `Library.open` (5 runs) and `eligibleUnusedPhotos` (200 calls, cycling over the avatars, with and
 * without a category). Single process, fixed iteration counts, no load loops; the temp dir is removed at the end.
 * The plan's budget (stage 4 plan, section 11 P1): a call's p95 over 20 ms, or `open` over 3 s, means an index is needed.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLibrary } from "../engine/library/library";
import { PNG_1X1, SAMPLE_SOURCE } from "../engine/library/testing/sampleData";
import { sceneSpec, writeVideoRecord } from "../engine/library/testing/videoRecords";

const AVATARS = 12;
const PHOTOS_PER_AVATAR = 1_000;
const VIDEO_RECORDS = 300;
const PHOTOS_PER_VIDEO = 3;
const REJECTED_PER_AVATAR = 20;
const CALLS = 200;
const OPEN_RUNS = 5;
const CATEGORIES = ["home", "travel", "cafe", "gym", "street"];
const P95_BUDGET_MS = 20;
const OPEN_BUDGET_MS = 3_000;

const avatarId = (a: number): string => `avatar-${String(a).padStart(4, "0")}`;
const photoId = (a: number, p: number): string => `photo-${String(a).padStart(4, "0")}-${String(p).padStart(5, "0")}`;
const isoAt = (n: number): string => new Date(Date.parse("2026-01-01T00:00:00.000Z") + n * 1000).toISOString();

async function build(root: string): Promise<void> {
  await openLibrary(root); // an empty folder becomes a library (writes library.json); the synthetic records follow
  const sha256 = createHash("sha256").update(PNG_1X1).digest("hex");
  for (let a = 0; a < AVATARS; a++) {
    const dir = join(root, "avatars", avatarId(a));
    const photos = join(dir, "photos");
    await mkdir(photos, { recursive: true });
    await writeFile(
      join(dir, "avatar.json"),
      JSON.stringify({
        schemaVersion: 2, id: avatarId(a), name: `Bench ${a}`, age: 25, traits: { hair: "chestnut" },
        descriptor: "a 25-year-old woman", masterPhotoId: photoId(a, 0), status: "active", createdAt: isoAt(0),
      }),
    );
    for (let p = 0; p < PHOTOS_PER_AVATAR; p++) {
      const id = photoId(a, p);
      const source = p === 0 ? SAMPLE_SOURCE : { ...SAMPLE_SOURCE, category: CATEGORIES[p % CATEGORIES.length] };
      await writeFile(join(photos, `${id}.png`), PNG_1X1);
      await writeFile(
        join(photos, `${id}.json`),
        JSON.stringify({
          schemaVersion: 1, id, avatarId: avatarId(a), file: `${id}.png`, mediaType: "image/png", width: 1, height: 1,
          bytes: PNG_1X1.length, sha256, source, qa: {}, createdAt: isoAt(a * PHOTOS_PER_AVATAR + p),
        }),
      );
    }
    const marks = Array.from({ length: REJECTED_PER_AVATAR }, (_, i) =>
      JSON.stringify({ photoId: photoId(a, 500 + i), op: "reject", at: isoAt(100_000 + i) }),
    );
    await writeFile(join(dir, "rejected.jsonl"), `${marks.join("\n")}\n`);
  }
  for (let v = 0; v < VIDEO_RECORDS; v++) {
    const a = v % AVATARS;
    const first = 1 + Math.floor(v / AVATARS) * PHOTOS_PER_VIDEO;
    const ids = Array.from({ length: PHOTOS_PER_VIDEO }, (_, i) => photoId(a, first + i));
    await writeVideoRecord(root, `video-${String(v).padStart(5, "0")}`, sceneSpec(avatarId(a), ids));
  }
}

const quantile = (sorted: readonly number[], q: number): number => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
const fmt = (ms: number): string => ms.toFixed(3);

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "studio-index-bench-"));
  try {
    await build(root);
    const opens: number[] = [];
    let library = (await openLibrary(root)).library;
    for (let i = 0; i < OPEN_RUNS; i++) {
      const t0 = performance.now();
      library = (await openLibrary(root)).library;
      opens.push(performance.now() - t0);
    }
    console.log(`open  runs=${OPEN_RUNS} ms=[${opens.map(fmt).join(", ")}] max=${fmt(Math.max(...opens))} budget=${OPEN_BUDGET_MS}`);

    let over = Math.max(...opens) > OPEN_BUDGET_MS;
    for (const category of [undefined, "travel"]) {
      const times: number[] = [];
      let size = 0;
      for (let i = 0; i < CALLS; i++) {
        const id = avatarId(i % AVATARS);
        const t0 = performance.now();
        size = library.eligibleUnusedPhotos(id, category).length;
        times.push(performance.now() - t0);
      }
      times.sort((x, y) => x - y);
      const p95 = quantile(times, 0.95);
      over ||= p95 > P95_BUDGET_MS;
      console.log(`eligibleUnusedPhotos category=${category ?? "none"} calls=${CALLS} p50=${fmt(quantile(times, 0.5))}ms p95=${fmt(p95)}ms max=${fmt(times[times.length - 1] ?? 0)}ms lastResult=${size} budget=${P95_BUDGET_MS}ms`);
    }
    console.log(over ? "VERDICT: over budget, an index is needed" : "VERDICT: under budget, no index needed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
