import { describe, expect, test } from "bun:test";
import * as engine from ".";
import { PROTOCOL_VERSION, parseEngineCommand } from ".";

// S4.P2: the cursor of photos.list. It crosses a trust boundary (renderer to engine), so the request schema is the only gate.

function listCommand(payload: unknown): unknown {
  return { v: PROTOCOL_VERSION, id: "cmd-00000001", kind: "command", type: "photos.list", payload };
}

const CURSOR = "2026-09-24T11:00:00.000Z|photo-0002";

describe("photos.list request cursor", () => {
  test("a request without a cursor is still valid (old callers)", () => {
    expect(parseEngineCommand(listCommand({ avatarId: "avatar-0001" })).ok).toBe(true);
  });

  test("a request with a well-formed cursor is valid", () => {
    expect(parseEngineCommand(listCommand({ avatarId: "avatar-0001", cursor: CURSOR })).ok).toBe(true);
  });

  test.each([
    ["an empty string", ""],
    ["free text", "next page please"],
    ["a cursor with no photo id", "2026-09-24T11:00:00.000Z|"],
    ["a cursor with no timestamp", "|photo-0002"],
    ["a timestamp that is not a date", "yesterday|photo-0002"],
    ["a photo id with a path separator", "2026-09-24T11:00:00.000Z|../photo-0002"],
    ["a cursor far over the length bound", `2026-09-24T11:00:00.000Z|${"a".repeat(500)}`],
    ["a number", 7],
    ["null", null],
  ])("a forged cursor is refused by the schema: %s", (_label, cursor) => {
    expect(parseEngineCommand(listCommand({ avatarId: "avatar-0001", cursor })).ok).toBe(false);
  });

  test("an unknown extra field next to the cursor is still refused (the request stays strict)", () => {
    expect(parseEngineCommand(listCommand({ avatarId: "avatar-0001", cursor: CURSOR, limit: 10 })).ok).toBe(false);
  });
});

describe("photo cursor codec", () => {
  test("a cursor made from a photo's position decodes back to it", () => {
    const cursor = engine.encodePhotoCursor("2026-09-24T11:00:00.000Z", "photo-0002");
    expect(engine.decodePhotoCursor(cursor)).toEqual({ createdAt: "2026-09-24T11:00:00.000Z", photoId: "photo-0002" });
  });

  test("a made cursor passes the request schema", () => {
    const cursor = engine.encodePhotoCursor("2026-09-24T11:00:00.000Z", "photo-0002");
    expect(parseEngineCommand(listCommand({ avatarId: "avatar-0001", cursor })).ok).toBe(true);
  });
});
