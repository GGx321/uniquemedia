import { describe, expect, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import { MockEngine, mockEngineClient } from "../../engine/mockEngine";
import { ManualScheduler } from "../../engine/scheduler";
import type { MediaSignal } from "../../engine/store";
import { useOwnPhotos } from "./ownPhotos";

// The own photos of the preview follow the STORE's media signals (as the stickers and videos do), and are listed again when the store resyncs.

async function rig() {
  const engine = new MockEngine({ scheduler: new ManualScheduler(), latencyMs: 0, preset: "demo" });
  engine.seedOwnMedia([{ kind: "photo", name: "p.jpg", bytes: 1000, createdAt: "2026-09-22T09:00:00.000Z" }]);
  const client = mockEngineClient(engine);
  const listed = await client.request("media.list", { kind: "photo" });
  if (!listed.ok) throw new Error("media.list failed");
  const mediaId = listed.result.media[0]?.mediaId ?? "";
  const listeners = new Set<(signal: MediaSignal) => void>();
  const store = {
    subscribeMedia: (listener: (signal: MediaSignal) => void): (() => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  return { client, store, mediaId, emit: (signal: MediaSignal): void => listeners.forEach((l) => l(signal)) };
}

describe("useOwnPhotos follows the store", () => {
  test("a removal the store applies drops the record", async () => {
    const { client, store, mediaId, emit } = await rig();
    const { result } = renderHook(() => useOwnPhotos(client, [mediaId], store));
    await waitFor(() => expect(result.current.held.has(mediaId)).toBe(true));

    act(() => emit({ change: "removed", mediaId }));

    await waitFor(() => expect(result.current.held.has(mediaId)).toBe(false));
  });

  test("after a resync the records are listed again: a removal lost in the gap is made up", async () => {
    const { client, store, mediaId, emit } = await rig();
    const { result } = renderHook(() => useOwnPhotos(client, [mediaId], store));
    await waitFor(() => expect(result.current.held.has(mediaId)).toBe(true));
    await client.request("media.delete", { mediaId });
    expect(result.current.held.has(mediaId)).toBe(true);

    act(() => emit({ change: "resynced" }));

    await waitFor(() => expect(result.current.held.has(mediaId)).toBe(false));
  });
});
