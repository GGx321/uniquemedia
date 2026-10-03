import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clip } from "../shared/engine/montage";
import { buildMusicMeasure, buildPass2 } from "../engine/render";
import { measureTruePeak } from "../engine/renderQueue/musicMeasure";
import { runRenderJob } from "../engine/renderQueue/runner";
import { startEngine, useEngineDir } from "../engine/testing/engineHarness";
import { ENV_ALLOWLIST } from "../node/childEnv";
import { configureFfmpegEnv } from "../node/ffmpegEnv";
import { fakeSpawner, outputOf } from "../node/fakeFfmpeg.testkit";
import { runFfmpegArgv } from "../node/runFfmpeg";
import { expectNoKeyFragment } from "../testing/keyLeaks";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Invariant 29 with the real render (3c.5): while the engine holds the RapidAPI key, no ffmpeg the render starts, the true-peak
// pass included, has any fragment of it in its argv, and every child's environment is the allowlist. The render's argv is built
// by the real builders from a stored track's path, and run through the real runner and measurement over a scripted child.

const MUSIC = "Zq7-vKt9-Wm2x-Lp4s-0000";
const PARENT_ENV = { PATH: "/usr/bin", HOME: "/Users/me", RAPIDAPI_KEY: MUSIC, rapidapi_key: MUSIC, X_RAPIDAPI_KEY: MUSIC, "x-rapidapi-key": MUSIC, MUSIC_KEY: MUSIC, FLASHAPI_TOKEN: MUSIC };
const SUMMARY = "[Parsed_ebur128_4 @ 0x1] Summary:\n\n  True peak:\n    Peak:        3.0 dBFS\n";

const dir = useEngineDir("studio-music-key-argv-");
const roots: string[] = [];
afterEach(() => {
  configureFfmpegEnv(undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const clip = (clipId: string): Clip => ({ clipId, durationMs: 2000, transitionIn: "cut", kind: "photo", cell: { photo: { source: "scene", photoId: `photo-${clipId}` }, focus: { x: 0.5, y: 0.5 } }, motion: "static" });

describe("the music key is never an argument of the render's ffmpeg", () => {
  test("the builders' argv for a stored track holds no fragment of the key", async () => {
    const { engine } = await startEngine(dir(), { key: null, init: { ffmpegEnv: PARENT_ENV } });
    await engine.applyControl({ kind: "control", type: "musicKey.set", key: MUSIC });
    const track = join(dir(), "userData", "music", "tracks", "4199287736976977.m4a");

    const argv = [
      ...buildMusicMeasure({ path: track, startMs: 1500, durationMs: 6000 }).argv,
      ...buildPass2({ clips: [{ clipId: "a", durationMs: 6000 }], clipDir: join(dir(), "tmp"), output: join(dir(), "out.mp4"), overlays: [], audio: { kind: "music", path: track, startMs: 1500, gainDb: -4.5 } }).argv,
    ];

    expect(argv.length).toBeGreaterThan(40);
    for (const arg of argv) expectNoKeyFragment(arg, MUSIC);
  });

  test("a whole render job with music starts every ffmpeg, the measurement included, without the key in its argv or its environment", async () => {
    const { engine } = await startEngine(dir(), { key: null, init: { ffmpegEnv: PARENT_ENV } });
    await engine.applyControl({ kind: "control", type: "musicKey.set", key: MUSIC });
    const root = mkdtempSync(join(tmpdir(), "studio-music-key-run-"));
    roots.push(root);
    mkdirSync(join(root, "export"), { recursive: true });
    const { spawner, calls } = fakeSpawner((call) => {
      if (call.args.some((a) => a.includes("ebur128"))) {
        call.child.complain(SUMMARY);
        call.child.exit(0);
        return;
      }
      writeFileSync(outputOf(call.args), "data");
      call.child.report(call.args.includes("concat") ? 120 : 60, true);
      call.child.exit(0);
    });

    await runRenderJob(
      {
        jobId: "job-00000001",
        tmpRoot: join(root, "render-tmp"),
        seed: 1,
        clips: [clip("a"), clip("b")],
        resolvePhoto: (ref) => ({ path: join(root, `${ref.source === "scene" ? ref.photoId : ref.mediaId}.jpg`), width: 720, height: 1280 }),
        overlays: [],
        audio: { kind: "music", data: new Uint8Array([1, 2, 3]), startMs: 0 },
        output: join(root, "export", ".studio-part-job-00000001.mp4"),
        signal: new AbortController().signal,
        onProgress: () => undefined,
      },
      { run: (opts) => runFfmpegArgv({ ...opts, spawner }), measure: (job, options) => measureTruePeak(job, { ...options, spawner }) },
    );

    // The measurement, pass 1 for each of the two clips, pass 2.
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      for (const arg of call.args) expectNoKeyFragment(arg, MUSIC);
      const env = call.options.env ?? {};
      expect(Object.keys(env).every((name) => ENV_ALLOWLIST.has(name.toUpperCase()))).toBe(true);
      expectNoKeyFragment(JSON.stringify(env), MUSIC);
    }
    expect(existsSync(join(root, "render-tmp", "job-00000001"))).toBe(false);
  });
});
