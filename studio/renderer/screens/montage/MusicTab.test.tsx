import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import type { MusicStatus } from "../../../shared/engine";
import { MockEngine, mockEngineClient } from "../../engine/mockEngine";
import { demoTracks } from "../../engine/mockMusicStore";
import { EngineProvider } from "../../engine/react";
import { ManualScheduler } from "../../engine/scheduler";
import { flush } from "../../testing";
import { createNavigation, NavigationProvider } from "../../navigation";
import { MusicTab } from "./MusicTab";
import { draftSpec } from "./testkit";

// Slice review 4-M5: the engine stores a refreshed list's time BEFORE its tracks finish downloading (and resumes downloads after a restart with the
// old time), and `music.list` answers only the stored ones. The «Музыка» tab must read the list again as the downloads land (the track count and the
// refresh's state move in `music.changed`), not only when the list's time changes, or the tracks stored after its first read never show.

afterEach(cleanup);

const FETCHED = "2026-10-05T09:00:00.000Z";

function status(trackCount: number, refresh: MusicStatus["refresh"] = { state: "idle" }): MusicStatus {
  return { listFetchedAt: FETCHED, trackCount, bytesOnDisk: 0, sentLast31d: 1, limit: 30, serverRemaining: 29, nextFreeAt: null, refresh, quotaLog: "ok" };
}

function renderTab() {
  const engine = new MockEngine({ scheduler: new ManualScheduler(), latencyMs: 0 });
  const client = mockEngineClient(engine);
  const navigation = createNavigation(() => undefined);
  const tree = (now: MusicStatus) => (
    <EngineProvider client={client}>
      <NavigationProvider value={navigation}>
        <MusicTab spec={draftSpec(2)} status={now} onPick={() => undefined} />
      </NavigationProvider>
    </EngineProvider>
  );
  const utils = render(tree(status(0, { state: "running", done: 0, total: 3 })));
  return { engine, show: (now: MusicStatus) => utils.rerender(tree(now)) };
}

const listReads = (engine: MockEngine): number => engine.calls.filter((c) => c.type === "music.list").length;
const rows = (): number => within(screen.getByRole("list", { name: "Треки в тренде" })).getAllByRole("listitem").length;

describe("the «Музыка» tab while the list's tracks download", () => {
  test("the tracks stored after the first read show up as their count grows, with the list's time unchanged", async () => {
    const { engine, show } = renderTab();
    await flush();
    const first = listReads(engine);

    // One of three is stored: the engine announces the count, not a new time.
    engine.seedMusicTracks(demoTracks(1));
    await act(async () => show(status(1, { state: "running", done: 1, total: 3 })));
    await flush();
    expect(listReads(engine)).toBe(first + 1);
    expect(rows()).toBe(1);

    engine.seedMusicTracks(demoTracks(3));
    await act(async () => show(status(3, { state: "idle" })));
    await flush();
    expect(listReads(engine)).toBe(first + 2);
    expect(rows()).toBe(3);
  });

  test("a status heard again with nothing new reads nothing", async () => {
    const { engine, show } = renderTab();
    await flush();
    const first = listReads(engine);
    await act(async () => show(status(0, { state: "running", done: 0, total: 3 })));
    await flush();
    expect(listReads(engine)).toBe(first);
  });
});
