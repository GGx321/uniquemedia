import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { RunFfmpegArgvOptions } from "../../../node/runFfmpeg";
import { manifestTraits } from "../../avatars/records";
import type { EngineDeps } from "../../engine";
import { openLibrary } from "../../library";
import { PNG_1X1, samplePhotoMeta, sequentialIds, steppingClock } from "../../library/testing/helpers";
import type { MediaImporter } from "../../media/imports";
import { createVideoImporter } from "../../media/videoImporter";
import { engineSettings, GOOD, TRAITS } from "../../testing/engineHarness";
import { acceptingVerify } from "../../videos/testing/kit";
import { writingRun } from "../../videos/testing/serviceKit";
import { jobEnd, startClipEngine, type ClipEngine } from "./engineClipKit";
import { answerOf, importClipCommand, type PlantedClip } from "./copyKit";

// Test-only (5b.2, S5.WA2): the real engine with the real video importer AND a scripted render, so that a montage holding a clip's copy can be rendered, held half way, refused and
// recovered. The avatars here have several eligible gallery photos (a scene photo of a video must be eligible), and a clip is planted on one of them.

let seeded = 0;

export interface FramesAvatar {
  readonly avatarId: string;
  readonly photoIds: string[];
}

/** An active avatar with a master photo and `photos` eligible gallery photos. */
export async function seedFramesAvatar(libraryDir: string, photos = 3, name = "Mia"): Promise<FramesAvatar> {
  const { library } = await openLibrary(libraryDir, { now: steppingClock(), newId: sequentialIds(`frm${++seeded}`) });
  const avatar = await library.createAvatar({ name, age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
  const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  const base = samplePhotoMeta().source;
  if (base.kind !== "generated") throw new Error("expected a generated sample source");
  const photoIds: string[] = [];
  for (let n = 1; n <= photos; n++) {
    const source = { ...base, category: "home", attemptId: `run-0000000${seeded}:slot-${n}#1`, slot: `slot-${n}` };
    photoIds.push((await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ source, qa: { age: { adult: true, confidence: 0.95 } } }))).id);
  }
  return { avatarId: avatar.id, photoIds };
}

/** A render's ffmpeg that waits for `open()`, then writes its output as a good one would. */
export function gatedRender(): { run: (opts: RunFfmpegArgvOptions) => Promise<void>; open: () => void; started: () => number } {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (open = resolve));
  let calls = 0;
  return {
    open,
    started: () => calls,
    run: async (opts) => {
      calls++;
      await gate;
      await writingRun(opts);
    },
  };
}

/** A render's ffmpeg that writes its output at once. */
export const instantRender = writingRun;

export interface RenderEngineOptions {
  readonly run?: (opts: RunFfmpegArgvOptions) => Promise<void>;
  readonly importer?: Parameters<typeof createVideoImporter>[0];
  /** Wraps the real video importer (a gate, a failure). */
  readonly wrapImporter?: (real: MediaImporter) => MediaImporter;
  readonly deps?: Partial<EngineDeps>;
}

export async function startRenderEngine(dir: string, options: RenderEngineOptions = {}): Promise<ClipEngine> {
  await mkdir(join(dir, "export"), { recursive: true });
  const started = await startClipEngine(dir, {
    init: { renderTmpDir: join(dir, "userData", "render-tmp"), settings: { ...engineSettings(dir, { renderConcurrency: 1 }), imageAgeCheck: "off" } },
    deps: {
      mediaImporters: { video: options.wrapImporter === undefined ? createVideoImporter(options.importer) : options.wrapImporter(createVideoImporter(options.importer)) },
      videos: { renderOverrides: { verify: acceptingVerify, runDeps: { run: options.run ?? instantRender } } },
      ...options.deps,
    },
  });
  await started.engine.settled();
  return started;
}

/** Imports a planted clip and waits for the copy; its media id. */
export async function copyOfPlanted(started: ClipEngine, planted: PlantedClip): Promise<string> {
  const answer = answerOf(await started.engine.handle(importClipCommand(planted.avatarId, planted.clipId)));
  if ("mediaId" in answer) return answer.mediaId;
  const end = await jobEnd(started, answer.jobId);
  if (end.type !== "job.done" || end.payload.result.kind !== "import") throw new Error(`the import of ${planted.clipId} did not finish: ${end.type}`);
  await started.engine.mediaSettled();
  return end.payload.result.mediaId;
}

export type SpecPart = { scene: string; durationMs?: number } | { copy: string; durationMs?: number; trimStartMs?: number } | { own: string; durationMs?: number };

let clipSeq = 0;
/** A montage spec of scene-photo clips and video clips of copies, 2 s each by default. */
export function montageOf(avatarId: string, parts: readonly SpecPart[]): unknown {
  return {
    schemaVersion: 1,
    avatarId,
    layers: [],
    music: null,
    seed: 7,
    clips: parts.map((part) => {
      const clipId = `clip-${String(++clipSeq).padStart(8, "0")}`;
      if ("scene" in part) return { clipId, kind: "photo", cell: { photo: { source: "scene", photoId: part.scene }, focus: null }, motion: "static", durationMs: part.durationMs ?? 2_000, transitionIn: "cut" };
      const mediaId = "copy" in part ? part.copy : part.own;
      return { clipId, kind: "video", mediaId, trimStartMs: "trimStartMs" in part ? (part.trimStartMs ?? 0) : 0, focus: null, durationMs: part.durationMs ?? 2_000, transitionIn: "cut" };
    }),
  };
}

