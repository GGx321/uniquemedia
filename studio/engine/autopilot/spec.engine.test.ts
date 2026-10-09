import { describe, expect, test } from "bun:test";
import { autopilotSpec, autopilotTotalMs, videoSeed } from "../../shared/autopilot/spec";
import { chooseTrack, emptyUsage } from "../../shared/autopilot/track";
import type { VideoShape } from "../../shared/engine/autopilot";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { PNG_1X1, SAMPLE_SOURCE, samplePhotoMeta } from "../library/testing/helpers";
import { draftIssues } from "../montages/issues";
import { useWorld, type World } from "../videos/testing/kit";
useNativeGlobals();

// The acceptance line of S4.4: the engine accepts every generated spec, structurally AND referentially (real photos of a real library, a
// track the store holds and that is long enough). A spec the engine would refuse is a spec the autopilot could never render.

const world = useWorld();

const SHAPES: readonly { readonly shape: VideoShape; readonly size: number }[] = [
  { shape: "single", size: 1 },
  { shape: "collage", size: 2 },
  { shape: "collage", size: 3 },
  { shape: "collage", size: 4 },
  { shape: "slides", size: 5 },
  { shape: "slides", size: 6 },
  { shape: "slides", size: 7 },
];

/** The world has three photos; a slides video needs seven. */
async function sevenPhotoIds(w: World): Promise<string[]> {
  const more = await Promise.all(["beach", "city", "cafe", "park"].map((category) => w.library.addPhoto(w.avatar.id, PNG_1X1, samplePhotoMeta({ source: { ...SAMPLE_SOURCE, category } }))));
  return [...w.photos, ...more].map((photo) => photo.id);
}

const TRACK = { trackId: "track-engine-0001", durationMs: 40_000, highlights: [{ ms: 12_000, likelyDefault: false }, { ms: 1500, likelyDefault: true }] };
const stored = (trackId: string) => (trackId === TRACK.trackId ? { decodedMs: TRACK.durationMs } : null);

function specFor(w: World, ids: readonly string[], shape: VideoShape, size: number, seed: number) {
  const choice = chooseTrack({
    candidates: [{ source: "trending", ...TRACK, explicit: false, inList: true }],
    flaggedOwn: new Set<string>(),
    usage: emptyUsage(),
    totalMs: autopilotTotalMs(shape, size, seed),
    seed,
  });
  if (choice.kind !== "chosen") throw new Error("a track was expected");
  return autopilotSpec({ avatarId: w.avatar.id, shape, photoIds: ids.slice(0, size), seed, music: choice.music, options: { stickers: true, previousStickerId: null, captionSource: null } });
}

describe("the engine accepts every generated spec", () => {
  test.each([...SHAPES])("$shape of $size photos has no engine issue, over many seeds", async ({ shape, size }) => {
    const w = world();
    const ids = await sevenPhotoIds(w);

    for (let i = 0; i < 200; i++) {
      const seed = videoSeed(99, w.avatar.id, `1-${i}`);
      const issues = draftIssues(w.library, specFor(w, ids, shape, size, seed), () => undefined, undefined, { stored });
      if (issues.length > 0) throw new Error(`seed ${seed}: ${JSON.stringify(issues)}`);
    }
  });

  test("the check is live: the same spec against a track that is too short gets track-too-short", async () => {
    const w = world();
    const ids = await sevenPhotoIds(w);
    const spec = specFor(w, ids, "single", 1, 5);

    const issues = draftIssues(w.library, spec, () => undefined, undefined, { stored: () => ({ decodedMs: 3_000 }) });

    expect(issues).toEqual([{ code: "track-too-short", path: ["music"] }]);
  });

  test("the check is live: a photo the avatar does not have gets photo-unavailable", async () => {
    const w = world();
    const ids = await sevenPhotoIds(w);
    const spec = autopilotSpec({
      avatarId: w.avatar.id,
      shape: "single",
      photoIds: ["photo-not-in-library"],
      seed: 5,
      music: { source: "trending", trackId: TRACK.trackId, startMs: 0 },
      options: { stickers: false, previousStickerId: null, captionSource: null },
    });

    expect(ids.length).toBe(7);
    expect(draftIssues(w.library, spec, () => undefined, undefined, { stored }).map((issue) => issue.code)).toEqual(["photo-unavailable"]);
  });
});
