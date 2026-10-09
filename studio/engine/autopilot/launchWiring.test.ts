import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { within } from "../testing/within";
import { NETWORK_WAITS_MS } from "./paidFailures";
import { AUTOPILOT_NETWORK_WAITS_MS, AUTOPILOT_READ_TIMEOUT_MS, boundedRead, boundedSingleFlight, createSpentSlices, isSpentSlice, liveRendersOf, normalizeTrackLabel, ownTrackTitle, trendTrackLabel, renderLifeOf, sliceFactsOf, UNTITLED_TRACK, type SliceFactsSet } from "./launchWiring";
useNativeGlobals();

// Stage 4, S4.6w: the pure parts of the engine's default wiring of the autopilot steps. The wiring itself is tested in the engine (`engine.autopilotWiring.test.ts`).

describe("Q2: the network waits are one constant", () => {
  test("are the plan's default: the first drop of a job waits 1 minute, the second 5", () => {
    expect(AUTOPILOT_NETWORK_WAITS_MS).toEqual([60_000, 300_000]);
    expect(AUTOPILOT_NETWORK_WAITS_MS).toBe(NETWORK_WAITS_MS);
  });
});

describe("boundedRead", () => {
  test("answers what the read answers when it is in time", async () => {
    expect(await boundedRead(() => Promise.resolve(7), 1_000, "a read")).toBe(7);
  });

  test("rejects naming the read when it does not answer in time, and the timer does not outlive the answer", async () => {
    const never = new Promise<number>(() => undefined);
    await expect(within(boundedRead(() => never, 20, "the slice runs"), 2_000, "boundedRead")).rejects.toThrow("the slice runs did not answer in 20 ms");
  });

  test("passes a failure of the read on as it is", async () => {
    await expect(boundedRead(() => Promise.reject(new Error("boom")), 1_000, "a read")).rejects.toThrow("boom");
  });

  test("a read that throws at once is a rejection, not a throw", async () => {
    await expect(
      boundedRead(() => {
        throw new Error("sync boom");
      }, 1_000, "a read"),
    ).rejects.toThrow("sync boom");
  });

  test("the bound the engine uses is finite and shorter than a minute", () => {
    expect(AUTOPILOT_READ_TIMEOUT_MS).toBeGreaterThan(0);
    expect(AUTOPILOT_READ_TIMEOUT_MS).toBeLessThan(60_000);
  });
});

describe("sliceFactsOf", () => {
  const finished = { finished: true as const, committedMicros: 100 };
  const live = { finished: false as const, openSlots: 2 };
  const set = (sceneIds: number[], slices: Array<{ runId: string; sceneIds: number[] }>, statuses: Record<string, typeof finished | typeof live>): SliceFactsSet => ({
    draw: { sceneIds, slices },
    statuses: new Map(Object.entries(statuses)),
  });

  test("an avatar with no set of the launch is not over and has no runs: the draw has not begun", () => {
    expect(sliceFactsOf([], 0)).toEqual({ runIds: [], over: false });
  });

  test("a set the review has not approved is not over", () => {
    expect(sliceFactsOf([{ draw: undefined, statuses: new Map() }], 0)).toEqual({ runIds: [], over: false });
  });

  test("lists only the slices that are finished, and is not over while one is still live", () => {
    const facts = sliceFactsOf([set([1, 2, 3, 4], [{ runId: "run-a", sceneIds: [1, 2] }, { runId: "run-b", sceneIds: [3, 4] }], { "run-a": finished, "run-b": live })], 0);
    expect(facts).toEqual({ runIds: ["run-a"], over: false });
  });

  test("scenes still to be drawn keep it open even when every slice so far is finished: a paid hold is not the end of the draw", () => {
    const facts = sliceFactsOf([set([1, 2, 3, 4], [{ runId: "run-a", sceneIds: [1, 2] }], { "run-a": finished })], 0);
    expect(facts).toEqual({ runIds: ["run-a"], over: false });
  });

  test("is over when every frozen scene is in a slice and every slice is finished", () => {
    const facts = sliceFactsOf([set([1, 2, 3, 4], [{ runId: "run-a", sceneIds: [1, 2] }, { runId: "run-b", sceneIds: [3, 4] }], { "run-a": finished, "run-b": finished })], 0);
    expect(facts).toEqual({ runIds: ["run-a", "run-b"], over: true });
  });

  test("goes by the frozen list, so a scene the review removed before the approval is not waited for", () => {
    // Four scenes were composed; the owner removed 2 and 4 in the review, so the approval froze [1, 3]. One slice drew both.
    const facts = sliceFactsOf([set([1, 3], [{ runId: "run-a", sceneIds: [1, 3] }], { "run-a": finished })], 0);
    expect(facts.over).toBe(true);
  });

  test("a slice entry whose run has no folder yet (no status) is not listed and keeps the draw open", () => {
    const facts = sliceFactsOf([set([1, 2], [{ runId: "run-a", sceneIds: [1, 2] }], {})], 0);
    expect(facts).toEqual({ runIds: [], over: false });
  });

  test("a set file that could not be read may hold slices the launch cannot see: never over", () => {
    const facts = sliceFactsOf([set([1], [{ runId: "run-a", sceneIds: [1] }], { "run-a": finished })], 1);
    expect(facts).toEqual({ runIds: ["run-a"], over: false });
  });

  test("an approved set with nothing frozen to draw has no slices to wait for", () => {
    expect(sliceFactsOf([set([], [], {})], 0)).toEqual({ runIds: [], over: true });
  });
});

describe("renderLifeOf and liveRendersOf", () => {
  const states = [
    { kind: "render", jobId: "job-1", status: "running", videoId: "video-1", launchId: "launch-1" },
    { kind: "render", jobId: "job-2", status: "queued", videoId: "video-2", launchId: "launch-1" },
    { kind: "render", jobId: "job-3", status: "done", videoId: "video-3", launchId: "launch-1" },
    { kind: "render", jobId: "job-4", status: "running", videoId: "video-4" },
    { kind: "run", jobId: "job-5", status: "running" },
    { kind: "render", jobId: "job-6", status: "failed", videoId: "video-6", launchId: "launch-1" },
    { kind: "render", jobId: "job-7", status: "cancelled", videoId: "video-7", launchId: "launch-1" },
  ];

  test("a render job's life is its status; a job the registry forgot is gone", () => {
    expect(renderLifeOf(states, "job-1")).toBe("running");
    expect(renderLifeOf(states, "job-2")).toBe("queued");
    expect(renderLifeOf(states, "job-3")).toBe("done");
    expect(renderLifeOf(states, "job-6")).toBe("failed");
    expect(renderLifeOf(states, "job-7")).toBe("cancelled");
    expect(renderLifeOf(states, "job-nobody")).toBe("gone");
  });

  test("the id of a job that is not a render is gone: the free steps never wait on a run", () => {
    expect(renderLifeOf(states, "job-5")).toBe("gone");
  });

  test("the live renders are the queued and running ones that carry a launch id", () => {
    expect(liveRendersOf(states)).toEqual([
      { jobId: "job-1", videoId: "video-1", life: "running" },
      { jobId: "job-2", videoId: "video-2", life: "queued" },
    ]);
  });

  test("a render of the owner's own (no launch id) is not the launch's to take back", () => {
    expect(liveRendersOf([{ kind: "render", jobId: "job-4", status: "running", videoId: "video-4" }])).toEqual([]);
  });
});

describe("normalizeTrackLabel", () => {
  test("keeps a title and an artist that fit", () => {
    expect(normalizeTrackLabel("Midnight Drive", "The Lamps")).toEqual({ title: "Midnight Drive", artist: "The Lamps" });
  });

  test("trims both and turns an empty or blank artist into null", () => {
    expect(normalizeTrackLabel("  Midnight Drive  ", "   ")).toEqual({ title: "Midnight Drive", artist: null });
    expect(normalizeTrackLabel("Midnight Drive", "")).toEqual({ title: "Midnight Drive", artist: null });
    expect(normalizeTrackLabel("Midnight Drive", null)).toEqual({ title: "Midnight Drive", artist: null });
  });

  test("a title that is empty or blank names nothing: the list falls back to the track's id", () => {
    expect(normalizeTrackLabel("", "The Lamps")).toBeNull();
    expect(normalizeTrackLabel("   ", null)).toBeNull();
    expect(normalizeTrackLabel(null, "The Lamps")).toBeNull();
  });

  test("cuts a title and an artist to 120 characters, and 120 exactly is kept whole", () => {
    expect(normalizeTrackLabel("t".repeat(120), "a".repeat(120))).toEqual({ title: "t".repeat(120), artist: "a".repeat(120) });
    const cut = normalizeTrackLabel("t".repeat(121), "a".repeat(500));
    expect(cut?.title).toHaveLength(120);
    expect(cut?.artist).toHaveLength(120);
  });

  test("does not leave half of an emoji at the cut", () => {
    const title = `${"t".repeat(119)}😀`;
    const cut = normalizeTrackLabel(title, null);
    expect(cut?.title).toBe("t".repeat(119));
  });

  test("a cut that ends in a blank is trimmed again", () => {
    expect(normalizeTrackLabel(`${"t".repeat(119)} z`, null)?.title).toBe("t".repeat(119));
    expect(normalizeTrackLabel("Song", `${"a".repeat(119)} z`)?.artist).toBe("a".repeat(119));
  });
});

describe("isSpentSlice (a slice that ended on its cap is over for the free side too)", () => {
  const base = { openSlots: 3, running: false, needsReconcile: false, capMicros: 200_000, committedMicros: 190_000, minToProgressMicros: 40_000, endedByCap: false };

  test("open slots with no job and a cap that cannot fund the next attempt: spent", () => {
    expect(isSpentSlice(base)).toBe(true);
  });

  test("the cap that leaves exactly the next attempt's cost can still fund it: not spent", () => {
    expect(isSpentSlice({ ...base, committedMicros: 160_000 })).toBe(false);
    expect(isSpentSlice({ ...base, committedMicros: 160_001 })).toBe(true);
  });

  test("a job that runs is not spent, whatever the cap says", () => {
    expect(isSpentSlice({ ...base, running: true })).toBe(false);
  });

  test("nothing open is not «spent» (the slice is finished the ordinary way)", () => {
    expect(isSpentSlice({ ...base, openSlots: 0 })).toBe(false);
  });

  test("the run's own open reserves wait for a reconcile: the room is not final, so not spent", () => {
    expect(isSpentSlice({ ...base, needsReconcile: true })).toBe(false);
  });

  test("nothing to send at all (no minimum) is not a cap that failed", () => {
    expect(isSpentSlice({ ...base, minToProgressMicros: null })).toBe(false);
  });

  test("a slice the engine saw end on the LAUNCH group's cap is spent though its own cap has room", () => {
    expect(isSpentSlice({ ...base, committedMicros: 10_000, endedByCap: true })).toBe(true);
  });

  test("endedByCap does not outlive a running job or a pending reconcile", () => {
    expect(isSpentSlice({ ...base, endedByCap: true, running: true })).toBe(false);
    expect(isSpentSlice({ ...base, endedByCap: true, needsReconcile: true })).toBe(false);
  });
});

describe("boundedSingleFlight (a read that hangs is asked once, not once per pass)", () => {
  test("callers of one key while a read is out share it: one underlying call", async () => {
    let calls = 0;
    const read = boundedSingleFlight<number>(30, "a read");
    const never = new Promise<number>(() => undefined);
    const work = () => {
      calls += 1;
      return never;
    };
    const results = await Promise.allSettled([read("a", work), read("a", work), read("a", work)]);
    expect(calls).toBe(1);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
  });

  test("each caller keeps its own bound: a late caller waits its own ms, not the first caller's remainder", async () => {
    const read = boundedSingleFlight<number>(80, "a read");
    const never = new Promise<number>(() => undefined);
    const first = read("a", () => never).then(() => "answered", (error: unknown) => (error instanceof Error ? error.message : "failed"));
    await new Promise((resolve) => setTimeout(resolve, 60));
    const started = Date.now();
    const second = read("a", () => never);
    await expect(second).rejects.toThrow("did not answer");
    expect(Date.now() - started).toBeGreaterThanOrEqual(60);
    expect(await first).toContain("did not answer");
  });

  test("a different key is a different read", async () => {
    let calls = 0;
    const read = boundedSingleFlight<number>(1_000, "a read");
    const work = async () => ++calls;
    await Promise.all([read("a", work), read("b", work)]);
    expect(calls).toBe(2);
  });

  test("once the read settles the next call reads again (an answer is not kept)", async () => {
    let calls = 0;
    const read = boundedSingleFlight<number>(1_000, "a read");
    const work = async () => ++calls;
    expect(await read("a", work)).toBe(1);
    expect(await read("a", work)).toBe(2);
  });

  test("a read that failed is not kept either", async () => {
    let calls = 0;
    const read = boundedSingleFlight<number>(1_000, "a read");
    const work = async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return calls;
    };
    await expect(read("a", work)).rejects.toThrow("boom");
    expect(await read("a", work)).toBe(2);
  });

  test("a hung read that finally answers frees its key", async () => {
    let release = (): void => undefined;
    const slow = new Promise<number>((resolve) => {
      release = () => resolve(5);
    });
    const read = boundedSingleFlight<number>(20, "a read");
    await expect(read("a", () => slow)).rejects.toThrow("did not answer");
    release();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await read("a", async () => 9)).toBe(9);
  });
});

describe("labels of the tracks", () => {
  test("an own track is named by its file without the extension", () => {
    expect(ownTrackTitle("my-song.m4a")).toBe("my-song");
    expect(ownTrackTitle("a.b.c.m4a")).toBe("a.b.c");
  });

  test("a name that is only an extension, or has none, is kept as it is", () => {
    expect(ownTrackTitle(".m4a")).toBe(".m4a");
    expect(ownTrackTitle("loop")).toBe("loop");
    expect(ownTrackTitle("v1.0 final")).toBe("v1.0 final");
  });

  test("the neutral name of a trend with no title is not its id", () => {
    expect(UNTITLED_TRACK).toBe("Untitled track");
  });
});

describe("createSpentSlices (spent is latched, and the cheap checks come before the price list)", () => {
  const facts = { openSlots: 3, running: false, needsReconcile: false, capMicros: 200_000, committedMicros: 190_000, endedByCap: false };

  test("a slice judged spent stays spent when the figures change: a price drop must not hand back a cap the next slice was already sized from", async () => {
    const spent = createSpentSlices();
    expect(await spent.judge("run-a", { ...facts, minToProgress: async () => 40_000 })).toBe(true);
    // Prices fall: the next attempt now costs 5 000 and the cap would fund it. The slice is still spent.
    expect(await spent.judge("run-a", { ...facts, minToProgress: async () => 5_000 })).toBe(true);
  });

  test("a slice not judged spent is judged again each time, and is another run's business", async () => {
    const spent = createSpentSlices();
    expect(await spent.judge("run-a", { ...facts, minToProgress: async () => 5_000 })).toBe(false);
    expect(await spent.judge("run-b", { ...facts, minToProgress: async () => 40_000 })).toBe(true);
    expect(await spent.judge("run-a", { ...facts, minToProgress: async () => 40_000 })).toBe(true);
  });

  test("a pending reconcile, a live job and nothing open are decided without reading the prices", async () => {
    const spent = createSpentSlices();
    let loads = 0;
    const load = async (): Promise<number> => {
      loads += 1;
      return 40_000;
    };
    expect(await spent.judge("run-a", { ...facts, needsReconcile: true, minToProgress: load })).toBe(false);
    expect(await spent.judge("run-a", { ...facts, running: true, minToProgress: load })).toBe(false);
    expect(await spent.judge("run-a", { ...facts, openSlots: 0, minToProgress: load })).toBe(false);
    expect(loads).toBe(0);
  });

  test("a slice seen ending on a cap is spent without reading the prices", async () => {
    const spent = createSpentSlices();
    let loads = 0;
    expect(
      await spent.judge("run-a", {
        ...facts,
        endedByCap: true,
        minToProgress: async () => {
          loads += 1;
          return null;
        },
      }),
    ).toBe(true);
    expect(loads).toBe(0);
  });

  test("prices that cannot be read leave the cap test undecided: not spent", async () => {
    const spent = createSpentSlices();
    expect(await spent.judge("run-a", { ...facts, minToProgress: async () => null })).toBe(false);
  });
});

describe("ownTrackTitle keeps a version number", () => {
  test("only an extension with a letter in it is cut", () => {
    expect(ownTrackTitle("Song 2.0")).toBe("Song 2.0");
    expect(ownTrackTitle("Song.2024")).toBe("Song.2024");
    expect(ownTrackTitle("Song.mp3")).toBe("Song");
    expect(ownTrackTitle("Song.m4a")).toBe("Song");
  });
});

describe("trendTrackLabel", () => {
  test("a null title and a blank title fall back to the same neutral name", () => {
    expect(trendTrackLabel(null, "The Lamps")).toEqual({ title: UNTITLED_TRACK, artist: "The Lamps" });
    expect(trendTrackLabel("   ", null)).toEqual({ title: UNTITLED_TRACK, artist: null });
    expect(trendTrackLabel("", null)).toEqual({ title: UNTITLED_TRACK, artist: null });
  });

  test("a title the list gave is kept", () => {
    expect(trendTrackLabel("Midnight Drive", null)).toEqual({ title: "Midnight Drive", artist: null });
  });
});
