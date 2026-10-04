import { describe, expect, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { EngineClient, EngineReply } from "../../engine/client";
import { MockEngine, mockEngineClient } from "../../engine/mockEngine";
import type { MockTrackSeed } from "../../engine/mockMusicStore";
import { ManualScheduler } from "../../engine/scheduler";
import type { MontageMusic } from "../../../shared/engine";
import { usePeaks, useTrackSummary } from "./MusicTrack";

// 3d.3b: the music block's waveform (`music.peaks`, K26), asked one window at a time.

const TRACK: MockTrackSeed = {
  trackId: "track-espresso-01",
  title: "Espresso",
  artist: "Sabrina Carpenter",
  durationMs: 60_000,
  explicit: false,
  highlightsMs: [12_000],
  hasCover: true,
  peaks: Array.from({ length: 1_200 }, (_, step) => (step * 37) % 1_000),
};

const ASK = { trackId: TRACK.trackId, startMs: 12_000, durationMs: 8_000, bars: 72 } as const;

describe("usePeaks", () => {
  test("a track the store does not hold is missing; a new track list asks again and finds it stored now", async () => {
    const engine = new MockEngine({ scheduler: new ManualScheduler(), latencyMs: 0 });
    const client = mockEngineClient(engine);
    const initialProps: { version: string | null } = { version: null };
    const { result, rerender } = renderHook(({ version }: { version: string | null }) => usePeaks(client, ASK, version), { initialProps });
    await waitFor(() => expect(result.current.missing).toBe(TRACK.trackId));
    expect(result.current.peaks).toBe(null);

    // A refresh stored it (the engine announces the new list through music.changed: its time moves).
    engine.seedMusicTracks([TRACK]);
    rerender({ version: "2026-10-03T12:00:00.000Z" });
    await waitFor(() => expect(result.current.peaks?.peaks).toHaveLength(72));
    expect(result.current.missing).toBe(null);
    expect(result.current.peaks?.startMs).toBe(12_000);
  });

  test("a new track list that comes while an ask is still out is not lost: the ask goes again when that one answers", async () => {
    // A client whose answers the test hands out one by one.
    const asks: ((reply: EngineReply<"music.peaks">) => void)[] = [];
    const request = (_type: "music.peaks", _payload: unknown): Promise<EngineReply<"music.peaks">> => new Promise((resolve) => asks.push(resolve));
    const client = { kind: "mock", request, subscribe: () => () => {} } as unknown as EngineClient;
    const initialProps: { version: string | null } = { version: null };
    const { result, rerender } = renderHook(({ version }: { version: string | null }) => usePeaks(client, ASK, version), { initialProps });
    expect(asks).toHaveLength(1);
    // While it is out, a refresh stores the track and the list's time moves; the ask out was answered before that.
    rerender({ version: "2026-10-03T12:00:00.000Z" });
    await act(async () => {
      asks[0]?.({ ok: false, error: { code: "NOT_FOUND", detail: `track ${TRACK.trackId} is not stored` } });
    });
    expect(asks).toHaveLength(2);
    await act(async () => {
      asks[1]?.({ ok: true, result: { peaks: Array.from({ length: 72 }, () => 500) } });
    });
    expect(result.current.peaks?.peaks).toHaveLength(72);
    expect(result.current.missing).toBe(null);
  });
});

// 3f.4: an own track is asked for by its media id, in the same hook, and is never confused with a trending track of the same id.

/** A mock whose library holds one own track of `durationMs`, answering its media id. */
async function mockWithOwnTrack(durationMs = 60_000): Promise<{ engine: MockEngine; client: EngineClient; mediaId: string }> {
  const engine = new MockEngine({ scheduler: new ManualScheduler(), latencyMs: 0 });
  engine.seedOwnMedia([{ kind: "audio", name: "my mix.mp3", bytes: 1_000, facts: { durationMs }, waveform: Array.from({ length: Math.ceil(durationMs / 50) }, (_, i) => (i * 37) % 1_001) }]);
  const client = mockEngineClient(engine);
  const listed = await client.request("media.list", { kind: "audio" });
  if (!listed.ok) throw new Error("media.list failed");
  const mediaId = listed.result.media[0]?.mediaId;
  if (mediaId === undefined) throw new Error("no own track was seeded");
  return { engine, client, mediaId };
}

describe("usePeaks for an own track", () => {
  test("asks music.peaks for the media id as an OWN track, and keeps the window it answered", async () => {
    const { client, mediaId } = await mockWithOwnTrack();
    const { result } = renderHook(() => usePeaks(client, { mediaId, startMs: 6_000, durationMs: 8_000, bars: 72 }, null));
    await waitFor(() => expect(result.current.peaks?.peaks).toHaveLength(72));
    expect(result.current.peaks?.startMs).toBe(6_000);
    expect(result.current.missing).toBe(null);
  });

  test("a track the library no longer holds is missing, and the answer names the media id", async () => {
    const { client, engine, mediaId } = await mockWithOwnTrack();
    await client.request("media.delete", { mediaId });
    void engine;
    const { result } = renderHook(() => usePeaks(client, { mediaId, startMs: 0, durationMs: 8_000, bars: 72 }, null));
    await waitFor(() => expect(result.current.missing).toBe(mediaId));
    expect(result.current.peaks).toBe(null);
  });

  test("a trending track and an own track with the SAME id are two different asks: neither answer is shown for the other", async () => {
    const { client, mediaId } = await mockWithOwnTrack();
    const initialProps: { ask: Parameters<typeof usePeaks>[1] } = { ask: { mediaId, startMs: 0, durationMs: 8_000, bars: 72 } };
    const { result, rerender } = renderHook(({ ask }: { ask: Parameters<typeof usePeaks>[1] }) => usePeaks(client, ask, null), { initialProps });
    await waitFor(() => expect(result.current.peaks?.peaks).toHaveLength(72));
    // The same string as a TRENDING id: the mock's store holds no such track, so the own answer must not be shown for it.
    rerender({ ask: { trackId: mediaId, startMs: 0, durationMs: 8_000, bars: 72 } });
    expect(result.current.peaks).toBe(null);
    await waitFor(() => expect(result.current.missing).toBe(mediaId));
  });

  test("the contract's own ask is the one sent: a source of own and a media id", async () => {
    const sent: unknown[] = [];
    const request = (_type: "music.peaks", payload: unknown): Promise<EngineReply<"music.peaks">> => {
      sent.push(payload);
      return Promise.resolve({ ok: true, result: { peaks: Array.from({ length: 16 }, () => 1) } });
    };
    const client = { kind: "mock", request, subscribe: () => () => {} } as unknown as EngineClient;
    renderHook(() => usePeaks(client, { mediaId: "media-00000007", startMs: 100, durationMs: 4_000, bars: 16 }, null));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ track: { source: "own", mediaId: "media-00000007" }, startMs: 100, durationMs: 4_000, bars: 16 });
  });
});

describe("useTrackSummary for an own track", () => {
  const own = (mediaId: string, startMs = 0): MontageMusic => ({ source: "own", mediaId, startMs });

  test("is the media's name and decoded length, found in the library's audio list", async () => {
    const { client, mediaId } = await mockWithOwnTrack(74_000);
    const { result } = renderHook(() => useTrackSummary(client, own(mediaId), null));
    expect(result.current).toEqual({ state: "loading" });
    await waitFor(() => expect(result.current.state).toBe("own"));
    expect(result.current).toEqual({ state: "own", track: { mediaId, name: "my mix.mp3", durationMs: 74_000 } });
  });

  test("a track the library does not list is told apart from one still being looked up", async () => {
    const { client } = await mockWithOwnTrack();
    const { result } = renderHook(() => useTrackSummary(client, own("media-00000404"), null));
    await waitFor(() => expect(result.current).toEqual({ state: "own-gone" }));
  });

  test("a media that is a photo is not a track: gone", async () => {
    const engine = new MockEngine({ scheduler: new ManualScheduler(), latencyMs: 0 });
    engine.seedOwnMedia([{ kind: "photo", name: "lake.jpg", bytes: 1_000 }]);
    const client = mockEngineClient(engine);
    const listed = await client.request("media.list", {});
    const photo = listed.ok ? listed.result.media[0]?.mediaId : undefined;
    const { result } = renderHook(() => useTrackSummary(client, own(photo ?? "media-none"), null));
    await waitFor(() => expect(result.current).toEqual({ state: "own-gone" }));
  });

  test("a list that was cut at 500 cannot say the track is gone: it stays unknown", async () => {
    const request = (_type: "media.list", _payload: unknown): Promise<EngineReply<"media.list">> => Promise.resolve({ ok: true, result: { media: [], total: 501 } });
    const client = { kind: "mock", request, subscribe: () => () => {} } as unknown as EngineClient;
    const { result } = renderHook(() => useTrackSummary(client, own("media-00000007"), null));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current).toEqual({ state: "loading" });
  });

  test("a failed read leaves the name unknown, never wrong", async () => {
    const request = (): Promise<EngineReply<"media.list">> => Promise.resolve({ ok: false, error: { code: "INTERNAL", detail: "the media folder could not be read" } });
    const client = { kind: "mock", request, subscribe: () => () => {} } as unknown as EngineClient;
    const { result } = renderHook(() => useTrackSummary(client, own("media-00000007"), null));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current).toEqual({ state: "loading" });
  });

  test("no music is none, and a trending track still asks music.list, never media.list", async () => {
    const engine = new MockEngine({ scheduler: new ManualScheduler(), latencyMs: 0 });
    engine.seedMusicTracks([TRACK]);
    const client = mockEngineClient(engine);
    expect(renderHook(() => useTrackSummary(client, null, null)).result.current).toEqual({ state: "none" });
    const { result } = renderHook(() => useTrackSummary(client, { source: "trending", trackId: TRACK.trackId, startMs: 0 }, null));
    await waitFor(() => expect(result.current.state).toBe("listed"));
    expect(engine.calls.some((call) => call.type === "media.list")).toBe(false);
  });

  test("another track asks again, and the answer for the old one is not shown for the new", async () => {
    const { client, mediaId } = await mockWithOwnTrack();
    const initialProps: { music: MontageMusic } = { music: own(mediaId) };
    const { result, rerender } = renderHook(({ music }: { music: MontageMusic }) => useTrackSummary(client, music, null), { initialProps });
    await waitFor(() => expect(result.current.state).toBe("own"));
    rerender({ music: own("media-00000404") });
    expect(result.current).toEqual({ state: "loading" });
    await waitFor(() => expect(result.current).toEqual({ state: "own-gone" }));
  });
});
