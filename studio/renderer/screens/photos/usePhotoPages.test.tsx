import { describe, expect, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PhotoSummary } from "../../../shared/engine";
import type { EngineClient } from "../../engine/client";
import { makeMock, MIA, scenePhoto } from "../../engine/mockEngine.testkit";
import { usePhotoPages } from "./usePhotoPages";

// The queue of reads behind the gallery and the editor's bin, on the hook alone (the screen-level races are in PhotosMoreRaces.test.tsx).

const photos = Array.from({ length: 6 }, (_unused, i) => scenePhoto(i + 1));

/** A client over the mock whose photos.list answers can be held back: the answer is taken when asked, and handed over on `release`. */
function holdableClient(library: PhotoSummary[] = photos): { client: EngineClient; hold: () => void; release: () => void } {
  const { client } = makeMock({ photos: library, avatars: [{ ...MIA, photoCount: library.length, eligibleUnusedCount: library.length }] });
  let holding = false;
  const held: (() => void)[] = [];
  const request: EngineClient["request"] = async (type, payload) => {
    const reply = await client.request(type, payload);
    if (type !== "photos.list" || !holding) return reply;
    await new Promise<void>((resolve) => held.push(resolve));
    return reply;
  };
  return {
    client: { ...client, request },
    hold: () => {
      holding = true;
    },
    release: () => {
      holding = false;
      held.splice(0).forEach((resolve) => resolve());
    },
  };
}

describe("a mark set while a read is in flight (LOW-B)", () => {
  test("a re-read answered from before the mark does not take the mark back", async () => {
    const { client, hold, release } = holdableClient();
    const { result, rerender } = renderHook(({ key }) => usePhotoPages(client, MIA.avatarId, { enabled: true, refresh: [key] }), { initialProps: { key: "a" } });
    await waitFor(() => expect(result.current.pages?.photos).toHaveLength(6));
    const target = result.current.pages?.photos[0];
    if (target === undefined) throw new Error("no photo");

    hold();
    rerender({ key: "b" }); // a reason to read again: the read starts and its answer (the photo not rejected yet) is held back
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    act(() => result.current.replace({ ...target, rejected: true })); // the mark, answered by the engine meanwhile
    expect(result.current.pages?.photos[0]?.rejected).toBe(true);

    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current.pages?.photos[0]?.rejected).toBe(true);
  });

  test("a mark set before the read started is the read's to answer: the read's word stands", async () => {
    const { client, hold, release } = holdableClient();
    const { result, rerender } = renderHook(({ key }) => usePhotoPages(client, MIA.avatarId, { enabled: true, refresh: [key] }), { initialProps: { key: "a" } });
    await waitFor(() => expect(result.current.pages?.photos).toHaveLength(6));
    const target = result.current.pages?.photos[0];
    if (target === undefined) throw new Error("no photo");

    act(() => result.current.replace({ ...target, rejected: true })); // before any read is in flight
    hold();
    rerender({ key: "b" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current.pages?.photos[0]?.rejected).toBe(false);
  });

  test("a mark set during one read does not outlive it: the next read's word on the photo stands", async () => {
    const { client, hold, release } = holdableClient();
    const { result, rerender } = renderHook(({ key }) => usePhotoPages(client, MIA.avatarId, { enabled: true, refresh: [key] }), { initialProps: { key: "a" } });
    await waitFor(() => expect(result.current.pages?.photos).toHaveLength(6));
    const target = result.current.pages?.photos[0];
    if (target === undefined) throw new Error("no photo");
    const pass = (): Promise<void> =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

    hold();
    rerender({ key: "b" }); // read A starts, its answer held back
    await pass();
    act(() => result.current.replace({ ...target, rejected: true })); // the mark, during A
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current.pages?.photos[0]?.rejected).toBe(true); // A landed with the mark kept

    rerender({ key: "c" }); // read B: the engine says the photo is not rejected (the mark was undone elsewhere)
    await pass();
    await waitFor(() => expect(result.current.pages?.photos[0]?.rejected).toBe(false));
  });
});
