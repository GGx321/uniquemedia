import type { MediaKind } from "../../shared/engine";
import type { EngineClient } from "./client";
import type { MockEngine, MockMediaPick } from "./mockEngine";
import type { MockOwnSeed } from "./mockMedia";

// 3f.6: the dev build's «Мои» (EditorMine.dc.html), renderer-side demo data: a file of every kind in the library, and scripted answers for
// the drop zone's dialog, in turn. It only SEEDS the mock and SCRIPTS its dialog through the mock's own public doors (`seedOwnMedia`,
// `pickMediaNext`): how the mock runs an import is its own. Functions, never module-level data, and reached only from the dev branch of
// `pickEngineClient`, so a release bundle that drops the mock drops this too.

/** The library as the artboard draws «Мои»: photos, a 60 fps HDR video, a track and one shorter than any montage, animated stickers. */
export function mineDemoSeeds(): MockOwnSeed[] {
  return [
    { kind: "sticker", name: "new-badge.gif", bytes: 61_000, facts: { width: 240, height: 240, loopFrames: 8, delayFrames: [2, 2, 2, 2] }, createdAt: "2026-09-22T08:00:00.000Z" },
    { kind: "sticker", name: "underline.gif", bytes: 34_000, facts: { width: 320, height: 120, loopFrames: 6, delayFrames: [2, 2, 2] }, createdAt: "2026-09-22T08:01:00.000Z" },
    { kind: "sticker", name: "sparkle-loop.gif", bytes: 48_000, createdAt: "2026-09-22T08:02:00.000Z" },
    // 5 s: shorter than the demo's 9.6 s montage (M10's dimmed row), and a track the engine imports (4 s at least).
    { kind: "audio", name: "voice-note.m4a", bytes: 82_000, facts: { durationMs: 5_000 }, createdAt: "2026-09-22T08:03:00.000Z" },
    { kind: "audio", name: "summer-edit.mp3", bytes: 1_010_000, facts: { durationMs: 42_000 }, createdAt: "2026-09-22T08:04:00.000Z" },
    { kind: "photo", name: "croissant.jpg", bytes: 1_400_000, facts: { width: 1080, height: 1350 }, createdAt: "2026-09-22T08:05:00.000Z" },
    { kind: "photo", name: "IMG_2044.jpg", bytes: 2_100_000, facts: { width: 1080, height: 1440 }, createdAt: "2026-09-22T08:06:00.000Z" },
    { kind: "photo", name: "IMG_2041.jpg", bytes: 2_300_000, facts: { width: 1080, height: 1440 }, createdAt: "2026-09-22T08:07:00.000Z" },
    { kind: "video", name: "latte-pour.mov", bytes: 38_000_000, facts: { width: 1080, height: 1920, durationMs: 6_400, sourceFps: 60, hdrToSdr: true }, createdAt: "2026-09-22T08:08:00.000Z" },
  ];
}

/**
 * What the dialog answers, click after click (then round again): two files that import and one the boundary refuses (M15's card), then a
 * HEIC the boundary refuses and a WebM the video importer turns away inside its job (said in the video's own words).
 */
export function mineDemoPicks(): MockMediaPick[][] {
  return [
    [
      // Copied, then prepared (M14): «Готовим street-walk.mp4 · HDR → SDR, 60 → 30 fps».
      { name: "street-walk.mp4", accept: { kind: "video", bytes: 120_000_000, facts: { width: 1080, height: 1920, durationMs: 12_000, sourceFps: 60, hdrToSdr: true }, prepare: {} } },
      { name: "track.wma", reason: "format" },
      { name: "beach.jpg", accept: { kind: "photo", bytes: 2_600_000, facts: { width: 1080, height: 1440 } } },
    ],
    [
      { name: "IMG_3001.heic", reason: "heic" },
      { name: "clip.webm", accept: { kind: "video", bytes: 9_000_000, failWith: "codec" } },
    ],
  ];
}

/** `engine` with the demo library, and `client` with the drop zone's dialog scripted in turn (`media.pickImport {kind: "any"}` only) and a drop door. */
export function withMineDemo(engine: MockEngine, client: EngineClient): EngineClient {
  engine.seedOwnMedia(mineDemoSeeds());
  const picks = mineDemoPicks();
  let turn = 0;
  const request: EngineClient["request"] = (type, payload) => {
    if (type === "media.pickImport" && "kind" in payload && payload.kind === "any") {
      engine.pickMediaNext(picks[turn % picks.length] ?? null);
      turn += 1;
    }
    return client.request(type, payload);
  };
  return { ...client, request, importDropped: mockDropDoor(engine, client) };
}

/** What the mock's importer would take a dropped file for, by its type and then its extension (the real engine reads the bytes); null for none. */
function mockKindOf(file: File): MediaKind | null {
  const ext = file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase();
  if (file.type === "image/gif" || ext === "gif") return "sticker";
  if (file.type.startsWith("image/") || ["jpg", "jpeg", "png", "webp"].includes(ext)) return "photo";
  if (file.type.startsWith("video/") || ["mp4", "mov"].includes(ext)) return "video";
  if (file.type.startsWith("audio/") || ["mp3", "m4a", "aac", "wav", "flac", "ogg", "opus"].includes(ext)) return "audio";
  return null;
}

/**
 * The dev build's (and the screen tests') drop door (3f.6 round 2, M13): what main would do with the dropped files' paths, played on the mock: the
 * files go through the mock's own pick (`media.pickImport {kind: "any"}` with the dialog scripted as these files), a type it cannot tell refused as
 * `format`. The real door is the preload's (`webUtils` paths to main).
 */
export function mockDropDoor(engine: MockEngine, client: EngineClient): NonNullable<EngineClient["importDropped"]> {
  return async (files) => {
    if (files.length === 0) return { ok: true, result: { picked: false } };
    engine.pickMediaNext(
      files.map((file): MockMediaPick => {
        const kind = mockKindOf(file);
        return kind === null ? { name: file.name, reason: "format" } : { name: file.name, accept: { kind, bytes: Math.max(1, file.size) } };
      }),
    );
    const reply = await client.request("media.pickImport", { kind: "any" });
    return reply.ok ? { ok: true, result: reply.result } : { ok: false, error: reply.error };
  };
}
