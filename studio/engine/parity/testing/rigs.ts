import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CommandMessage, EventMessage, ResponseMessage, type AvatarSummary, type PhotoSummary } from "../../../shared/engine";
import { handleExportFolderCommand, isExportFolderCommand, type ExportFolderFlowDeps } from "../../../main/exportFolderFlow";
import { SettingsStore } from "../../../main/settingsStore";
import { EngineReply } from "../../control";
import { FfmpegError, type RunFfmpegArgvOptions } from "../../../node/runFfmpeg";
import { MockEngine, type MockExportPick } from "../../../renderer/engine/mockEngine";
import { MIA, NORA, scenePhoto, SOFIA } from "../../../renderer/engine/mockEngine.testkit";
import { ManualScheduler } from "../../../renderer/engine/scheduler";
import { manifestTraits } from "../../avatars/records";
import { EXPORT_MARKER_FILE, NODE_EXPORT_ROOT_FS, type ExportRootFs } from "../../exportRoot";
import { openLibrary } from "../../library";
import { PNG_1X1, samplePhotoMeta, sequentialIds, steppingClock } from "../../library/testing/helpers";
import { RenderFailure } from "../../renderQueue/queue";
import { command, engineSettings, GOOD, startEngine, TRAITS, until } from "../../testing/engineHarness";
import { acceptingVerify } from "../../videos/testing/kit";
import { writingRun } from "../../videos/testing/serviceKit";
import type { Answer, Recorded } from "./transcript";

// The two engines the parity suite runs a scenario against (Stage 3, 3d.1b), behind ONE interface: the mock on a manual clock,
// and the real engine over a real library and export folder in a temp dir, with fakes only where the outside world is: ffmpeg
// (a fake `run` the rig holds still or lets go), the focus resolver (no face models in a test) and the export folder's volume
// (its free space and whether it takes a write, through the engine's own `ExportRootFs` seam).
//
// Both start from the same world: an active avatar with `MAIN_PHOTOS` free scene photos (every odd one has a face score), a
// second active avatar with two, and an archived one. Time moves only when the scenario says so:
//   `advance("progress")`  the running render reports some progress and stays running;
//   `advance("saving")`    the running render is past its point of no return and not yet ended;
//   `advance("end")`       the next render to end (cancelled, failed or done) has ended, and what its end started has started;
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
  /** The next render fails: `encode` (the default) is its ffmpeg exiting with code 1; `saving` is the commit failing (`not-writable`) after the point of no return. */
  failNextRender(at?: "encode" | "saving"): void;
  /** The export folder is unplugged (`away`), replaced by a file (`file`), plugged back (`back`, from either), or the owner chose another one (`elsewhere`). */
  exportFolder(state: "away" | "file" | "back" | "elsewhere"): Promise<void>;
  /** The volume can (`true`) or cannot (`false`) take a file in the export folder: the probe the engine writes there is refused. */
  exportWritable(writable: boolean): void;
  /** Free bytes the volume reports for the export folder; `null` is the disk's own answer. */
  freeSpace(bytes: number | null): void;
  /** What main's folder dialog answers the next `settings.setExportPath` (used once; with nothing said it is cancelled). */
  exportDialog(answer: ExportDialog): Promise<void>;
  /** The export folder's marker becomes unreadable (`damaged`), or is put back as it was (`intact`). */
  exportMarker(state: "damaged" | "intact"): Promise<void>;
}

/**
 * The owner's pick in the dialog: nothing (`cancel`), a new empty folder (`fresh`), the export folder the rig started with (`first`),
 * that folder moved to another place (`moved`), a path with nothing there (`missing`), a file (`file`), a folder whose marker is
 * damaged (`damaged`), or a folder inside the library (`insideLibrary`).
 */
export type ExportDialog = "cancel" | "fresh" | "first" | "moved" | "missing" | "file" | "damaged" | "insideLibrary";

/** What a scenario may ask of a rig before it starts. */
export interface RigOptions {
  /** How many renders run at once; 1 unless a scenario needs a wider pool. */
  readonly renderConcurrency?: number;
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

/** What a commit that cannot write says, in the engine and in the mock. */
const SAVING_FAILURE = { code: "EXPORT_UNAVAILABLE", exportReason: "not-writable" } as const;

function recordOf(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected an object result");
  return Object.fromEntries(Object.entries(value));
}

function answerOf(response: ResponseMessage): Answer {
  return response.ok ? { ok: true, result: recordOf(response.result) } : { ok: false, error: response.error };
}

const scored = (ids: readonly string[]): ReadonlySet<string> => new Set(ids.filter((_id, i) => i % 2 === 0));

const isEnd = (e: EventMessage): boolean => e.type === "job.failed" || e.type === "job.cancelled" || e.type === "job.done";
const isSavingOrEnd = (e: EventMessage): boolean => (e.type === "job.progress" && e.payload.kind === "render" && e.payload.saving === true) || isEnd(e);

// ---------- the mock ----------

/** The export folder the mock starts with. */
const MOCK_FIRST_EXPORT = "/Users/studio/Studio/export";

/** The mock's stand-in for what the owner does in main's dialog; `n` makes the folders of one scenario differ. */
function mockDialog(answer: ExportDialog, writable: boolean, n: number): MockExportPick | null {
  const path = `/Users/studio/Reels-${n}`;
  switch (answer) {
    case "cancel":
      return null;
    case "fresh":
      return writable ? { path } : { path, refuse: "not-writable" };
    case "first":
      return { path: MOCK_FIRST_EXPORT };
    case "moved":
      return { path: "/Users/studio/Moved", movedFrom: MOCK_FIRST_EXPORT };
    case "missing":
      return { path, refuse: "missing" };
    case "file":
      return { path, refuse: "not-a-directory" };
    case "damaged":
      return { path, refuse: "invalid-marker" };
    case "insideLibrary":
      return { path, refuse: "overlaps-library" };
  }
}

export function mockRig(options: RigOptions = {}): ParityRig {
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
  const engine = new MockEngine({ scheduler, avatars, photos, renderConcurrency: options.renderConcurrency ?? 1 });
  const events: EventMessage[] = [];
  engine.subscribe((raw) => events.push(EventMessage.parse(raw)));
  let messages = 0;
  let writable = true;
  let dialogs = 0;
  const photoIds = photos.filter((p) => p.avatarId === MIA.avatarId).map((p) => p.photoId);
  const world: World = {
    avatarId: MIA.avatarId,
    photoIds,
    otherAvatarId: SOFIA.avatarId,
    otherPhotoIds: photos.filter((p) => p.avatarId === SOFIA.avatarId).map((p) => p.photoId),
    archivedAvatarId: NORA.avatarId,
    scored: scored(photoIds),
  };
  /** Runs the mock's clock until an event of `wanted` came after `from`. */
  const runUntil = (from: number, wanted: (e: EventMessage) => boolean): void => {
    for (let i = 0; i < 200 && !events.slice(from).some(wanted); i++) scheduler.next();
  };

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
      else runUntil(from, step === "saving" ? isSavingOrEnd : isEnd);
    },
    async settle() {
      scheduler.runAll();
    },
    control: {
      failNextRender: (at = "encode") =>
        at === "encode" ? engine.failNextRender({ code: "RENDER_FAILED", detail: FFMPEG_FAILURE_DETAIL }) : engine.failNextRender({ ...SAVING_FAILURE }, "saving"),
      exportFolder: async (state) => {
        if (state === "away") engine.setExportDisk({ status: "unavailable", reason: "missing" });
        else if (state === "file") engine.setExportDisk({ status: "unavailable", reason: "not-a-directory" });
        else if (state === "back") engine.setExportDisk({ status: "ok" });
        else engine.moveExportFolder();
      },
      exportWritable: (canWrite) => {
        writable = canWrite;
        engine.setExportDisk(canWrite ? { status: "ok" } : { status: "unavailable", reason: "not-writable" });
      },
      freeSpace: (bytes) => engine.setExportFreeBytes(bytes),
      exportMarker: async (state) => engine.setExportDisk(state === "damaged" ? { status: "unavailable", reason: "invalid-marker" } : { status: "ok" }),
      exportDialog: async (answer) => engine.pickExportFolderNext(mockDialog(answer, writable, ++dialogs)),
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
export async function realRig(dir: string, options: RigOptions = {}): Promise<ParityRig> {
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
  let failArmed: "encode" | "saving" | null = null;
  // The ffmpeg that is not there: it reports progress once the gate lets it, and writes its output once the gate lets it finish.
  const run = async (opts: RunFfmpegArgvOptions): Promise<void> => {
    await gate.wait(1, opts.signal);
    if (failArmed === "encode") {
      failArmed = null;
      throw new FfmpegError("ffmpeg failed", 1, "boom");
    }
    opts.onFrames?.(1_000_000);
    await gate.wait(2, opts.signal);
    await writingRun(opts);
  };
  // The export folder's volume, through the engine's own seam: what it says is free, and whether it takes the probe file.
  let free: number | null = null;
  let writable = true;
  const exportRootFs: ExportRootFs = {
    ...NODE_EXPORT_ROOT_FS,
    freeBytes: async (path) => free ?? NODE_EXPORT_ROOT_FS.freeBytes(path),
    createExclusive: async (path, text) => {
      if (!writable) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      await NODE_EXPORT_ROOT_FS.createExclusive(path, text);
    },
  };
  const concurrency = options.renderConcurrency ?? 1;
  const settings = (patch: Parameters<typeof engineSettings>[1] = {}) => engineSettings(dir, { renderConcurrency: concurrency, ...patch });
  const { engine, events, posted } = await startEngine(dir, {
    init: { renderTmpDir: join(dir, "userData", "render-tmp"), settings: settings() },
    deps: {
      exportRootFs,
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
          // The commit stops at its claim, past the saving announcement, until the gate is open; a commit that cannot write fails there.
          hooks: {
            reached: async (step) => {
              if (step !== "name-claimed") return;
              await gate.wait(3);
              if (failArmed === "saving") {
                failArmed = null;
                throw new RenderFailure({ ...SAVING_FAILURE });
              }
            },
          },
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

  // Main's half of `settings.setExportPath`: the real flow (main/exportFolderFlow.ts) over the real engine and a real settings file,
  // with the dialog answered by the rig. What main sends the engine is applied before the answer, so the status event it causes is
  // in the transcript before the answer (in the app it may land just after it).
  const mainDir = join(dir, "main-user-data");
  await mkdir(mainDir);
  const { store: mainSettings } = await SettingsStore.open(mainDir);
  await mainSettings.save(settings());
  let nextPick: string | null = null;
  let hostCalls = 0;
  const told: Promise<void>[] = [];
  const mainDeps: ExportFolderFlowDeps = {
    settings: mainSettings,
    engine: {
      send: (control) => void told.push(engine.applyControl(control)),
      request: (asked) => engine.handle(asked),
      chooseExport: async (path) => {
        const callId = `call-${String(++hostCalls).padStart(8, "0")}`;
        await engine.receive({ kind: "control", type: "export.choose", callId, path });
        const reply = posted.map((m) => EngineReply.safeParse(m)).find((r) => r.success && r.data.callId === callId);
        if (reply === undefined || !reply.success) throw new Error("the engine did not answer export.choose");
        return { error: reply.data.error ?? null, exportFolder: reply.data.exportFolder };
      },
    },
    pickFolder: async () => {
      const pick = nextPick;
      nextPick = null;
      return pick;
    },
    keyStatus: () => ({ stored: true, last4: "wxyz", encryptionAvailable: true, rejected: false }),
    musicKeyStatus: () => ({ stored: false, last4: null, rejected: false }),
    newId: () => `host-${String(++hostCalls).padStart(8, "0")}`,
    home: () => dir,
    platform: process.platform,
  };
  let dialogs = 0;
  const markerPath = join(exportDir, EXPORT_MARKER_FILE);
  let markerText: string | null = null;

  return {
    name: "real",
    world,
    events,
    async send(type, payload) {
      if (type === "settings.setExportPath" || type === "settings.exportDisplay") {
        const asked = CommandMessage.safeParse({ v: 5, id: `msg-${String(++hostCalls).padStart(6, "0")}`, kind: "command", type, payload });
        if (!asked.success || !isExportFolderCommand(asked.data)) return { ok: false, error: { code: "VALIDATION", detail: `${type}: the payload breaks the contract` } };
        const response = await handleExportFolderCommand(asked.data, mainDeps);
        await Promise.all(told.splice(0));
        return answerOf(ResponseMessage.parse(response));
      }
      return answerOf(ResponseMessage.parse(await engine.handle(command(type, payload))));
    },
    async advance(step) {
      const from = events().length;
      if (step === "progress") {
        gate.set(1);
        await until(() => events().length > from, "the render's progress", 10_000);
      } else if (step === "saving") {
        gate.set(2);
        await until(() => events().slice(from).some(isSavingOrEnd), "the render's saving phase", 10_000);
      } else {
        await until(() => events().slice(from).some(isEnd), "the end of a render", 10_000);
      }
    },
    settle,
    control: {
      failNextRender: (at = "encode") => {
        failArmed = at;
      },
      exportFolder: async (state) => {
        const away = `${exportDir}-away`;
        if (state === "away") await rename(exportDir, away);
        else if (state === "file") {
          await rename(exportDir, away);
          await writeFile(exportDir, "not a folder");
        } else if (state === "back") {
          // Whatever stands in the folder's place (the file of `file`) goes, and the folder that was moved away comes back.
          await rm(exportDir, { force: true });
          await rename(away, exportDir);
        } else {
          const other = join(dir, "export-other");
          await mkdir(other);
          await engine.applyControl({ kind: "control", type: "settings.update", settings: settings({ exportPath: other }) });
        }
      },
      exportWritable: (canWrite) => {
        writable = canWrite;
      },
      freeSpace: (bytes) => {
        free = bytes;
      },
      exportMarker: async (state) => {
        if (state === "damaged") {
          markerText ??= await readFile(markerPath, "utf8");
          await writeFile(markerPath, "{ damaged");
        } else if (markerText !== null) {
          await writeFile(markerPath, markerText);
          markerText = null;
        }
      },
      exportDialog: async (answer) => {
        const folder = (name: string): string => join(dir, `${name}-${++dialogs}`);
        if (answer === "cancel") nextPick = null;
        else if (answer === "first") nextPick = exportDir;
        else if (answer === "moved") {
          nextPick = join(dir, "export-moved");
          await rename(exportDir, nextPick);
        } else if (answer === "missing") nextPick = folder("nowhere");
        else if (answer === "file") {
          nextPick = folder("a-file");
          await writeFile(nextPick, "not a folder");
        } else if (answer === "insideLibrary") {
          nextPick = join(dir, "library", `exports-${++dialogs}`);
          await mkdir(nextPick);
        } else {
          nextPick = folder(answer === "fresh" ? "reels" : "damaged");
          await mkdir(nextPick);
          if (answer === "damaged") await writeFile(join(nextPick, EXPORT_MARKER_FILE), "{ not ours");
        }
      },
    },
    stop: settle,
  };
}
