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
    { kind: "audio", name: "voice-note.m4a", bytes: 82_000, facts: { durationMs: 3_400 }, createdAt: "2026-09-22T08:03:00.000Z" },
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
      { name: "street-walk.mp4", accept: { kind: "video", bytes: 120_000_000, facts: { width: 1080, height: 1920, durationMs: 12_000, sourceFps: 60, hdrToSdr: true } } },
      { name: "track.wma", reason: "format" },
      { name: "beach.jpg", accept: { kind: "photo", bytes: 2_600_000, facts: { width: 1080, height: 1440 } } },
    ],
    [
      { name: "IMG_3001.heic", reason: "heic" },
      { name: "clip.webm", accept: { kind: "video", bytes: 9_000_000, failWith: "codec" } },
    ],
  ];
}

/** `engine` with the demo library, and `client` with the drop zone's dialog scripted in turn (`media.pickImport {kind: "any"}` only). */
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
  return { ...client, request };
}
