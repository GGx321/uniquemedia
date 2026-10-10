import { describe, expect, test } from "bun:test";
import type { MusicStatus } from "../../../shared/engine";
import { EngineStore, type EngineView } from "../../engine/store";
import { makeMock } from "../../engine/mockEngine.testkit";
import { worldKey } from "./useLaunchPlan";

// S4.10 fix B round 1: the plan is asked again when the music changes. The card said «тренды свежие» during a refresh and never re-asked, because nothing of the music was in the world the plan
// stands on.

const IDLE: MusicStatus = {
  listFetchedAt: "2026-10-09T10:00:00.000Z",
  trackCount: 30,
  bytesOnDisk: 1,
  sentLast31d: 9,
  limit: 30,
  serverRemaining: null,
  nextFreeAt: null,
  refresh: { state: "idle" },
  quotaLog: "ok",
};

const base: EngineView = new EngineStore(makeMock().client).getView();
const keyWith = (music: MusicStatus | null): string => worldKey({ ...base, music }, []);

describe("worldKey and the music", () => {
  test("stands the same for the same music", () => {
    expect(keyWith({ ...IDLE })).toBe(keyWith({ ...IDLE }));
  });

  test("changes when a refresh starts", () => {
    expect(keyWith({ ...IDLE, refresh: { state: "running", done: 0, total: 61 } })).not.toBe(keyWith(IDLE));
  });

  test("does not change with the refresh's progress, only with its state", () => {
    const at = (done: number) => keyWith({ ...IDLE, refresh: { state: "running", done, total: 61 } });
    expect(at(5)).toBe(at(40));
  });

  test("changes when the list is fetched again", () => {
    expect(keyWith({ ...IDLE, listFetchedAt: "2026-10-10T10:00:00.000Z" })).not.toBe(keyWith(IDLE));
  });

  test("changes when the number of stored tracks changes", () => {
    expect(keyWith({ ...IDLE, trackCount: 31 })).not.toBe(keyWith(IDLE));
  });

  test("changes when a request is sent", () => {
    expect(keyWith({ ...IDLE, sentLast31d: 10 })).not.toBe(keyWith(IDLE));
  });

  test("changes when the quota log becomes unreadable", () => {
    expect(keyWith({ ...IDLE, sentLast31d: 30, quotaLog: "corrupt" })).not.toBe(keyWith({ ...IDLE, sentLast31d: 30 }));
  });

  test("changes when the music status becomes known", () => {
    expect(keyWith(IDLE)).not.toBe(keyWith(null));
  });
});
