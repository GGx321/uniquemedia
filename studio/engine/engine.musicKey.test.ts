import { describe, expect, test } from "bun:test";
import { command, failed, KEY, ok, startEngine, useEngineDir } from "./testing/engineHarness";
import { captureConsole, expectNoKeyFragment } from "../testing/keyLeaks";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 3, task 3c.2: the RapidAPI (music) key in the engine. Main decrypts it and hands it over on the control
// channel; the engine keeps it in memory only, for the flashapi client of 3c.3. What the engine reports about it is
// the three fields of K24, never the key. It is a second key next to OpenRouter's: neither touches the other.

const dir = useEngineDir("studio-engine-music-key-");

const MUSIC = "Zq7-vKt9-Wm2x-Lp4s-0000";
const ROTATED = "Hb5-nRw3-Yc8d-Qj6f-9999";

/** No OpenRouter key by default (the harness would store one), so a test sees only what it sets. */
const start = () => startEngine(dir(), { key: null });

async function settingsOf(engine: Awaited<ReturnType<typeof startEngine>>["engine"]) {
  const response = ok(await engine.handle(command("settings.get")));
  if (response.type !== "settings.get") throw new Error("wrong type");
  return response.result;
}

describe("musicKey.set / musicKey.clear", () => {
  test("no music key at start: settings report nothing stored", async () => {
    const { engine } = await start();
    expect((await settingsOf(engine)).musicKey).toEqual({ stored: false, last4: null, rejected: false });
    expect(engine.musicKey).toBeNull();
  });

  test("musicKey.set reports the last four chars, keeps the key in memory and announces settings.changed without the key", async () => {
    const { engine, posted, events } = await start();
    await engine.applyControl({ kind: "control", type: "musicKey.set", key: MUSIC });

    expect(engine.musicKey).toBe(MUSIC);
    expect(events()).toMatchObject([{ type: "settings.changed", payload: { settings: { musicKey: { stored: true, last4: "0000", rejected: false } } } }]);
    expect((await settingsOf(engine)).musicKey).toEqual({ stored: true, last4: "0000", rejected: false });
    expectNoKeyFragment(JSON.stringify(posted), MUSIC);
  });

  test("the snapshot carries the music key's status, not the key", async () => {
    const { engine } = await start();
    await engine.applyControl({ kind: "control", type: "musicKey.set", key: MUSIC });
    const snapshot = ok(await engine.handle(command("engine.snapshot")));
    expect(snapshot).toMatchObject({ result: { settings: { musicKey: { stored: true, last4: "0000", rejected: false } } } });
    expectNoKeyFragment(JSON.stringify(snapshot), MUSIC);
  });

  test("musicKey.clear forgets the key and announces it", async () => {
    const { engine, events } = await start();
    await engine.applyControl({ kind: "control", type: "musicKey.set", key: MUSIC });
    await engine.applyControl({ kind: "control", type: "musicKey.clear" });

    expect(engine.musicKey).toBeNull();
    expect(events().at(-1)).toMatchObject({ type: "settings.changed", payload: { settings: { musicKey: { stored: false, last4: null, rejected: false } } } });
    expect((await settingsOf(engine)).musicKey).toEqual({ stored: false, last4: null, rejected: false });
  });

  test("clearing when no music key is held still leaves a consistent status", async () => {
    const { engine } = await start();
    await engine.applyControl({ kind: "control", type: "musicKey.clear" });
    expect((await settingsOf(engine)).musicKey).toEqual({ stored: false, last4: null, rejected: false });
  });

  test("a new key replaces the old one", async () => {
    const { engine } = await start();
    await engine.applyControl({ kind: "control", type: "musicKey.set", key: MUSIC });
    await engine.applyControl({ kind: "control", type: "musicKey.set", key: ROTATED });
    expect(engine.musicKey).toBe(ROTATED);
    expect((await settingsOf(engine)).musicKey.last4).toBe("9999");
  });

  test.each([
    ["too short", "Zq7-vK9"],
    ["holding a space", "Zq7-vKt9 Wm2x-Lp4s-0000"],
    ["holding a newline", "Zq7-vKt9\nWm2x-Lp4s-0000"],
  ])("an invalid key (%s) changes nothing, posts nothing and is not echoed in the log", async (_label, key) => {
    const { engine, posted } = await start();
    const output = captureConsole();
    try {
      await engine.applyControl({ kind: "control", type: "musicKey.set", key });
      expect(engine.musicKey).toBeNull();
      expect(posted).toEqual([]);
      expectNoKeyFragment(output.text(), key);
    } finally {
      output.restore();
    }
  });

  test("a key survives nothing: a fresh engine starts without one until main hands it over again", async () => {
    const first = await start();
    await first.engine.applyControl({ kind: "control", type: "musicKey.set", key: MUSIC });
    const second = await start();
    expect(second.engine.musicKey).toBeNull();
  });
});

describe("the music key and the OpenRouter key are independent", () => {
  test("setting and clearing the music key leaves the OpenRouter key and its rejection alone", async () => {
    const { engine } = await start();
    await engine.applyControl({ kind: "control", type: "apiKey.set", key: KEY });
    engine.markKeyRejected(KEY);
    await engine.applyControl({ kind: "control", type: "musicKey.set", key: MUSIC });
    await engine.applyControl({ kind: "control", type: "musicKey.clear" });

    expect(engine.apiKey).toBe(KEY);
    expect((await settingsOf(engine)).apiKey).toMatchObject({ stored: true, last4: "wxyz", rejected: true });
  });

  test("setting and clearing the OpenRouter key leaves the music key and its rejection alone", async () => {
    const { engine } = await start();
    await engine.applyControl({ kind: "control", type: "musicKey.set", key: MUSIC });
    engine.markMusicKeyRejected(MUSIC);
    await engine.applyControl({ kind: "control", type: "apiKey.set", key: "sk-or-v1-rotated-key-9876" });
    await engine.applyControl({ kind: "control", type: "apiKey.clear" });

    expect(engine.musicKey).toBe(MUSIC);
    expect((await settingsOf(engine)).musicKey).toEqual({ stored: true, last4: "0000", rejected: true });
  });

  test("a music key that flashapi rejected does not mark the OpenRouter key rejected", async () => {
    const { engine } = await start();
    await engine.applyControl({ kind: "control", type: "musicKey.set", key: MUSIC });
    engine.markMusicKeyRejected(MUSIC);
    expect((await settingsOf(engine)).apiKey.rejected).toBe(false);
  });
});

describe("a music key flashapi rejected (401)", () => {
  test("markMusicKeyRejected marks it rejected in settings and the snapshot and emits settings.changed once, not engine.error", async () => {
    const { engine, posted, events } = await start();
    await engine.applyControl({ kind: "control", type: "musicKey.set", key: MUSIC });
    const before = events().length;
    engine.markMusicKeyRejected(MUSIC);
    engine.markMusicKeyRejected(MUSIC);

    expect(events().slice(before)).toMatchObject([{ type: "settings.changed", payload: { settings: { musicKey: { stored: true, last4: "0000", rejected: true } } } }]);
    expect(events().some((e) => e.type === "engine.error")).toBe(false);
    expectNoKeyFragment(JSON.stringify(posted), MUSIC);
    expect((await settingsOf(engine)).musicKey).toEqual({ stored: true, last4: "0000", rejected: true });
    expect(ok(await engine.handle(command("engine.snapshot")))).toMatchObject({ result: { settings: { musicKey: { rejected: true } } } });
  });

  test("replacing the key clears the rejection", async () => {
    const { engine } = await start();
    await engine.applyControl({ kind: "control", type: "musicKey.set", key: MUSIC });
    engine.markMusicKeyRejected(MUSIC);
    await engine.applyControl({ kind: "control", type: "musicKey.set", key: ROTATED });
    expect((await settingsOf(engine)).musicKey).toEqual({ stored: true, last4: "9999", rejected: false });
  });

  test("re-sending the same key also clears the rejection, so «Заменить» with the same text retries", async () => {
    const { engine } = await start();
    await engine.applyControl({ kind: "control", type: "musicKey.set", key: MUSIC });
    engine.markMusicKeyRejected(MUSIC);
    await engine.applyControl({ kind: "control", type: "musicKey.set", key: MUSIC });
    expect((await settingsOf(engine)).musicKey.rejected).toBe(false);
  });

  test("clearing the key clears the rejection", async () => {
    const { engine } = await start();
    await engine.applyControl({ kind: "control", type: "musicKey.set", key: MUSIC });
    engine.markMusicKeyRejected(MUSIC);
    await engine.applyControl({ kind: "control", type: "musicKey.clear" });
    expect((await settingsOf(engine)).musicKey).toEqual({ stored: false, last4: null, rejected: false });
  });

  test("a 401 for a key that was replaced meanwhile leaves the new key alone", async () => {
    const { engine, events } = await start();
    await engine.applyControl({ kind: "control", type: "musicKey.set", key: MUSIC });
    await engine.applyControl({ kind: "control", type: "musicKey.set", key: ROTATED });
    const before = events().length;

    engine.markMusicKeyRejected(MUSIC);

    expect(events().length).toBe(before);
    expect((await settingsOf(engine)).musicKey).toEqual({ stored: true, last4: "9999", rejected: false });
  });

  test("without a key there is nothing to reject", async () => {
    const { engine, posted } = await start();
    engine.markMusicKeyRejected(MUSIC);
    expect(posted).toEqual([]);
    expect((await settingsOf(engine)).musicKey).toEqual({ stored: false, last4: null, rejected: false });
  });
});

describe("the music key commands are main's alone", () => {
  test.each([
    ["settings.setMusicKey", { key: MUSIC }],
    ["settings.clearMusicKey", {}],
  ])("the engine refuses %s and never echoes the key", async (type, payload) => {
    const { engine } = await start();
    const response = failed(await engine.handle(command(type, payload)));
    expect(response.error.code).toBe("VALIDATION");
    expectNoKeyFragment(JSON.stringify(response), MUSIC);
    expect(engine.musicKey).toBeNull();
  });
});
