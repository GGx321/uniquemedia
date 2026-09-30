import { describe, expect, test } from "bun:test";
import { parseEngineCommand, parseMessage } from "./messages";
import { ENGINE_COMMAND_TYPES } from "./commands";
import { MusicStatus } from "./state";
import { PROTOCOL_VERSION } from ".";

// Stage 3, task 3c.3: the music status (K24) and the commands and event around it (K25).

const idle = {
  listFetchedAt: "2026-09-27T20:42:44.190Z",
  trackCount: 30,
  bytesOnDisk: 52_000_000,
  sentLast31d: 2,
  limit: 30,
  serverRemaining: 28,
  nextFreeAt: "2026-10-28T20:42:44.190Z",
  refresh: { state: "idle" },
};

describe("MusicStatus", () => {
  test("accepts an idle status with a list", () => {
    expect(MusicStatus.safeParse(idle).success).toBe(true);
  });

  test("accepts a status that never refreshed: no list, no server count, no next free time", () => {
    const fresh = { ...idle, listFetchedAt: null, trackCount: 0, bytesOnDisk: 0, sentLast31d: 0, serverRemaining: null, nextFreeAt: null };
    expect(MusicStatus.safeParse(fresh).success).toBe(true);
  });

  test("accepts a running refresh with its progress", () => {
    expect(MusicStatus.safeParse({ ...idle, refresh: { state: "running", done: 3, total: 61 } }).success).toBe(true);
  });

  test("rejects a running refresh that is further along than its total", () => {
    expect(MusicStatus.safeParse({ ...idle, refresh: { state: "running", done: 4, total: 3 } }).success).toBe(false);
  });

  test("accepts a failed refresh with its error", () => {
    const failed = { state: "failed", error: { code: "MUSIC_KEY_REJECTED" } };
    expect(MusicStatus.safeParse({ ...idle, refresh: failed }).success).toBe(true);
  });

  test("rejects a failed refresh without an error, and an unknown state", () => {
    expect(MusicStatus.safeParse({ ...idle, refresh: { state: "failed" } }).success).toBe(false);
    expect(MusicStatus.safeParse({ ...idle, refresh: { state: "paused" } }).success).toBe(false);
  });

  test.each([
    ["thirty sends, the most the window can hold", 30, true],
    ["thirty-one sends", 31, false],
    ["a negative count", -1, false],
    ["a fractional count", 1.5, false],
  ])("sentLast31d: %s", (_label, sentLast31d, ok) => {
    expect(MusicStatus.safeParse({ ...idle, sentLast31d }).success).toBe(ok);
  });

  test("the limit is 30", () => {
    expect(MusicStatus.safeParse({ ...idle, limit: 25 }).success).toBe(false);
  });

  test("rejects a nextFreeAt that is not an ISO time, and an unknown field", () => {
    expect(MusicStatus.safeParse({ ...idle, nextFreeAt: "tomorrow" }).success).toBe(false);
    expect(MusicStatus.safeParse({ ...idle, apiKey: "x" }).success).toBe(false);
  });
});

describe("the music commands and event", () => {
  const send = (type: string, payload: unknown) => parseEngineCommand({ v: PROTOCOL_VERSION, id: "cmd-00000001", kind: "command", type, payload }).ok;
  const event = (payload: unknown) => ({ v: PROTOCOL_VERSION, id: "evt-00000001", kind: "event", seq: 1, bootId: "boot-00000001", type: "music.changed", payload });

  test("music.refresh needs confirm: true, so a stray call cannot spend a request", () => {
    expect(send("music.refresh", { confirm: true })).toBe(true);
    expect(send("music.refresh", {})).toBe(false);
    expect(send("music.refresh", { confirm: false })).toBe(false);
    expect(send("music.refresh", { confirm: "yes" })).toBe(false);
  });

  test("music.status takes an empty payload", () => {
    expect(send("music.status", {})).toBe(true);
    expect(send("music.status", { refresh: true })).toBe(false);
  });

  test("music.changed carries the whole status and nothing else", () => {
    expect(parseMessage(event({ status: idle })).ok).toBe(true);
    expect(parseMessage(event({ status: idle, key: "x" })).ok).toBe(false);
    expect(parseMessage(event({})).ok).toBe(false);
  });

  test("the music commands are the engine's, not main's", () => {
    expect(ENGINE_COMMAND_TYPES).toContain("music.status");
    expect(ENGINE_COMMAND_TYPES).toContain("music.refresh");
  });
});
