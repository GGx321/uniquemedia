import { describe, expect, test } from "bun:test";
import { MediaSummary } from "../../shared/engine";
import { MockEngine, mockEngineClient } from "./mockEngine";
import { mineDemoPicks, mineDemoSeeds, withMineDemo } from "./mockMineDemo";
import { ManualScheduler } from "./scheduler";

// 3f.6: the dev build's «Мои» (renderer-side demo data, never in a release bundle): the library holds a file of every kind as the EditorMine
// artboard draws them, and the drop zone's dialog answers with scripted picks in turn: files that import, one the boundary refuses, one the
// kind's importer refuses. Nothing here changes the mock's import behaviour.

describe("the dev build's own files", () => {
  test("every kind is there, each a record the contract takes, newest first after the demo's own", async () => {
    const engine = new MockEngine({ scheduler: new ManualScheduler() });
    const client = withMineDemo(engine, mockEngineClient(engine));
    const listed = await client.request("media.list", {});
    if (!listed.ok) throw new Error(listed.error.code);
    expect(listed.result.total).toBe(mineDemoSeeds().length);
    for (const media of listed.result.media) expect(MediaSummary.safeParse(media).success).toBe(true);
    expect(new Set(listed.result.media.map((m) => m.kind))).toEqual(new Set(["photo", "video", "audio", "sticker"]));
    // A track shorter than the demo's 9.6 s montage (M10's dimmed row), and one the engine would still import (4 s at least, round 2).
    const note = listed.result.media.find((m) => m.name === "voice-note.m4a");
    expect(note?.durationMs).toBe(5_000);
    expect(listed.result.media.every((m) => m.kind !== "audio" || (m.durationMs ?? 0) >= 4_000)).toBe(true);
  });

  test("the first scripted pick's video is prepared (M14): «Готовим street-walk.mp4 · HDR → SDR, 60 → 30 fps»", async () => {
    const scheduler = new ManualScheduler();
    const engine = new MockEngine({ scheduler });
    const client = withMineDemo(engine, mockEngineClient(engine));
    const seen: unknown[] = [];
    client.subscribe((event) => {
      if (event.type === "job.progress" && event.payload.kind === "import" && event.payload.stage === "prepare") seen.push(event.payload.prepare);
    });
    await client.request("media.pickImport", { kind: "any" });
    for (let i = 0; i < 20 && seen.length === 0; i++) scheduler.next();
    expect(seen[0]).toEqual({ hdrToSdr: true, fromFps: 60 });
  });

  test("each click on the drop zone gets the next scripted pick; a pick of one kind, and every other command, pass untouched", async () => {
    const engine = new MockEngine({ scheduler: new ManualScheduler() });
    const client = withMineDemo(engine, mockEngineClient(engine));
    const answers = [];
    for (let i = 0; i < mineDemoPicks().length + 1; i++) {
      const reply = await client.request("media.pickImport", { kind: "any" });
      if (!reply.ok) throw new Error(reply.error.code);
      answers.push(reply.result);
    }
    const [first, second, third] = answers;
    expect(first).toMatchObject({ picked: true, refused: [{ name: "track.wma", reason: "format" }], skipped: 0 });
    expect(first?.picked === true && first.jobIds).toHaveLength(2);
    expect(second).toMatchObject({ picked: true, refused: [{ name: "IMG_3001.heic", reason: "heic" }] });
    // The script goes round.
    expect(third).toMatchObject({ picked: true, refused: [{ name: "track.wma", reason: "format" }] });
    expect(await client.request("media.pickImport", { kind: "photo" })).toEqual({ ok: true, result: { picked: false } });
  });
});
