import { describe, expect, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { CommandPayload, CommandType } from "../../../shared/engine";
import type { EngineClient, EngineReply } from "../../engine/client";
import { MockEngine, mockEngineClient } from "../../engine/mockEngine";
import { ManualScheduler } from "../../engine/scheduler";
import type { MediaSignal } from "../../engine/store";
import { useOwnStickers } from "./ownStickers";

// L5: the editor's own-media records follow the STORE's media signals, not the raw event stream: a `media.changed` lost in a gap or an engine restart is made up for
// when the store takes a snapshot again (`resynced`), because the records are listed again then.

const SEEDED = "media-seed-0001";

function rig() {
  const scheduler = new ManualScheduler();
  const engine = new MockEngine({ scheduler, latencyMs: 0, preset: "demo", seedOwnSticker: true });
  const real = mockEngineClient(engine);
  let rawSubscriptions = 0;
  let lists = 0;
  const client: Pick<EngineClient, "request" | "subscribe"> = {
    request<T extends CommandType>(type: T, payload: CommandPayload<T>): Promise<EngineReply<T>> {
      if (type === "media.list") lists++;
      return real.request(type, payload);
    },
    subscribe: (listener) => {
      rawSubscriptions++;
      return real.subscribe(listener);
    },
  };
  const listeners = new Set<(signal: MediaSignal) => void>();
  const store = {
    subscribeMedia: (listener: (signal: MediaSignal) => void): (() => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  const emit = (signal: MediaSignal): void => listeners.forEach((listener) => listener(signal));
  return { client, store, emit, real, counts: { raw: () => rawSubscriptions, lists: () => lists } };
}

describe("useOwnStickers follows the store", () => {
  test("it never listens to the raw event stream", async () => {
    const { client, store, counts } = rig();
    const { result } = renderHook(() => useOwnStickers(client, [SEEDED], store));
    await waitFor(() => expect(result.current.has(SEEDED)).toBe(true));

    expect(counts.raw()).toBe(0);
  });

  test("a media.changed the store applies updates the records", async () => {
    const { client, store, emit } = rig();
    const { result } = renderHook(() => useOwnStickers(client, [SEEDED], store));
    await waitFor(() => expect(result.current.has(SEEDED)).toBe(true));

    act(() => emit({ change: "removed", mediaId: SEEDED }));

    await waitFor(() => expect(result.current.has(SEEDED)).toBe(false));
  });

  test("after the store resyncs the records are listed again: a removal lost in the gap is made up", async () => {
    const { client, store, emit, real, counts } = rig();
    const { result } = renderHook(() => useOwnStickers(client, [SEEDED], store));
    await waitFor(() => expect(result.current.has(SEEDED)).toBe(true));
    // The sticker goes while this window hears nothing (a gap in the event sequence).
    await real.request("media.delete", { mediaId: SEEDED });
    expect(result.current.has(SEEDED)).toBe(true);

    act(() => emit({ change: "resynced" }));

    await waitFor(() => expect(result.current.has(SEEDED)).toBe(false));
    expect(counts.lists()).toBe(2);
  });
});
