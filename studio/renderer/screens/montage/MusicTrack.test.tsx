import { describe, expect, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { EngineClient, EngineReply } from "../../engine/client";
import { MockEngine, mockEngineClient } from "../../engine/mockEngine";
import type { MockTrackSeed } from "../../engine/mockMusicStore";
import { ManualScheduler } from "../../engine/scheduler";
import { usePeaks } from "./MusicTrack";

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
