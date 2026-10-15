import { describe, expect, test } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import type { CommandPayload, CommandType } from "../../../shared/engine";
import type { EngineClient, EngineReply } from "../../engine/client";
import { MockEngine, mockEngineClient } from "../../engine/mockEngine";
import { ManualScheduler } from "../../engine/scheduler";
import type { EngineStore } from "../../engine/store";
import type { RecordsRead } from "./ownMedia";
import { useOwnVideos, videoLookup } from "./ownVideos";

// 5b.2, S5.WA4 round 3: the editor must know whether the read of its draft's videos is under way, failed or done — a failed one is told and tried again
// (it would otherwise stay «not known» for good, and the frame rule fails closed on it) — and must be able to ask for it again.

const DEMO = "media-demo-0002";

/** The dev build's mock behind a client whose `media.list` by id answers INTERNAL while `failing` says so. */
function flaky() {
  const engine = new MockEngine({ scheduler: new ManualScheduler(), latencyMs: 0, preset: "demo" });
  const real = mockEngineClient(engine);
  const state = { failing: true, lists: 0 };
  const client: Pick<EngineClient, "request" | "subscribe"> = {
    request<T extends CommandType>(type: T, payload: CommandPayload<T>): Promise<EngineReply<T>> {
      if (type === "media.list") {
        state.lists += 1;
        if (state.failing) return Promise.resolve({ ok: false, error: { code: "INTERNAL", detail: "the list could not be read" } });
      }
      return real.request(type, payload);
    },
    subscribe: (listener) => real.subscribe(listener),
  };
  const store: Pick<EngineStore, "subscribeMedia"> = { subscribeMedia: () => () => undefined };
  return { client, store, state };
}

describe("the read of the draft's videos", () => {
  test("is told under way, then failed; asked again (`attempt`), it is under way again and done, and the video is known", async () => {
    const { client, store, state } = flaky();
    const reads: RecordsRead[] = [];
    const onRead = (read: RecordsRead): void => void reads.push(read);
    const { result, rerender } = renderHook(({ attempt }) => useOwnVideos(client, [DEMO], store, { attempt, onRead }), { initialProps: { attempt: 0 } });
    await waitFor(() => expect(reads).toEqual(["reading", "failed"]));
    expect(videoLookup(result.current, DEMO)).toEqual({ state: "unknown" });
    state.failing = false;
    rerender({ attempt: 1 });
    await waitFor(() => expect(reads).toEqual(["reading", "failed", "reading", "done"]));
    expect(videoLookup(result.current, DEMO).state).toBe("known");
    expect(state.lists).toBe(2);
  });

  test("a draft with no own video reads nothing and is done", async () => {
    const { client, store, state } = flaky();
    const reads: RecordsRead[] = [];
    renderHook(() => useOwnVideos(client, [], store, { onRead: (read) => void reads.push(read) }));
    await waitFor(() => expect(reads).toEqual(["done"]));
    expect(state.lists).toBe(0);
  });
});
