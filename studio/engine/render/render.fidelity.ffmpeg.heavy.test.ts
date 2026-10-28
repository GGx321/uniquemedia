import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Clip } from "../../shared/engine/montage";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { runFfmpegOk } from "./ffmpeg.testkit";
import { buildPass1 } from "./pass1";
import { buildPass2 } from "./pass2";
import { makeWorkDir, removeDir, runPass2 } from "./render.testkit";
import type { Pass1Job } from "./types";
useNativeGlobals();

// INVARIANT 36, fidelity, on real ffmpeg. The pass-1 intermediates are CRF 8
// (near lossless, not lossless), so the final made from them is not the final
// made from lossless clips. The plan's bar: measured against the LOSSLESS
// clips, the final from CRF 8 intermediates must score within 0.002 SSIM of the
// final from lossless (-qp 0) intermediates (SP1 measured 0.0009).
//
// A 2-clip timeline of real photos (a Ken Burns photo and a static staggered
// collage) is rendered three times through the real builders, differing only
// in the intermediates' quality (argv substitution, as the colour traps do):
// the real CRF 8, lossless `-qp 0`, and CRF 30 as the NEGATIVE CONTROL, which
// must fail the same bar.

const FIXTURES = join(import.meta.dir, "../face/fixtures/images");
const PHOTOS = ["render-best-home-1.jpg", "render-median-travel-2.jpg", "render-worst-fitness-3.jpg"].map((n) => join(FIXTURES, n));
const BAR = 0.002;

const scene = (id: string) => ({ photo: { source: "scene" as const, photoId: id }, focus: { x: 0.5, y: 0.38 } });
const CLIPS: Clip[] = [
  { clipId: "kb", durationMs: 1500, transitionIn: "cut", kind: "photo", cell: scene("p-0"), motion: "kenburns" },
  { clipId: "col", durationMs: 1000, transitionIn: "cut", kind: "collage", layout: "collage2", cells: [scene("p-1"), scene("p-2")], motion: "static", stagger: true },
];

let dir: string;
const scores = new Map<string, number>();

/** The same call with its intermediate's `-crf 8` swapped for `quality`. */
function withQuality(job: Pass1Job, quality: readonly string[]): Pass1Job {
  const at = job.argv.indexOf("-crf");
  if (at < 0 || job.argv[at + 1] !== "8") throw new Error("the intermediate is not CRF 8");
  return { ...job, argv: [...job.argv.slice(0, at), ...quality, ...job.argv.slice(at + 2)] };
}

async function ssimAgainst(distorted: string, reference: string): Promise<number> {
  // Both streams are renumbered by frame (N at 1/30): the concat's timestamps are rounded to ms (0, 33, 67, ...) and the MP4's are exact
  // (66.67), so pairing by timestamp would compare every third frame with the previous reference frame.
  const r = await runFfmpegOk(["-hide_banner", "-nostdin", "-i", distorted, "-i", reference, "-lavfi", "[0:v]settb=1/30,setpts=N[a];[1:v]settb=1/30,setpts=N[b];[a][b]ssim", "-f", "null", "-"]);
  const m = /SSIM Y:[\d.]+ \([\d.]+\) U:[\d.]+ \([\d.]+\) V:[\d.]+ \([\d.]+\) All:([\d.]+)/.exec(r.stderr);
  if (!m?.[1]) throw new Error(`no SSIM in ${r.stderr.slice(-300)}`);
  return Number(m[1]);
}

/** Renders the timeline with the given intermediate quality (null: as the builder makes it); returns the final and the concat of the intermediates. */
async function render(name: string, quality: readonly string[] | null): Promise<{ final: string; concat: string }> {
  const work = join(dir, name);
  await Bun.$`mkdir -p ${work}`.quiet();
  const jobs = buildPass1({ seed: 4, clips: CLIPS, resolvePhoto: (ref) => ({ path: PHOTOS[Number((ref.source === "scene" ? ref.photoId : ref.mediaId).slice(-1))] ?? PHOTOS[0] ?? "", width: 720, height: 1280 }), clipDir: work });
  for (const job of jobs) await runFfmpegOk((quality ? withQuality(job, quality) : job).argv);
  const final = join(work, "final.mp4");
  const pass2 = buildPass2({ clips: CLIPS, clipDir: work, output: final, overlays: [], audio: { kind: "silent" } });
  await runPass2(pass2);
  const concat = join(work, "concat.mkv");
  await runFfmpegOk(["-hide_banner", "-nostdin", "-y", "-f", "concat", "-protocol_whitelist", "file", "-i", pass2.listFileName, "-c", "copy", concat], { cwd: work });
  return { final, concat };
}

beforeAll(async () => {
  dir = makeWorkDir("fidelity");
  const lossless = await render("lossless", ["-qp", "0"]);
  const real = await render("crf8", null);
  const crf30 = await render("crf30", ["-crf", "30"]);
  // Both scored against the LOSSLESS clips.
  scores.set("lossless", await ssimAgainst(lossless.final, lossless.concat));
  scores.set("crf8", await ssimAgainst(real.final, lossless.concat));
  scores.set("crf30", await ssimAgainst(crf30.final, lossless.concat));
}, 180_000);

afterAll(() => {
  const s = (k: string): string => (scores.get(k) ?? Number.NaN).toFixed(5);
  console.log(`fidelity SSIM vs the lossless clips: final from lossless ${s("lossless")}, from CRF 8 ${s("crf8")} (loss ${((scores.get("lossless") ?? 0) - (scores.get("crf8") ?? 0)).toFixed(5)}), from CRF 30 ${s("crf30")}`);
  removeDir(dir);
});

const score = (k: string): number => {
  const v = scores.get(k);
  if (v === undefined) throw new Error(`no score for ${k}`);
  return v;
};

describe("fidelity on real ffmpeg (invariant 36)", () => {
  test("the final made from CRF 8 intermediates is within 0.002 SSIM of the final made from lossless ones, both against the lossless clips", () => {
    expect(score("lossless") - score("crf8")).toBeLessThanOrEqual(BAR);
  });

  test("the score is a real similarity, not a degenerate one: the lossless final is close to its clips", () => {
    expect(score("lossless")).toBeGreaterThan(0.99);
    expect(score("lossless")).toBeLessThanOrEqual(1);
  });

  test("negative control: intermediates at CRF 30 fail the same 0.002 bar", () => {
    expect(score("lossless") - score("crf30")).toBeGreaterThan(BAR);
  });
});
