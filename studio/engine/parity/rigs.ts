import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { CommandMessage, EventMessage, ResponseMessage, type AvatarSummary, type PhotoSummary } from "../../shared/engine";
import { FfmpegError, type RunFfmpegArgvOptions } from "../../node/runFfmpeg";
import { MockEngine } from "../../renderer/engine/mockEngine";
import { MIA, NORA, scenePhoto, SOFIA } from "../../renderer/engine/mockEngine.testkit";
import { ManualScheduler } from "../../renderer/engine/scheduler";
import { manifestTraits } from "../avatars/records";
import { openLibrary } from "../library";
import { PNG_1X1, samplePhotoMeta, sequentialIds, steppingClock } from "../library/testing/helpers";
import { command, engineSettings, GOOD, startEngine, TRAITS, until } from "../testing/engineHarness";
import { acceptingVerify } from "../videos/testing/kit";
import { writingRun } from "../videos/testing/serviceKit";
import type { Answer, Recorded } from "./transcript";

// The two engines the parity suite runs a scenario against (Stage 3, 3d.1b), behind ONE interface: the mock on a manual clock,
// and the real engine over a real library and export folder in a temp dir, with fakes only where the outside world is: ffmpeg
// (a fake `run` the rig holds still or lets go) and the focus resolver (no face models in a test).
//
// Both start from the same world: an active avatar with `MAIN_PHOTOS` free scene photos (every odd one has a face score), a
// second active avatar with two, and an archived one. Time moves only when the scenario says so:
//   `advance("progress")`  the running render reports some progress and stays running;
//   `advance("saving")`    the running render is past its point of no return and not yet ended;
//   `settle()`             everything queued or running runs to its end.

export const MAIN_PHOTOS = 22;
const OTHER_PHOTOS = 2;

/** The seeded ids, and which photos the focus resolver judges. */
export interface World {
  readonly avatarId: string;
  readonly photoIds: readonly string[];
  readonly otherAvatarId: string;
  readonly otherPhotoIds: readonly string[];
  readonly archivedAvatarId: string;
  /** The photos whose face was scored: the resolver judges them (the odd ones, counting from 1). */
  readonly scored: ReadonlySet<string>;
}

/** What only a rig can do to the outside world. */
export interface Control {
  /** The next render's ffmpeg fails (it exits with code 1). */
  failNextRender(): void;
  /** The export folder is unplugged (`away`), plugged back (`back`), or the owner chose another one (`elsewhere`). */
  exportFolder(state: "away" | "back" | "elsewhere"): Promise<void>;
}

export interface ParityRig extends Recorded {
  readonly name: "mock" | "real";
  readonly world: World;
  readonly control: Control;
  /** Lets whatever is queued or running end, so nothing outlives the scenario. */
  stop(): Promise<void>;
}

/** The text both engines give a failed ffmpeg: the real one builds it from the error below, the mock is told it. */
export const FFMPEG_FAILURE_DETAIL = "ffmpeg failed: boom";

function recordOf(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected an object result");
  return Object.fromEntries(Object.entries(value));
}

function answerOf(response: ResponseMessage): Answer {
  return response.ok ? { ok: true, result: recordOf(response.result) } : { ok: false, error: response.error };
}

const scored = (ids: readonly string[]): ReadonlySet<string> => new Set(ids.filter((_id, i) => i % 2 === 0));

// ---------- the mock ----------

export function mockRig(): ParityRig {
  const scheduler = new ManualScheduler();
  const photos: PhotoSummary[] = [
    ...Array.from({ length: MAIN_PHOTOS }, (_, i) => scenePhoto(i + 1)),
    ...Array.from({ length: OTHER_PHOTOS }, (_, i) => scenePhoto(i + 1, {}, SOFIA)),
  ];
  const avatars: AvatarSummary[] = [
    { ...MIA, photoCount: MAIN_PHOTOS, eligibleUnusedCount: MAIN_PHOTOS },
    { ...SOFIA, photoCount: OTHER_PHOTOS, eligibleUnusedCount: OTHER_PHOTOS },
    { ...NORA, photoCount: 0, eligibleUnusedCount: 0 },
  ];
  const engine = new MockEngine({ scheduler, avatars, photos, renderConcurrency: 1 });
  const events: EventMessage[] = [];
  engine.subscribe((raw) => events.push(EventMessage.parse(raw)));
  let messages = 0;
  const photoIds = photos.filter((p) => p.avatarId === MIA.avatarId).map((p) => p.photoId);
  const world: World = {
    avatarId: MIA.avatarId,
    photoIds,
    otherAvatarId: SOFIA.avatarId,
    otherPhotoIds: photos.filter((p) => p.avatarId === SOFIA.avatarId).map((p) => p.photoId),
    archivedAvatarId: NORA.avatarId,
    scored: scored(photoIds),
  };
  const savingSeen = (from: number): boolean => events.slice(from).some((e) => (e.type === "job.progress" && e.payload.kind === "render" && e.payload.saving === true) || e.type === "job.failed" || e.type === "job.cancelled" || e.type === "job.done");

  return {
    name: "mock",
    world,
    events: () => events,
    // What the renderer's client does: the payload is checked against the contract, then it goes to the engine.
    async send(type, payload) {
      const message = CommandMessage.safeParse({ v: 5, id: `msg-${String(++messages).padStart(6, "0")}`, kind: "command", type, payload });
      if (!message.success) return { ok: false, error: { code: "VALIDATION", detail: `${type}: the payload breaks the contract` } };
      return answerOf(ResponseMessage.parse(await engine.request(message.data)));
    },
    async advance(step) {
      const from = events.length;
      if (step === "progress") scheduler.next();
      else for (let i = 0; i < 50 && !savingSeen(from); i++) scheduler.next();
    },
    async settle() {
      scheduler.runAll();
    },
    control: {
      failNextRender: () => engine.failNextRender({ code: "RENDER_FAILED", detail: FFMPEG_FAILURE_DETAIL }),
      exportFolder: async (state) => {
        if (state === "away") engine.setExportDisk({ status: "unavailable", reason: "missing" });
        else if (state === "back") engine.setExportDisk({ status: "ok" });
        else engine.moveExportFolder();
      },
    },
    async stop() {
      scheduler.runAll();
    },
  };
}

// ---------- the real engine ----------

/** How far the fake ffmpeg and the commit are let go: 0 held, 1 progress reported, 2 ffmpeg done (the commit runs up to its claim), 3 everything. */
class Gate {
  level = 0;
  readonly #waiters: { level: number; resolve: () => void; reject: (reason: unknown) => void; signal: AbortSignal | undefined; onAbort: () => void }[] = [];

  /** Closes the gate again once everything has ended: the next render is held like the first (the mock's clock stands still between `settle`s too). */
  reset(): void {
    this.level = 0;
  }

  set(level: number): void {
    this.level = Math.max(this.level, level);
    for (const waiter of this.#waiters.filter((w) => w.level <= this.level)) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.resolve();
    }
    this.#waiters.splice(0, this.#waiters.length, ...this.#waiters.filter((w) => w.level > this.level));
  }

  /** Resolves once the gate is at `level`; rejects with the signal's reason when it aborts first (a cancelled render's ffmpeg dies). */
  wait(level: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) return Promise.reject(signal.reason);
    if (this.level >= level) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        const at = this.#waiters.findIndex((w) => w.onAbort === onAbort);
        if (at >= 0) this.#waiters.splice(at, 1);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiters.push({ level, resolve, reject, signal, onAbort });
    });
  }
}

const FIXTURE_BASE = samplePhotoMeta().source;

/** Adds `count` free scene photos to `avatarId`, tiny ones: no ffmpeg reads them. */
async function seedPhotos(library: Awaited<ReturnType<typeof openLibrary>>["library"], avatarId: string, count: number, run: number): Promise<string[]> {
  if (FIXTURE_BASE.kind !== "generated") throw new Error("expected a generated sample source");
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const photo = await library.addPhoto(avatarId, PNG_1X1, samplePhotoMeta({ source: { ...FIXTURE_BASE, category: "home", attemptId: `run-0000000${run}:slot-${i + 1}#1`, slot: `slot-${i + 1}` }, qa: { age: { adult: true, confidence: 0.95 } } }));
    ids.push(photo.id);
  }
  return ids;
}

async function seedAvatar(library: Awaited<ReturnType<typeof openLibrary>>["library"], name: string): Promise<string> {
  const avatar = await library.createAvatar({ name, age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
  const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  return avatar.id;
}

/** The real engine over a library and an export folder in `dir` (a fresh temp dir per scenario). */
export async function realRig(dir: string): Promise<ParityRig> {
  const exportDir = join(dir, "export");
  await mkdir(exportDir);
  const { library } = await openLibrary(join(dir, "library"), { now: steppingClock(), newId: sequentialIds("par") });
  const avatarId = await seedAvatar(library, "Mia");
  const photoIds = await seedPhotos(library, avatarId, MAIN_PHOTOS, 1);
  const otherAvatarId = await seedAvatar(library, "Sofia");
  const otherPhotoIds = await seedPhotos(library, otherAvatarId, OTHER_PHOTOS, 2);
  const archivedAvatarId = await seedAvatar(library, "Nora");

  const world: World = { avatarId, photoIds, otherAvatarId, otherPhotoIds, archivedAvatarId, scored: scored(photoIds) };
  const gate = new Gate();
  let failArmed = false;
  // The ffmpeg that is not there: it reports progress once the gate lets it, and writes its output once the gate lets it finish.
  const run = async (opts: RunFfmpegArgvOptions): Promise<void> => {
    await gate.wait(1, opts.signal);
    if (failArmed) {
      failArmed = false;
      throw new FfmpegError("ffmpeg failed", 1, "boom");
    }
    opts.onFrames?.(1_000_000);
    await gate.wait(2, opts.signal);
    await writingRun(opts);
  };
  const settings = (patch: Parameters<typeof engineSettings>[1] = {}) => engineSettings(dir, { renderConcurrency: 1, ...patch });
  const { engine, events } = await startEngine(dir, {
    init: { renderTmpDir: join(dir, "userData", "render-tmp"), settings: settings() },
    deps: {
      // No face models in a test: the resolver judges the scored photos and none of the rest, as the mock does.
      montages: {
        focus: () => ({
          focusFor: async (_avatarId, photoId) => (world.scored.has(photoId) ? { focus: { x: 0.5, y: 0.35 }, resolved: true } : { focus: { x: 0.5, y: 0.38 }, resolved: false }),
        }),
      },
      videos: {
        renderOverrides: {
          verify: acceptingVerify,
          runDeps: { run },
          // The commit stops at its claim, past the saving announcement, until the gate is open.
          hooks: { reached: async (step) => (step === "name-claimed" ? gate.wait(3) : undefined) },
        },
      },
    },
  });
  await engine.settled();
  // Nora is retired: the engine's own command, so the library's state is the engine's.
  const archived = ResponseMessage.parse(await engine.handle(command("avatars.archive", { avatarId: archivedAvatarId })));
  if (!archived.ok) throw new Error(`could not archive the third avatar: ${archived.error.code}`);

  const settle = async (): Promise<void> => {
    gate.set(3);
    await engine.renders.idle();
    await engine.settled();
    gate.reset();
  };
  const isEndOrSaving = (e: EventMessage): boolean => (e.type === "job.progress" && e.payload.kind === "render" && e.payload.saving === true) || e.type === "job.failed" || e.type === "job.cancelled" || e.type === "job.done";

  return {
    name: "real",
    world,
    events,
    async send(type, payload) {
      return answerOf(ResponseMessage.parse(await engine.handle(command(type, payload))));
    },
    async advance(step) {
      const from = events().length;
      if (step === "progress") {
        gate.set(1);
        await until(() => events().length > from, "the render's progress", 10_000);
      } else {
        gate.set(2);
        await until(() => events().slice(from).some(isEndOrSaving), "the render's saving phase", 10_000);
      }
    },
    settle,
    control: {
      failNextRender: () => {
        failArmed = true;
      },
      exportFolder: async (state) => {
        if (state === "away") await rename(exportDir, `${exportDir}-away`);
        else if (state === "back") await rename(`${exportDir}-away`, exportDir);
        else {
          const other = join(dir, "export-other");
          await mkdir(other);
          await engine.applyControl({ kind: "control", type: "settings.update", settings: settings({ exportPath: other }) });
        }
      },
    },
    stop: settle,
  };
}
