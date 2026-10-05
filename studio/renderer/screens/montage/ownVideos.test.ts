import { describe, expect, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { CommandPayload, CommandType, MediaSummary, MontageDraft, MontageIssue } from "../../../shared/engine";
import type { EngineClient, EngineReply } from "../../engine/client";
import { MockEngine, mockEngineClient } from "../../engine/mockEngine";
import { ManualScheduler } from "../../engine/scheduler";
import type { EngineStore } from "../../engine/store";
import { NO_RECORDS, applyRecordsChange } from "./ownMedia";
import { ownVideoOf, type OwnVideos, useOwnVideos, videoLookup, videoProblems } from "./ownVideos";
import { draftSpec, photoClip, videoClip } from "./testkit";

// 3f.3b: what the editor knows of the own videos its draft's clips play. Each is asked for BY ID (`media.list {kind: "video", mediaIds}`), followed by
// `media.changed`, and is known (its record: name, stored size, length, source rate, tone-mapped), gone (the library answered and does not hold it as a
// video) or unknown (not answered yet, or the engine could not be asked: nothing is said about it then). The clips' problems are the engine's verdict for
// the spec on screen, as is; for an edit the engine has not judged yet, the window's own guess from the records, through the SHARED `ownVideoIssues`.

const summary = (over: Partial<MediaSummary> = {}): MediaSummary => ({
  mediaId: "media-own-0001",
  kind: "video",
  name: "latte-pour.mov",
  bytes: 4_000_000,
  createdAt: "2026-10-04T10:00:00.000Z",
  width: 1_080,
  height: 1_920,
  durationMs: 6_400,
  sourceFps: 60,
  hdrToSdr: true,
  loopFrames: null,
  delayFrames: null,
  ...over,
});

const LATTE = { mediaId: "media-own-0001", name: "latte-pour.mov", width: 1_080, height: 1_920, durationMs: 6_400, sourceFps: 60, hdrToSdr: true };

const known = (...videos: (typeof LATTE)[]): OwnVideos => ({ held: new Map(videos.map((v) => [v.mediaId, v])), answered: new Set(videos.map((v) => v.mediaId)) });

describe("ownVideoOf", () => {
  test("keeps what the editor shows and draws of a video's record", () => {
    expect(ownVideoOf(summary())).toEqual(LATTE);
  });

  test("is null for a record of another kind, or a video with no size or length (the contract makes that impossible; the editor does not guess)", () => {
    expect(ownVideoOf(summary({ kind: "photo", durationMs: null, sourceFps: null, hdrToSdr: false }))).toBeNull();
    expect(ownVideoOf({ ...summary(), width: null })).toBeNull();
    expect(ownVideoOf({ ...summary(), durationMs: null })).toBeNull();
    expect(ownVideoOf({ ...summary(), sourceFps: null })).toBeNull();
  });
});

describe("applyRecordsChange", () => {
  test("a stored video is held and answered; one deleted is answered and no longer held; anything else changes nothing", () => {
    const stored = applyRecordsChange(NO_RECORDS, { change: "upserted", media: summary() }, ownVideoOf);
    expect(videoLookup(stored, "media-own-0001")).toEqual({ state: "known", video: LATTE });
    const removed = applyRecordsChange(stored, { change: "removed", mediaId: "media-own-0001" }, ownVideoOf);
    expect(videoLookup(removed, "media-own-0001")).toEqual({ state: "gone" });
    expect(applyRecordsChange(stored, { change: "upserted", media: summary({ mediaId: "media-own-0009", kind: "audio", width: null, height: null, sourceFps: null, hdrToSdr: false }) }, ownVideoOf)).toBe(stored);
    expect(applyRecordsChange(stored, { change: "removed", mediaId: "media-own-0009" }, ownVideoOf)).toBe(stored);
  });
});

describe("videoLookup", () => {
  test("known, gone (answered and not held) or unknown (not answered)", () => {
    const videos: OwnVideos = { held: new Map([[LATTE.mediaId, LATTE]]), answered: new Set([LATTE.mediaId, "media-own-0404"]) };
    expect(videoLookup(videos, LATTE.mediaId)).toEqual({ state: "known", video: LATTE });
    expect(videoLookup(videos, "media-own-0404")).toEqual({ state: "gone" });
    expect(videoLookup(videos, "media-own-0777")).toEqual({ state: "unknown" });
  });
});

describe("videoProblems", () => {
  // A photo, then a 2 s clip from 1.8 s into the 6.4 s video, then another clip of it from 5 s: 6.4 s is too short for 5 + 2.
  const spec: MontageDraft = draftSpec([photoClip(0, "photo-mia-0001", 2_000), videoClip(1, 2_000, 1_800), { ...videoClip(2, 2_000, 5_000) }]);

  test("the engine's verdict on the spec on screen, as is, by the clip's id: only an own video clip's own issues", () => {
    const issues: MontageIssue[] = [
      { code: "photo-unavailable", path: ["clips", 0, "cell"] },
      { code: "media-unavailable", path: ["clips", 1] },
      { code: "video-too-short", path: ["clips", 1] },
      { code: "video-too-short", path: ["clips", 2] },
    ];
    expect([...videoProblems(spec, { spec, issues }, known(LATTE))]).toEqual([
      ["clip-002", "media-unavailable"],
      ["clip-003", "video-too-short"],
    ]);
  });

  test("the engine said nothing about the spec on screen: nothing, whatever the window would guess", () => {
    expect(videoProblems(spec, { spec, issues: [] }, known(LATTE)).size).toBe(0);
  });

  test("an edit the engine has not judged yet: the window's guess from the records (the shared ownVideoIssues)", () => {
    const judged = { spec: draftSpec([videoClip(0)]), issues: [{ code: "media-unavailable" as const, path: ["clips", 0] }] };
    expect([...videoProblems(spec, judged, known(LATTE))]).toEqual([["clip-003", "video-too-short"]]);
    const gone: OwnVideos = { held: new Map(), answered: new Set([LATTE.mediaId]) };
    expect([...videoProblems(spec, null, gone)]).toEqual([
      ["clip-002", "media-unavailable"],
      ["clip-003", "media-unavailable"],
    ]);
  });

  test("a video not answered for yet is guessed nothing about", () => {
    expect(videoProblems(spec, null, NO_RECORDS).size).toBe(0);
  });
});

describe("useOwnVideos", () => {
  interface Asked {
    readonly type: string;
    readonly payload: unknown;
  }

  /** The dev build's mock (it holds `demo-clip.mov` as `media-demo-0002`) behind a client that notes what was asked; `fail` makes `media.list` reject. */
  function watched(options: { fail?: boolean } = {}) {
    const scheduler = new ManualScheduler();
    const engine = new MockEngine({ scheduler, latencyMs: 0, preset: "demo" });
    const real = mockEngineClient(engine);
    const asked: Asked[] = [];
    // A failing list is rejected when the test says so. Its handlers run in one batch when it fails (ours, then the hook's): awaiting what ours
    // settles resumes the test only after that whole batch, the hook's handler included. No timer.
    const failures: { reject: () => void; handled: Promise<unknown> }[] = [];
    const client: Pick<EngineClient, "request" | "subscribe"> = {
      request<T extends CommandType>(type: T, payload: CommandPayload<T>): Promise<EngineReply<T>> {
        asked.push({ type, payload });
        if (options.fail === true && type === "media.list") {
          let reject = (): void => undefined;
          const failing = new Promise<EngineReply<T>>((_, no) => {
            reject = () => no(new Error("the engine is gone"));
          });
          failures.push({ reject, handled: failing.catch(() => undefined) });
          return failing;
        }
        return real.request(type, payload);
      },
      subscribe: (listener) => real.subscribe(listener),
    };
    // The store's media signals, as the mock's `media.changed` events make them (this test has no gaps to resync from).
    const store: Pick<EngineStore, "subscribeMedia"> = { subscribeMedia: (listener) => real.subscribe((event) => (event.type === "media.changed" ? listener(event.payload) : undefined)) };
    return { client, store, asked, failures };
  }

  const DEMO = "media-demo-0002";
  const lists = (asked: readonly Asked[]): unknown[] => asked.filter((a) => a.type === "media.list").map((a) => a.payload);

  test("asks for the videos the clips play by id, once each, of the video kind; one the library lacks is gone", async () => {
    const { client, store, asked } = watched();
    const { result } = renderHook(() => useOwnVideos(client, [DEMO, "media-00000404", DEMO], store));
    await waitFor(() => expect(videoLookup(result.current, DEMO).state).toBe("known"));
    expect(lists(asked)).toEqual([{ kind: "video", mediaIds: ["media-00000404", DEMO] }]);
    expect(videoLookup(result.current, DEMO)).toEqual({ state: "known", video: { mediaId: DEMO, name: "demo-clip.mov", width: 1_080, height: 608, durationMs: 14_000, sourceFps: 29.97, hdrToSdr: false } });
    expect(videoLookup(result.current, "media-00000404")).toEqual({ state: "gone" });
  });

  test("asks nothing while the draft plays no own video", async () => {
    const { client, store, asked } = watched();
    renderHook(() => useOwnVideos(client, [], store));
    await act(async () => undefined);
    expect(lists(asked)).toEqual([]);
  });

  test("a list that cannot be read leaves every video unknown, never gone, and raises nothing", async () => {
    const { client, store, asked, failures } = watched({ fail: true });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { result } = renderHook(() => useOwnVideos(client, [DEMO], store));
      await waitFor(() => expect(lists(asked)).toHaveLength(1));
      // The list fails now; awaiting our handler's result lets the hook's, queued with it, run first.
      await act(async () => {
        failures[0]?.reject();
        await failures[0]?.handled;
      });
      expect(videoLookup(result.current, DEMO)).toEqual({ state: "unknown" });
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("a video deleted afterwards is gone (media.changed), with no second list", async () => {
    const { client, store, asked } = watched();
    const { result } = renderHook(() => useOwnVideos(client, [DEMO], store));
    await waitFor(() => expect(videoLookup(result.current, DEMO).state).toBe("known"));
    await act(async () => {
      await client.request("media.delete", { mediaId: DEMO });
    });
    await waitFor(() => expect(videoLookup(result.current, DEMO)).toEqual({ state: "gone" }));
    expect(lists(asked)).toHaveLength(1);
  });
});
