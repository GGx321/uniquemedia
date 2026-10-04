import { describe, expect, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { CommandPayload, CommandType } from "../../../shared/engine";
import type { EngineClient, EngineReply } from "../../engine/client";
import { MockEngine, mockEngineClient } from "../../engine/mockEngine";
import { ManualScheduler } from "../../engine/scheduler";
import { useOwnStickers } from "./ownStickers";

// 3f.5, fix round 1: the editor asks for the own stickers its draft names BY ID (`media.list {mediaIds}`), not for the newest 500 of them, so an old
// sticker the draft still uses is drawn; and a list that cannot be read leaves the preview empty without an unhandled rejection.

interface Asked {
  readonly type: string;
  readonly payload: unknown;
}

/** The mock engine behind a client that notes what was asked. `fail` makes `media.list` reject. */
function watched(options: { fail?: boolean } = {}): { client: Pick<EngineClient, "request" | "subscribe">; engine: MockEngine; scheduler: ManualScheduler; asked: Asked[] } {
  const scheduler = new ManualScheduler();
  const engine = new MockEngine({ scheduler, latencyMs: 0, preset: "demo", seedOwnSticker: true });
  const real = mockEngineClient(engine);
  const asked: Asked[] = [];
  const client: Pick<EngineClient, "request" | "subscribe"> = {
    request<T extends CommandType>(type: T, payload: CommandPayload<T>): Promise<EngineReply<T>> {
      asked.push({ type, payload });
      if (options.fail === true && type === "media.list") return Promise.reject(new Error("the engine is gone"));
      return real.request(type, payload);
    },
    subscribe: (listener) => real.subscribe(listener),
  };
  return { client, engine, scheduler, asked };
}

const SEEDED = "media-seed-0001";
const listsOf = (asked: readonly Asked[]): unknown[] => asked.filter((a) => a.type === "media.list").map((a) => a.payload);

describe("useOwnStickers", () => {
  test("asks for the stickers the draft names by id, of the sticker kind, and holds what comes back", async () => {
    const { client, asked } = watched();
    const { result } = renderHook(() => useOwnStickers(client, [SEEDED]));
    await waitFor(() => expect(result.current.has(SEEDED)).toBe(true));
    expect(listsOf(asked)).toEqual([{ kind: "sticker", mediaIds: [SEEDED] }]);
    expect(result.current.get(SEEDED)).toMatchObject({ mediaId: SEEDED, width: 240, height: 240, loopFrames: 24 });
  });

  test("asks once for the same ids in any order, and each id once", async () => {
    const { client, asked } = watched();
    const { result, rerender } = renderHook(({ ids }: { ids: readonly string[] }) => useOwnStickers(client, ids), { initialProps: { ids: [SEEDED, "media-00000404", SEEDED] as readonly string[] } });
    await waitFor(() => expect(result.current.has(SEEDED)).toBe(true));
    rerender({ ids: ["media-00000404", SEEDED] });
    await act(async () => undefined);
    expect(listsOf(asked)).toEqual([{ kind: "sticker", mediaIds: ["media-00000404", SEEDED] }]);
  });

  test("asks nothing while the draft names no own sticker", async () => {
    const { client, asked } = watched();
    const { result } = renderHook(() => useOwnStickers(client, []));
    await act(async () => undefined);
    expect(listsOf(asked)).toEqual([]);
    expect(result.current.size).toBe(0);
  });

  test("asks again when the draft names another sticker, and holds both", async () => {
    const { client, asked, engine, scheduler } = watched();
    engine.pickMediaNext([{ name: "new.gif", accept: { kind: "sticker", bytes: 100, facts: { width: 10, height: 10, loopFrames: 4, delayFrames: [2, 2] } } }]);
    await client.request("media.pickImport", { kind: "sticker" });
    act(() => scheduler.runAll());
    const listed = await client.request("media.list", { kind: "sticker" });
    const fresh = listed.ok ? listed.result.media.find((m) => m.name === "new.gif")?.mediaId : undefined;
    if (fresh === undefined) throw new Error("the sticker was not stored");
    asked.length = 0;
    const { result, rerender } = renderHook(({ ids }: { ids: readonly string[] }) => useOwnStickers(client, ids), { initialProps: { ids: [SEEDED] as readonly string[] } });
    await waitFor(() => expect(result.current.has(SEEDED)).toBe(true));
    rerender({ ids: [SEEDED, fresh] });
    await waitFor(() => expect(result.current.has(fresh)).toBe(true));
    expect(result.current.has(SEEDED)).toBe(true);
    expect(listsOf(asked)).toEqual([
      { kind: "sticker", mediaIds: [SEEDED] },
      { kind: "sticker", mediaIds: [fresh, SEEDED].sort() },
    ]);
  });

  test("a list that cannot be read leaves the map empty and raises nothing", async () => {
    const { client, asked } = watched({ fail: true });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { result } = renderHook(() => useOwnStickers(client, [SEEDED]));
      await waitFor(() => expect(listsOf(asked)).toHaveLength(1));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(result.current.size).toBe(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("a sticker deleted afterwards is dropped (media.changed), with no second list", async () => {
    const { client, asked } = watched();
    const { result } = renderHook(() => useOwnStickers(client, [SEEDED]));
    await waitFor(() => expect(result.current.has(SEEDED)).toBe(true));
    await client.request("media.delete", { mediaId: SEEDED });
    await waitFor(() => expect(result.current.has(SEEDED)).toBe(false));
    expect(listsOf(asked)).toHaveLength(1);
  });
});
