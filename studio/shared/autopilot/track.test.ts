import { describe, expect, test } from "bun:test";
import { MontageSpec } from "../engine/montage";
import { chooseTrack, emptyUsage, startFor, trackKey, withUse, type ChooseTrackInput, type TrackCandidate, type TrackUsage } from "./track";

const TOTAL = 8_000;

const trending = (trackId: string, over: Partial<Extract<TrackCandidate, { source: "trending" }>> = {}): TrackCandidate => ({
  source: "trending",
  trackId,
  durationMs: 30_000,
  highlights: [],
  explicit: false,
  inList: true,
  ...over,
});
const own = (mediaId: string, durationMs = 30_000): TrackCandidate => ({ source: "own", mediaId, durationMs });

const usageOf = (counts: Record<string, number>, recent: string[] = []): TrackUsage => ({ counts: new Map(Object.entries(counts)), recent, complete: true });

const inputOf = (candidates: TrackCandidate[], over: Partial<ChooseTrackInput> = {}): ChooseTrackInput => ({
  candidates,
  flaggedOwn: new Set<string>(),
  usage: emptyUsage(),
  totalMs: TOTAL,
  seed: 1,
  ...over,
});

const chosenKey = (input: ChooseTrackInput): string => {
  const choice = chooseTrack(input);
  if (choice.kind !== "chosen") throw new Error(`waiting: ${choice.reason}`);
  return choice.music.source === "trending" ? trackKey("trending", choice.music.trackId) : trackKey("own", choice.music.mediaId);
};

describe("trackKey and usage helpers", () => {
  test("a trending track and an own media with the same id have different keys", () => {
    expect(trackKey("trending", "abc-12345")).not.toBe(trackKey("own", "abc-12345"));
  });

  test("an empty usage has no counts, no recent videos, and is complete", () => {
    const usage = emptyUsage();
    expect(usage.counts.size).toBe(0);
    expect(usage.recent).toEqual([]);
    expect(usage.complete).toBe(true);
  });

  test("withUse adds one to the count and puts the key first in recent, without changing the original", () => {
    const base = usageOf({ a: 2 }, ["b"]);
    const next = withUse(withUse(base, "a"), "c");
    expect(next.counts.get("a")).toBe(3);
    expect(next.counts.get("c")).toBe(1);
    expect(next.recent).toEqual(["c", "a", "b"]);
    expect(base.counts.get("a")).toBe(2);
    expect(base.recent).toEqual(["b"]);
  });

  test("withUse keeps only the last 5 videos in recent", () => {
    let usage = emptyUsage();
    for (const key of ["k1", "k2", "k3", "k4", "k5", "k6"]) usage = withUse(usage, key);
    expect(usage.recent).toEqual(["k6", "k5", "k4", "k3", "k2"]);
  });
});

describe("startFor: where in the track the video starts", () => {
  test("the first highlight in ascending order, however the list is ordered", () => {
    const candidate = trending("t-00000001", { highlights: [{ ms: 9000, likelyDefault: false }, { ms: 4000, likelyDefault: false }, { ms: 7000, likelyDefault: false }] });
    expect(startFor(candidate, TOTAL)).toBe(4000);
  });

  test("a highlight whose window does not fit is skipped for the next one", () => {
    const candidate = trending("t-00000001", { durationMs: 20_000, highlights: [{ ms: 15_000, likelyDefault: false }, { ms: 5000, likelyDefault: false }] });
    expect(startFor(candidate, TOTAL)).toBe(5000);
  });

  test("the likely default 1500 comes last: a real highlight wins over it, even a later one", () => {
    const candidate = trending("t-00000001", { highlights: [{ ms: 1500, likelyDefault: true }, { ms: 12_000, likelyDefault: false }] });
    expect(startFor(candidate, TOTAL)).toBe(12_000);
  });

  test("with no highlight that fits, 1500 is used if it fits", () => {
    const candidate = trending("t-00000001", { durationMs: 10_000, highlights: [{ ms: 9000, likelyDefault: false }] });
    expect(startFor(candidate, TOTAL)).toBe(1500);
  });

  test("1500 is used even when the list did not flag it, when nothing else fits", () => {
    expect(startFor(trending("t-00000001", { durationMs: 10_000 }), TOTAL)).toBe(1500);
  });

  test("with 1500 not fitting either, the start is 0 if that fits", () => {
    expect(startFor(trending("t-00000001", { durationMs: 9_000 }), TOTAL)).toBe(0);
  });

  test("a track exactly start + duration long fits: the highlight, 1500 and 0 each pass at equality", () => {
    expect(startFor(trending("t-00000001", { durationMs: 4000 + TOTAL, highlights: [{ ms: 4000, likelyDefault: false }] }), TOTAL)).toBe(4000);
    expect(startFor(trending("t-00000001", { durationMs: 1500 + TOTAL }), TOTAL)).toBe(1500);
    expect(startFor(trending("t-00000001", { durationMs: TOTAL }), TOTAL)).toBe(0);
  });

  test("a track one millisecond short of start + duration does not pass at that start", () => {
    expect(startFor(trending("t-00000001", { durationMs: 4000 + TOTAL - 1, highlights: [{ ms: 4000, likelyDefault: false }] }), TOTAL)).toBe(1500);
    expect(startFor(trending("t-00000001", { durationMs: 1500 + TOTAL - 1 }), TOTAL)).toBe(0);
  });

  test("a track shorter than the video has no start", () => {
    expect(startFor(trending("t-00000001", { durationMs: TOTAL - 1 }), TOTAL)).toBeNull();
  });

  test("a video of exactly 10 000 ms: a 10 000 ms track starts at 0, a 9 999 ms one is unfit", () => {
    expect(startFor(trending("t-00000001", { durationMs: 10_000 }), 10_000)).toBe(0);
    expect(startFor(trending("t-00000001", { durationMs: 9_999 }), 10_000)).toBeNull();
  });

  test("an own track has no highlights: 1500 if it fits, else 0, else none", () => {
    expect(startFor(own("m-00000001", 1500 + TOTAL), TOTAL)).toBe(1500);
    expect(startFor(own("m-00000001", 1500 + TOTAL - 1), TOTAL)).toBe(0);
    expect(startFor(own("m-00000001", TOTAL - 1), TOTAL)).toBeNull();
  });

  test("a highlight that is not a whole number, or past the contract's source offset, is never used", () => {
    const odd = trending("t-00000001", { durationMs: 900_000, highlights: [{ ms: 2500.5, likelyDefault: false }, { ms: 700_000, likelyDefault: false }] });
    expect(startFor(odd, TOTAL)).toBe(1500);
  });
});

describe("explicit and unflagged tracks never qualify", () => {
  test("an explicit trending track is never chosen, even when it is the only one", () => {
    expect(chooseTrack(inputOf([trending("t-00000001", { explicit: true })]))).toEqual({ kind: "waiting", reason: "no-candidate" });
  });

  test("an explicit track is never chosen over many seeds when a clean one exists", () => {
    const candidates = [trending("t-explicit1", { explicit: true }), trending("t-clean001"), trending("t-explicit2", { explicit: true })];
    for (let seed = 0; seed < 500; seed++) expect(chosenKey(inputOf(candidates, { seed }))).toBe(trackKey("trending", "t-clean001"));
  });

  test("an own track that is not flagged for the autopilot is never chosen", () => {
    expect(chooseTrack(inputOf([own("m-00000001")]))).toEqual({ kind: "waiting", reason: "no-candidate" });
  });

  test("a flagged own track qualifies", () => {
    expect(chooseTrack(inputOf([own("m-00000001")], { flaggedOwn: new Set(["m-00000001"]) }))).toEqual({ kind: "chosen", music: { source: "own", mediaId: "m-00000001", startMs: 1500 } });
  });

  test("only the flagged one of two own tracks qualifies", () => {
    const candidates = [own("m-00000001"), own("m-00000002")];
    for (let seed = 0; seed < 100; seed++) expect(chosenKey(inputOf(candidates, { flaggedOwn: new Set(["m-00000002"]), seed }))).toBe(trackKey("own", "m-00000002"));
  });

  test("a flagged id that is not among the own candidates adds nothing", () => {
    expect(chooseTrack(inputOf([], { flaggedOwn: new Set(["m-00000009"]) }))).toEqual({ kind: "waiting", reason: "no-candidate" });
  });
});

describe("least-used ranks the candidates", () => {
  test("the track used least for the avatar is chosen", () => {
    const candidates = [trending("t-00000001"), trending("t-00000002"), trending("t-00000003")];
    const usage = usageOf({ [trackKey("trending", "t-00000001")]: 3, [trackKey("trending", "t-00000002")]: 1, [trackKey("trending", "t-00000003")]: 2 });
    for (let seed = 0; seed < 100; seed++) expect(chosenKey(inputOf(candidates, { usage, seed }))).toBe(trackKey("trending", "t-00000002"));
  });

  test("a track never used counts as zero and beats a used one", () => {
    const candidates = [trending("t-00000001"), trending("t-00000002")];
    expect(chosenKey(inputOf(candidates, { usage: usageOf({ [trackKey("trending", "t-00000001")]: 1 }) }))).toBe(trackKey("trending", "t-00000002"));
  });

  test("a track that was used is still allowed when it is the only candidate", () => {
    const usage = usageOf({ [trackKey("trending", "t-00000001")]: 7 });
    expect(chooseTrack(inputOf([trending("t-00000001")], { usage }))).toEqual({ kind: "chosen", music: { source: "trending", trackId: "t-00000001", startMs: 1500 } });
  });

  test("ranking never excludes: with every track used often, one is still chosen", () => {
    const candidates = [trending("t-00000001"), trending("t-00000002")];
    const usage = usageOf({ [trackKey("trending", "t-00000001")]: 50, [trackKey("trending", "t-00000002")]: 49 });
    expect(chosenKey(inputOf(candidates, { usage }))).toBe(trackKey("trending", "t-00000002"));
  });

  test("the usage across a launch rotates the tracks: using each pick through withUse visits every track before any repeats", () => {
    const candidates = [trending("t-00000001"), trending("t-00000002"), trending("t-00000003")];
    let usage = emptyUsage();
    const picks: string[] = [];
    for (let i = 0; i < 6; i++) {
      const key = chosenKey(inputOf(candidates, { usage, seed: i }));
      picks.push(key);
      usage = withUse(usage, key);
    }
    expect(new Set(picks.slice(0, 3)).size).toBe(3);
    expect(new Set(picks.slice(3, 6)).size).toBe(3);
  });

  test("a less used track that is too short does not win: the least-used one that FITS does", () => {
    const candidates = [trending("t-00000001", { durationMs: TOTAL - 1 }), trending("t-00000002")];
    const usage = usageOf({ [trackKey("trending", "t-00000002")]: 9 });
    expect(chosenKey(inputOf(candidates, { usage }))).toBe(trackKey("trending", "t-00000002"));
  });
});

describe("ties: not among the last 5, then current trends, then own, then the seed", () => {
  test("a track among the avatar's last 5 videos loses a tie to one that is not", () => {
    const candidates = [trending("t-00000001"), trending("t-00000002")];
    const usage = usageOf({ [trackKey("trending", "t-00000001")]: 1, [trackKey("trending", "t-00000002")]: 1 }, [trackKey("trending", "t-00000001")]);
    for (let seed = 0; seed < 100; seed++) expect(chosenKey(inputOf(candidates, { usage, seed }))).toBe(trackKey("trending", "t-00000002"));
  });

  test("recency never beats the count: the track with fewer uses wins even when it is the most recent", () => {
    const candidates = [trending("t-00000001"), trending("t-00000002")];
    const usage = usageOf({ [trackKey("trending", "t-00000001")]: 1, [trackKey("trending", "t-00000002")]: 5 }, [trackKey("trending", "t-00000001")]);
    expect(chosenKey(inputOf(candidates, { usage }))).toBe(trackKey("trending", "t-00000001"));
  });

  test("on a full tie a track in the current list beats a kept one from an older list", () => {
    const candidates = [trending("t-00000001", { inList: false }), trending("t-00000002", { inList: true })];
    for (let seed = 0; seed < 100; seed++) expect(chosenKey(inputOf(candidates, { seed }))).toBe(trackKey("trending", "t-00000002"));
  });

  test("on a full tie a current trend beats an own track, and an own track beats an older trend", () => {
    const flaggedOwn = new Set(["m-00000001"]);
    for (let seed = 0; seed < 100; seed++) {
      expect(chosenKey(inputOf([own("m-00000001"), trending("t-00000001", { inList: true })], { flaggedOwn, seed }))).toBe(trackKey("trending", "t-00000001"));
      expect(chosenKey(inputOf([trending("t-00000001", { inList: false }), own("m-00000001")], { flaggedOwn, seed }))).toBe(trackKey("own", "m-00000001"));
    }
  });

  test("a full tie is broken by the seed: the same seed picks the same track, and the seeds spread over the tracks", () => {
    const candidates = [trending("t-00000001"), trending("t-00000002"), trending("t-00000003")];
    const picks = Array.from({ length: 300 }, (_, seed) => chosenKey(inputOf(candidates, { seed })));
    expect(new Set(picks).size).toBe(3);
    expect(chosenKey(inputOf(candidates, { seed: 42 }))).toBe(chosenKey(inputOf(candidates, { seed: 42 })));
  });

  test("the order of the candidates does not matter", () => {
    const a = trending("t-00000001");
    const b = trending("t-00000002");
    const c = trending("t-00000003");
    for (let seed = 0; seed < 100; seed++) expect(chosenKey(inputOf([a, b, c], { seed }))).toBe(chosenKey(inputOf([c, a, b], { seed })));
  });
});

describe("the track must be long enough: start + duration", () => {
  test("a track shorter than the video is skipped for one that fits", () => {
    const candidates = [trending("t-00000001", { durationMs: TOTAL - 1 }), trending("t-00000002", { durationMs: 60_000 })];
    for (let seed = 0; seed < 100; seed++) expect(chosenKey(inputOf(candidates, { seed }))).toBe(trackKey("trending", "t-00000002"));
  });

  test("a track exactly as long as the video is chosen, starting at 0", () => {
    expect(chooseTrack(inputOf([trending("t-00000001", { durationMs: TOTAL })]))).toEqual({ kind: "chosen", music: { source: "trending", trackId: "t-00000001", startMs: 0 } });
  });

  test("a track one millisecond shorter than the video is not chosen", () => {
    expect(chooseTrack(inputOf([trending("t-00000001", { durationMs: TOTAL - 1 })]))).toEqual({ kind: "waiting", reason: "all-too-short" });
  });

  test("the chosen start comes with the track: its first fitting highlight", () => {
    const candidate = trending("t-00000001", { highlights: [{ ms: 6000, likelyDefault: false }, { ms: 2000, likelyDefault: false }] });
    expect(chooseTrack(inputOf([candidate]))).toEqual({ kind: "chosen", music: { source: "trending", trackId: "t-00000001", startMs: 2000 } });
  });

  test("a 10 000 ms video takes a 10 000 ms track (start 0) and waits for a 9 999 ms one", () => {
    expect(chooseTrack(inputOf([trending("t-00000001", { durationMs: 10_000 })], { totalMs: 10_000 }))).toEqual({ kind: "chosen", music: { source: "trending", trackId: "t-00000001", startMs: 0 } });
    expect(chooseTrack(inputOf([trending("t-00000001", { durationMs: 9_999 })], { totalMs: 10_000 }))).toEqual({ kind: "waiting", reason: "all-too-short" });
  });

  test("the chosen music is accepted by the contract in a spec with that total", () => {
    const choice = chooseTrack(inputOf([trending("t-00000001", { durationMs: TOTAL })]));
    if (choice.kind !== "chosen") throw new Error("chosen expected");
    const spec = {
      schemaVersion: 1,
      avatarId: "avatar-auto-0001",
      clips: [{ clipId: "clip-001", kind: "photo", cell: { photo: { source: "scene", photoId: "photo-auto-001" }, focus: null }, motion: "kenburns", durationMs: TOTAL, transitionIn: "cut" }],
      layers: [],
      music: choice.music,
      seed: 1,
    };
    expect(MontageSpec.safeParse(spec).success).toBe(true);
  });
});

describe("waiting: no candidate fits", () => {
  test("no candidates at all", () => {
    expect(chooseTrack(inputOf([]))).toEqual({ kind: "waiting", reason: "no-candidate" });
  });

  test("every candidate too short", () => {
    const candidates = [trending("t-00000001", { durationMs: 1000 }), trending("t-00000002", { durationMs: 5000 }), own("m-00000001", 7999)];
    expect(chooseTrack(inputOf(candidates, { flaggedOwn: new Set(["m-00000001"]) }))).toEqual({ kind: "waiting", reason: "all-too-short" });
  });

  test("only explicit and unflagged candidates left is «no candidate», not «too short»", () => {
    const candidates = [trending("t-00000001", { explicit: true }), own("m-00000001")];
    expect(chooseTrack(inputOf(candidates))).toEqual({ kind: "waiting", reason: "no-candidate" });
  });

  test("a qualifying but too-short track plus an explicit one is «too short»: a candidate exists", () => {
    const candidates = [trending("t-00000001", { durationMs: 1000 }), trending("t-00000002", { explicit: true })];
    expect(chooseTrack(inputOf(candidates))).toEqual({ kind: "waiting", reason: "all-too-short" });
  });

  test("a heavily used track does not make the video wait", () => {
    expect(chooseTrack(inputOf([trending("t-00000001")], { usage: usageOf({ [trackKey("trending", "t-00000001")]: 1000 }) })).kind).toBe("chosen");
  });

  test("an incomplete usage read still ranks and never makes the video wait", () => {
    const usage: TrackUsage = { counts: new Map(), recent: [], complete: false };
    expect(chooseTrack(inputOf([trending("t-00000001")], { usage })).kind).toBe("chosen");
  });
});
