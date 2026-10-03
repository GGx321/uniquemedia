import { describe, expect, test } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
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
});
