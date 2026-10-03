import { describe, expect, test } from "bun:test";
import { MUSIC_QUOTA_WINDOW_DAYS, MusicStatus, type EngineError, type EventMessage } from "../../shared/engine";
import { makeMock, unwrap, type Mock } from "./mockEngine.testkit";

// 3c.6: the dev mock answers the music status, the confirmed refresh and the recovery of a damaged quota log as the engine
// does (studio/engine/music/service.ts), so the Settings card can be built and tested on it. What it does not model: the
// list's tracks (`music.list` and `music.peaks` stay unanswered until the editor's music tab, 3d.5), and real downloads.

const DAY = 24 * 3600 * 1000;
const WINDOW = MUSIC_QUOTA_WINDOW_DAYS * DAY;
/** The mock's clock at its start (mockEngine.ts START_OF_TIME). */
const START = Date.UTC(2026, 8, 24, 10, 0, 0);
const KEY = { stored: true, last4: "7c1e", rejected: false } as const;

const status = async (mock: Mock) => MusicStatus.parse(await unwrap(mock.client.request("music.status", {})));
const refresh = (mock: Mock) => mock.client.request("music.refresh", { confirm: true });
const recover = (mock: Mock) => mock.client.request("music.recoverQuotaLog", { confirm: true });

async function refused(reply: ReturnType<typeof refresh>): Promise<EngineError> {
  const answer = await reply;
  if (answer.ok) throw new Error("expected a refusal");
  return answer.error;
}

const musicEvents = (mock: Mock, from = 0): MusicStatus[] =>
  mock.events.slice(from).flatMap((e: EventMessage) => (e.type === "music.changed" ? [e.payload.status] : []));

describe("music.status", () => {
  test("of a fresh mock: the engine's never-refreshed status", async () => {
    expect(await status(makeMock())).toEqual({ listFetchedAt: null, trackCount: 0, bytesOnDisk: 0, sentLast31d: 0, limit: 30, serverRemaining: null, nextFreeAt: null, refresh: { state: "idle" }, quotaLog: "ok" });
  });

  test("of a seeded mock: the count in the window, and the oldest send's leaving as nextFreeAt", async () => {
    const mock = makeMock({ musicKey: KEY, music: { sendsDaysAgo: [22, 10, 3], list: { fetchedAt: "2026-09-21T11:02:00.000Z", trackCount: 30, bytesOnDisk: 94_000_000 } } });
    expect(await status(mock)).toMatchObject({ sentLast31d: 3, nextFreeAt: new Date(START - 22 * DAY + WINDOW).toISOString(), listFetchedAt: "2026-09-21T11:02:00.000Z", trackCount: 30, bytesOnDisk: 94_000_000 });
  });

  test("a send exactly 31 days old has left the window", async () => {
    const mock = makeMock({ music: { sendsDaysAgo: [31, 30] } });
    expect((await status(mock)).sentLast31d).toBe(1);
  });

  test("clamps the count at 30", async () => {
    const mock = makeMock({ music: { sendsDaysAgo: Array.from({ length: 34 }, () => 1) } });
    expect((await status(mock)).sentLast31d).toBe(30);
  });
});

describe("music.refresh, refused at no cost in the engine's order", () => {
  test("no key: MUSIC_KEY_MISSING", async () => {
    const mock = makeMock();
    expect((await refused(refresh(mock))).code).toBe("MUSIC_KEY_MISSING");
    expect((await status(mock)).sentLast31d).toBe(0);
  });

  test("a rejected key: MUSIC_KEY_REJECTED", async () => {
    const mock = makeMock({ musicKey: { ...KEY, rejected: true } });
    expect((await refused(refresh(mock))).code).toBe("MUSIC_KEY_REJECTED");
  });

  test("29 sends: one more leaves and takes the 30th; then it is refused", async () => {
    const mock = makeMock({ musicKey: KEY, music: { sendsDaysAgo: Array.from({ length: 29 }, () => 2) } });
    expect((await unwrap(refresh(mock))).status).toMatchObject({ sentLast31d: 30, refresh: { state: "running" } });
    mock.scheduler.runAll();
    const error = await refused(refresh(mock));
    expect(error.code).toBe("MUSIC_QUOTA_EXHAUSTED");
  });

  test.each([30, 31])("%i sends: MUSIC_QUOTA_EXHAUSTED", async (count) => {
    const mock = makeMock({ musicKey: KEY, music: { sendsDaysAgo: Array.from({ length: count }, () => 2) } });
    expect((await refused(refresh(mock))).code).toBe("MUSIC_QUOTA_EXHAUSTED");
  });

  test("the server said 0 remained a day ago: MUSIC_QUOTA_EXHAUSTED although the local count is low", async () => {
    const mock = makeMock({ musicKey: KEY, music: { sendsDaysAgo: [1], serverRemaining: { value: 0, daysAgo: 1 } } });
    expect((await refused(refresh(mock))).code).toBe("MUSIC_QUOTA_EXHAUSTED");
    expect(await status(mock)).toMatchObject({ serverRemaining: 0, nextFreeAt: new Date(START - DAY + WINDOW).toISOString() });
  });

  test.each([
    ["held", "log-held"],
    ["corrupt", "log-corrupt"],
    ["unreadable", "log-unreadable"],
  ] as const)("a %s log: MUSIC_UNAVAILABLE %s, nothing counted", async (quotaLog, musicReason) => {
    const mock = makeMock({ musicKey: KEY, music: { quotaLog } });
    expect(await refused(refresh(mock))).toMatchObject({ code: "MUSIC_UNAVAILABLE", musicReason });
  });

  test("a second refresh while one runs: IN_FLIGHT", async () => {
    const mock = makeMock({ musicKey: KEY });
    await unwrap(refresh(mock));
    expect((await refused(refresh(mock))).code).toBe("IN_FLIGHT");
    expect((await status(mock)).sentLast31d).toBe(1);
  });
});

describe("a refresh that goes through", () => {
  test("answers at once with the status running and one more send, then ends idle with a new list", async () => {
    const mock = makeMock({ musicKey: KEY, music: { sendsDaysAgo: [5] } });
    const mark = mock.events.length;
    expect((await unwrap(refresh(mock))).status).toMatchObject({ sentLast31d: 2, refresh: { state: "running", done: 0 } });
    mock.scheduler.runAll();
    const announced = musicEvents(mock, mark);
    expect(announced[0]?.refresh.state).toBe("running");
    expect(announced.some((s) => s.refresh.state === "running" && s.refresh.done > 0)).toBe(true);
    expect(announced.at(-1)).toMatchObject({ refresh: { state: "idle" }, trackCount: 30, sentLast31d: 2, serverRemaining: 28 });
    expect(announced.at(-1)?.listFetchedAt).not.toBeNull();
  });

  test("a failure the test scripts ends it failed, still counted, and the list stays as it was", async () => {
    const mock = makeMock({ musicKey: KEY });
    mock.engine.failNextMusicRefresh({ code: "MUSIC_UNAVAILABLE", musicReason: "network", detail: "the request failed" });
    await unwrap(refresh(mock));
    mock.scheduler.runAll();
    expect(await status(mock)).toMatchObject({ sentLast31d: 1, listFetchedAt: null, refresh: { state: "failed", error: { code: "MUSIC_UNAVAILABLE", musicReason: "network" } } });
  });

  test("a 401 the test scripts marks the key rejected", async () => {
    const mock = makeMock({ musicKey: KEY });
    mock.engine.failNextMusicRefresh({ code: "MUSIC_KEY_REJECTED" });
    await unwrap(refresh(mock));
    mock.scheduler.runAll();
    expect((await unwrap(mock.client.request("settings.get", {}))).musicKey.rejected).toBe(true);
  });
});

describe("music.recoverQuotaLog", () => {
  test("a corrupt log reads 30 of 30; recovering it closes the quota for exactly 31 days and announces it", async () => {
    const mock = makeMock({ musicKey: KEY, music: { quotaLog: "corrupt" } });
    expect(await status(mock)).toMatchObject({ quotaLog: "corrupt", sentLast31d: 30, nextFreeAt: null });
    const mark = mock.events.length;
    const answer = await unwrap(recover(mock));
    expect(answer.status).toMatchObject({ quotaLog: "ok", sentLast31d: 30, serverRemaining: null, nextFreeAt: new Date(START + WINDOW).toISOString() });
    expect(musicEvents(mock, mark)).toEqual([answer.status]);
    expect((await refused(refresh(mock))).code).toBe("MUSIC_QUOTA_EXHAUSTED");
  });

  test("a sound log: VALIDATION, nothing changed", async () => {
    const mock = makeMock({ music: { sendsDaysAgo: [3] } });
    const mark = mock.events.length;
    expect((await refused(recover(mock))).code).toBe("VALIDATION");
    expect((await status(mock)).sentLast31d).toBe(1);
    expect(musicEvents(mock, mark)).toEqual([]);
  });

  test("a held log is not damaged either: VALIDATION", async () => {
    expect((await refused(recover(makeMock({ music: { quotaLog: "held" } })))).code).toBe("VALIDATION");
  });

  test("an unreadable log: MUSIC_UNAVAILABLE log-unreadable", async () => {
    expect(await refused(recover(makeMock({ music: { quotaLog: "unreadable" } })))).toMatchObject({ code: "MUSIC_UNAVAILABLE", musicReason: "log-unreadable" });
  });

  // Review round 1: a log deleted with the music folder (its marker outside says it existed) reads missing, like the engine's.
  test("a missing log reads 30 of 30, refuses a refresh as log-missing, and is recovered like a corrupt one", async () => {
    const mock = makeMock({ musicKey: KEY, music: { quotaLog: "missing" } });
    expect(await status(mock)).toMatchObject({ quotaLog: "missing", sentLast31d: 30, nextFreeAt: null });
    expect(await refused(refresh(mock))).toMatchObject({ code: "MUSIC_UNAVAILABLE", musicReason: "log-missing" });
    expect((await unwrap(recover(mock))).status).toMatchObject({ quotaLog: "ok", sentLast31d: 30 });
  });

  test("while a refresh runs the recovery is refused IN_FLIGHT, as the engine's", async () => {
    const mock = makeMock({ musicKey: KEY });
    await unwrap(refresh(mock));
    mock.engine.setMusicQuotaLog("corrupt");
    expect((await refused(recover(mock))).code).toBe("IN_FLIGHT");
  });

  test("the log can be damaged by a test control while the app runs", async () => {
    const mock = makeMock({ musicKey: KEY });
    mock.engine.setMusicQuotaLog("corrupt");
    expect((await status(mock)).quotaLog).toBe("corrupt");
  });
});
