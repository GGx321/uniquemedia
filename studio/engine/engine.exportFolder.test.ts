import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EngineReply } from "./control";
import { EventMessage, RelativePath, type ExportStatus, type VideoSummary } from "../shared/engine";
import { manifestTraits } from "./avatars/records";
import { checkExportRoot, EXPORT_MARKER_FILE, NODE_EXPORT_ROOT_FS, type ExportRootFs } from "./exportRoot";
import { openLibrary } from "./library";
import { PNG_1X1, samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import { NODE_COMMIT_FS } from "./videos/commitFs";
import { commitIntent, writeIntent } from "./videos/intents";
import { parseRecordSpec, type VideoRecord } from "./videos/record";
import { acceptingVerify, fakeVideoBytes, sha256Of, specOf } from "./videos/testing/kit";
import { writingRun } from "./videos/testing/serviceKit";
import { command, engineSettings, failed, GOOD, NOW, ok, startEngine, TRAITS, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// 3e.3 in the engine: the owner picked a folder in main's dialog, main asks the engine about it (`export.choose`), and the
// engine answers what the folder is (its `rootId`, from its marker, written when it has none) and how many video records
// resolve in it or stay in another folder. It adopts nothing: main persists the path and sends `settings.update`, and the
// export folder's status follows (`export.check`, which a window asks for on focus).

const dir = useEngineDir("studio-export-folder-");
const libraryDir = () => join(dir(), "library");
const exportDir = () => join(dir(), "export");

type Started = Awaited<ReturnType<typeof startEngine>>;

const chooseCall = (path: string, callId = "call-00000001") => ({ kind: "control", type: "export.choose", callId, path });

/** A freshly marked export folder at `path`: its id is what the records made in it will name. */
async function markedFolder(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  const check = await checkExportRoot({ fs: NODE_EXPORT_ROOT_FS, exportPath: path, libraryPath: libraryDir(), mayCreate: false, newId: randomUUID, now: () => new Date(NOW), caseInsensitive: false });
  if (!check.ok) throw new Error(`the test folder is unusable: ${check.reason}`);
  return check.rootId;
}

interface Seeded {
  readonly avatarId: string;
  /** One record per name, each with its real file under `<root>/Mia/`. */
  readonly videoIds: readonly string[];
  /** Scene photos no video uses. */
  readonly freePhotoIds: readonly string[];
}

/** An avatar with a photo and `count` video records naming `rootId`, their files written into `exportPath`; and `free` more photos nobody uses. */
async function seedVideos(exportPath: string, rootId: string, count: number, free = 0): Promise<Seeded> {
  const { library } = await openLibrary(libraryDir(), { now: steppingClock(), newId: sequentialIds("exp") });
  const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
  const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  const photo = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: true, confidence: 0.95 } } }));
  const videoIds: string[] = [];
  await mkdir(join(exportPath, "Mia"), { recursive: true });
  for (let i = 1; i <= count; i++) {
    const videoId = `video-0000000${i}`;
    const bytes = fakeVideoBytes(2048, i);
    const name = `2026-09-29_photo_00${i}.mp4`;
    await writeFile(join(exportPath, "Mia", name), bytes);
    const record: VideoRecord = {
      schemaVersion: 1,
      id: videoId,
      avatarId: avatar.id,
      jobId: `job-0000000${i}`,
      createdAt: `2026-09-29T10:0${i}:00.000Z`,
      kind: "photo",
      durationMs: 1000,
      frames: 30,
      montageId: null,
      music: null,
      file: { rootId, relPath: RelativePath.parse(`Mia/${name}`), bytes: bytes.length, sha256: sha256Of(bytes) },
      spec: parseRecordSpec(specOf(avatar.id, [photo.id])),
    };
    await writeIntent(NODE_COMMIT_FS, libraryDir(), record);
    await commitIntent(NODE_COMMIT_FS, libraryDir(), avatar.id, videoId);
    videoIds.push(videoId);
  }
  const freePhotoIds: string[] = [];
  const base = samplePhotoMeta().source;
  if (base.kind !== "generated") throw new Error("expected a generated sample source");
  for (let i = 1; i <= free; i++) {
    const source = { ...base, category: "home", attemptId: `run-00000001:slot-${i}#1`, slot: `slot-${i}` };
    freePhotoIds.push((await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ source, qa: { age: { adult: true, confidence: 0.95 } } }))).id);
  }
  return { avatarId: avatar.id, videoIds, freePhotoIds };
}

/**
 * The engine, started and settled: its recovery at start takes the export root's lock and holds files in the folder for a
 * moment, and Windows refuses (EPERM) to rename a folder that has a file open, so a test that moves the folder waits first.
 */
async function start(over: Parameters<typeof startEngine>[1] = {}): Promise<Started> {
  const started = await startEngine(dir(), { ...over, init: { renderTmpDir: join(dir(), "userData", "render-tmp"), settings: engineSettings(dir(), { renderConcurrency: 1 }), ...over.init } });
  await started.engine.settled();
  return started;
}

/** The engine's reply to the last call: parsed against the contract, so a reply that would not leave the engine fails here. */
function lastReply(started: Started): EngineReply {
  const reply = EngineReply.parse(started.posted.at(-1));
  return reply;
}

async function choose(started: Started, path: string): Promise<EngineReply> {
  await started.engine.receive(chooseCall(path));
  return lastReply(started);
}

/** What main does after an ok reply: persist the path and tell the engine. */
async function adopt(started: Started, path: string): Promise<void> {
  await started.engine.receive({ kind: "control", type: "settings.update", settings: engineSettings(dir(), { renderConcurrency: 1, exportPath: path }) });
}

async function listVideos(started: Started, avatarId: string): Promise<VideoSummary[]> {
  const answer = ok(await started.engine.handle(command("videos.list", { avatarId })));
  if (answer.type !== "videos.list") throw new Error(`expected videos.list, got ${answer.type}`);
  return answer.result.videos;
}

const statesOf = (videos: VideoSummary[]): string[] => videos.map((v) => v.fileState);

async function check(started: Started): Promise<ExportStatus> {
  const answer = ok(await started.engine.handle(command("export.check")));
  if (answer.type !== "export.check") throw new Error(`expected export.check, got ${answer.type}`);
  return answer.result.exportStatus;
}

const exportStatusEvents = (started: Started): ExportStatus[] =>
  started.posted.flatMap((m) => {
    const event = EventMessage.safeParse(m);
    return event.success && event.data.type === "export.status" ? [event.data.payload.exportStatus] : [];
  });

describe("export.choose: a folder the owner moved or renamed is the same folder", () => {
  test("a folder moved to another place answers the id in its marker, and every record resolves", async () => {
    const rootId = await markedFolder(exportDir());
    await seedVideos(exportDir(), rootId, 3);
    const started = await start();
    await started.engine.settled();
    const moved = join(dir(), "archive", "reels");
    await mkdir(join(dir(), "archive"));
    await rename(exportDir(), moved);

    const reply = await choose(started, moved);

    expect(reply).toEqual({ kind: "control", type: "reply", callId: "call-00000001", exportFolder: { rootId, resolved: 3, elsewhere: 0, incomplete: false } });
  });

  test("a folder renamed in place answers the same id", async () => {
    const rootId = await markedFolder(exportDir());
    await seedVideos(exportDir(), rootId, 2);
    const started = await start();
    const renamed = join(dir(), "export-2026");
    await rename(exportDir(), renamed);

    expect(await choose(started, renamed)).toMatchObject({ exportFolder: { rootId, resolved: 2, elsewhere: 0 } });
  });

  test("a folder copied to another disk (another volume has no rename) keeps its marker, so its records resolve there", async () => {
    const rootId = await markedFolder(exportDir());
    await seedVideos(exportDir(), rootId, 2);
    const started = await start();
    const otherDisk = join(dir(), "second-volume", "Reels");
    await cp(exportDir(), otherDisk, { recursive: true });

    expect(await choose(started, otherDisk)).toMatchObject({ exportFolder: { rootId, resolved: 2, elsewhere: 0 } });
  });

  test("after the owner points Settings at the moved folder, the old path reads elsewhere no more: videos.list finds every file", async () => {
    const rootId = await markedFolder(exportDir());
    const { avatarId } = await seedVideos(exportDir(), rootId, 2);
    const started = await start();
    await started.engine.settled();
    const moved = join(dir(), "moved");
    await rename(exportDir(), moved);
    expect(statesOf(await listVideos(started, avatarId))).toEqual(["elsewhere", "elsewhere"]);

    await choose(started, moved);
    await adopt(started, moved);

    expect(statesOf(await listVideos(started, avatarId))).toEqual(["present", "present"]);
  });

  test("a volume that stops answering reads `unchecked` in videos.list, not «elsewhere»: the folder was not judged, so nothing is claimed about any file", async () => {
    const rootId = await markedFolder(exportDir());
    const { avatarId } = await seedVideos(exportDir(), rootId, 2);
    let hung = false;
    const exportRootFs: ExportRootFs = { ...NODE_EXPORT_ROOT_FS, stat: (path) => (hung ? new Promise<never>(() => undefined) : NODE_EXPORT_ROOT_FS.stat(path)) };
    const started = await start({ deps: { exportRootFs, exportCheckTimeoutMs: 50 } });
    await started.engine.settled();
    expect(statesOf(await listVideos(started, avatarId))).toEqual(["present", "present"]);

    hung = true;

    expect(statesOf(await listVideos(started, avatarId))).toEqual(["unchecked", "unchecked"]);
  });

  test("a damaged intent found at start is set aside and raised as the engine's notice `pending-video-set-aside` (the engine's wiring of the recovery's count)", async () => {
    const rootId = await markedFolder(exportDir());
    const { avatarId } = await seedVideos(exportDir(), rootId, 0);
    const pending = join(libraryDir(), "avatars", avatarId, "videos", ".pending");
    await mkdir(pending, { recursive: true });
    await writeFile(join(pending, "video-0000000a.json"), "{ not json");
    const started = await start();
    await started.engine.settled();

    const snapshot = ok(await started.engine.handle(command("engine.snapshot")));

    expect(snapshot.type === "engine.snapshot" ? snapshot.result.notices.map((n) => [n.code, n.count]) : null).toEqual([["pending-video-set-aside", 1]]);
    expect(await readdir(pending)).toEqual(["video-0000000a.json.damaged"]);
  });

  test("a start with nothing wrong raises no such notice", async () => {
    const rootId = await markedFolder(exportDir());
    await seedVideos(exportDir(), rootId, 1);
    const started = await start();
    await started.engine.settled();

    const snapshot = ok(await started.engine.handle(command("engine.snapshot")));

    expect(snapshot.type === "engine.snapshot" ? snapshot.result.notices : null).toEqual([]);
  });

  test.skipIf(process.platform === "linux")("a folder renamed only in letter case, on a disk that folds case, is the same folder", async () => {
    const rootId = await markedFolder(exportDir());
    await seedVideos(exportDir(), rootId, 1);
    const started = await start();
    const upper = join(dir(), "EXPORT");
    await rename(exportDir(), join(dir(), "export-tmp"));
    await rename(join(dir(), "export-tmp"), upper);

    expect(await choose(started, upper)).toMatchObject({ exportFolder: { rootId, resolved: 1, elsewhere: 0 } });
  });
});

describe("export.choose: a different folder, and back", () => {
  test("another folder gets a marker of its own, and every record so far is counted elsewhere", async () => {
    const rootId = await markedFolder(exportDir());
    await seedVideos(exportDir(), rootId, 3);
    const started = await start();
    const other = join(dir(), "other");
    await mkdir(other);

    const reply = await choose(started, other);

    expect(reply.exportFolder?.rootId).not.toBe(rootId);
    expect(reply.exportFolder).toMatchObject({ resolved: 0, elsewhere: 3 });
    expect(JSON.parse(await readFile(join(other, EXPORT_MARKER_FILE), "utf8"))).toMatchObject({ rootId: reply.exportFolder?.rootId });
  });

  test("the old records read elsewhere while the other folder is the export folder", async () => {
    const rootId = await markedFolder(exportDir());
    const { avatarId } = await seedVideos(exportDir(), rootId, 2);
    const started = await start();
    await started.engine.settled();
    const other = join(dir(), "other");
    await mkdir(other);

    await choose(started, other);
    await adopt(started, other);

    expect(statesOf(await listVideos(started, avatarId))).toEqual(["elsewhere", "elsewhere"]);
  });

  test("choosing the first folder again resolves them all, and they are present again", async () => {
    const rootId = await markedFolder(exportDir());
    const { avatarId } = await seedVideos(exportDir(), rootId, 2);
    const started = await start();
    await started.engine.settled();
    const other = join(dir(), "other");
    await mkdir(other);
    await choose(started, other);
    await adopt(started, other);

    const back = await choose(started, exportDir());
    await adopt(started, exportDir());

    expect(back.exportFolder).toEqual({ rootId, resolved: 2, elsewhere: 0, incomplete: false });
    expect(statesOf(await listVideos(started, avatarId))).toEqual(["present", "present"]);
  });

  test("a second marked folder with no video reads every record as elsewhere, and the first folder gets them all back", async () => {
    const first = await markedFolder(exportDir());
    await seedVideos(exportDir(), first, 2);
    const second = join(dir(), "second");
    const secondId = await markedFolder(second);
    const started = await start();

    expect((await choose(started, second)).exportFolder).toEqual({ rootId: secondId, resolved: 0, elsewhere: 2, incomplete: false });
    expect((await choose(started, exportDir())).exportFolder).toEqual({ rootId: first, resolved: 2, elsewhere: 0, incomplete: false });
  });

  test("a library with no video has nothing to resolve or to leave behind", async () => {
    await markedFolder(exportDir());
    const started = await start();
    const other = join(dir(), "other");
    await mkdir(other);

    expect((await choose(started, other)).exportFolder).toMatchObject({ resolved: 0, elsewhere: 0 });
  });

  test("choosing adopts nothing: the snapshot keeps the old folder and its status until main sends the settings", async () => {
    await markedFolder(exportDir());
    const started = await start();
    const other = join(dir(), "other");
    await mkdir(other);

    await choose(started, other);

    const snapshot = ok(await started.engine.handle(command("engine.snapshot")));
    expect(snapshot.type === "engine.snapshot" ? snapshot.result.settings.exportPath : null).toBe(exportDir());
    expect(exportStatusEvents(started)).toEqual([]);
  });

  test("the chosen folder keeps nothing of the check: a marker, and no probe file", async () => {
    await markedFolder(exportDir());
    const started = await start();
    const other = join(dir(), "other");
    await mkdir(other);

    await choose(started, other);

    expect(await readdir(other)).toEqual([EXPORT_MARKER_FILE]);
  });

  test("works with no library open: nothing to count", async () => {
    await markedFolder(exportDir());
    const started = await start({ init: { settings: engineSettings(dir(), { renderConcurrency: 1, libraryPath: join(dir(), "no-such-library") }) } });
    const other = join(dir(), "other");
    await mkdir(other);

    expect((await choose(started, other)).exportFolder).toMatchObject({ resolved: 0, elsewhere: 0 });
  });
});

describe("export.choose: a folder that cannot be the export folder", () => {
  async function refusal(started: Started, path: string): Promise<EngineReply["error"]> {
    const reply = await choose(started, path);
    expect(reply.exportFolder).toBeUndefined();
    return reply.error;
  }

  test("a file in the folder's place is refused as not-a-directory", async () => {
    await markedFolder(exportDir());
    const started = await start();
    const file = join(dir(), "a-file");
    await writeFile(file, "x");

    expect(await refusal(started, file)).toMatchObject({ code: "EXPORT_UNAVAILABLE", exportReason: "not-a-directory" });
  });

  test("a folder that is not there is refused as missing, and is never created", async () => {
    await markedFolder(exportDir());
    const started = await start();
    const gone = join(dir(), "unplugged", "Reels");

    expect(await refusal(started, gone)).toMatchObject({ code: "EXPORT_UNAVAILABLE", exportReason: "missing" });
    expect(await stat(join(dir(), "unplugged")).catch(() => null)).toBeNull();
  });

  test("the default export folder is not created by a pick either: the dialog makes folders, the engine does not", async () => {
    const started = await start({ init: { defaultExportPath: join(dir(), "never") } });

    expect(await refusal(started, join(dir(), "never"))).toMatchObject({ exportReason: "missing" });
    expect(await stat(join(dir(), "never")).catch(() => null)).toBeNull();
  });

  test("a folder that takes no write is refused as not-writable, and nothing is left in it", async () => {
    await markedFolder(exportDir());
    const readOnly = join(dir(), "read-only");
    await mkdir(readOnly);
    const exportRootFs: ExportRootFs = {
      ...NODE_EXPORT_ROOT_FS,
      createExclusive: async (path, text) => {
        if (path.startsWith(readOnly)) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        await NODE_EXPORT_ROOT_FS.createExclusive(path, text);
      },
    };
    const started = await start({ deps: { exportRootFs } });

    expect(await refusal(started, readOnly)).toMatchObject({ code: "EXPORT_UNAVAILABLE", exportReason: "not-writable" });
    expect(await readdir(readOnly)).toEqual([]);
  });

  test("a folder inside the library is refused as overlapping it, before anything is written", async () => {
    await markedFolder(exportDir());
    const started = await start();
    const inside = join(libraryDir(), "exports");
    await mkdir(inside);

    expect(await refusal(started, inside)).toMatchObject({ code: "EXPORT_UNAVAILABLE", exportReason: "overlaps-library" });
    expect(await readdir(inside)).toEqual([]);
  });

  test("the library folder itself, and a folder that holds it, are refused too", async () => {
    await markedFolder(exportDir());
    const started = await start();

    expect(await refusal(started, libraryDir())).toMatchObject({ exportReason: "overlaps-library" });
    expect(await refusal(started, dir())).toMatchObject({ exportReason: "overlaps-library" });
  });

  test("a link that leads into the library is seen for what it is", async () => {
    await markedFolder(exportDir());
    const started = await start();
    const link = join(dir(), "shortcut");
    await symlink(libraryDir(), link, process.platform === "win32" ? "junction" : "dir");

    expect(await refusal(started, link)).toMatchObject({ exportReason: "overlaps-library" });
  });

  test("a folder with a damaged marker is refused as invalid-marker when the library holds no video, and its marker is left as it was", async () => {
    await markedFolder(exportDir());
    const started = await start();
    const foreign = join(dir(), "foreign");
    await mkdir(foreign);
    await writeFile(join(foreign, EXPORT_MARKER_FILE), "{ not ours");

    expect(await refusal(started, foreign)).toMatchObject({ code: "EXPORT_UNAVAILABLE", exportReason: "invalid-marker" });
    expect(await readFile(join(foreign, EXPORT_MARKER_FILE), "utf8")).toBe("{ not ours");
  });

  test("the same folder is refused as invalid-marker-with-records once the library holds videos: its marker may be the one they name", async () => {
    const rootId = await markedFolder(exportDir());
    await seedVideos(exportDir(), rootId, 1);
    const started = await start();
    const foreign = join(dir(), "foreign");
    await mkdir(foreign);
    await writeFile(join(foreign, EXPORT_MARKER_FILE), "{ not ours");

    expect(await refusal(started, foreign)).toMatchObject({ code: "EXPORT_UNAVAILABLE", exportReason: "invalid-marker-with-records" });
    expect(await readFile(join(foreign, EXPORT_MARKER_FILE), "utf8")).toBe("{ not ours");
  });

  test("a folder made by a newer Studio is refused as newer-marker and left alone", async () => {
    await markedFolder(exportDir());
    const started = await start();
    const newer = join(dir(), "newer");
    await mkdir(newer);
    const text = JSON.stringify({ schemaVersion: 2, rootId: "root-00000009" });
    await writeFile(join(newer, EXPORT_MARKER_FILE), text);

    expect(await refusal(started, newer)).toMatchObject({ exportReason: "newer-marker" });
    expect(await readFile(join(newer, EXPORT_MARKER_FILE), "utf8")).toBe(text);
  });

  test("a refusal changes nothing the windows see: no export.status event, and the old folder stays the export folder", async () => {
    await markedFolder(exportDir());
    const started = await start();

    await choose(started, join(dir(), "gone"));

    expect(exportStatusEvents(started)).toEqual([]);
    expect(await check(started)).toEqual({ status: "ok" });
  });
});

describe("export.choose while a render is queued or running", () => {
  test("is refused with IN_FLIGHT, and the folder is not touched", async () => {
    const rootId = await markedFolder(exportDir());
    const { avatarId, freePhotoIds: photos } = await seedVideos(exportDir(), rootId, 0, 2);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = await start({
      deps: {
        videos: {
          renderOverrides: {
            verify: acceptingVerify,
            runDeps: {
              run: async (opts) => {
                await held;
                await writingRun(opts);
              },
            },
          },
        },
      },
    });
    await started.engine.settled();
    const spec = { ...specOf(avatarId, photos, 2_000) };
    const rendering = ok(await started.engine.handle(command("videos.render", { spec })));
    expect(rendering.type).toBe("videos.render");
    const other = join(dir(), "other");
    await mkdir(other);

    const reply = await choose(started, other);

    expect(reply.error).toMatchObject({ code: "IN_FLIGHT" });
    expect(reply.exportFolder).toBeUndefined();
    expect(await readdir(other)).toEqual([]);
    release();
    await started.engine.renders.idle();
    // once nothing is running, the same pick goes through
    expect((await choose(started, other)).exportFolder).toBeDefined();
  });
});

/** A promise that is let go by hand. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/**
 * A render's life has three parts the folder switch must not slip between: it PREPARES (the export folder is resolved into its
 * plan at once, then the focus of its photos is judged, up to 15 s, with nothing queued yet), it is QUEUED or running, and the
 * switch itself has a window between main's answer and the `settings.update` that makes it real.
 */
describe("export.choose against a render that is still being prepared, and the window before settings.update", () => {
  async function rig(options: { holdFocus?: boolean; holdRun?: boolean; exportRootFs?: ExportRootFs } = {}) {
    const rootId = await markedFolder(exportDir());
    const seeded = await seedVideos(exportDir(), rootId, 1, 2);
    const focus = gate();
    const focusEntered = gate();
    const run = gate();
    const started = await start({
      deps: {
        ...(options.exportRootFs === undefined ? {} : { exportRootFs: options.exportRootFs }),
        videos: {
          focus: () => ({
            fillMissingFocus: async (spec) => {
              focusEntered.open();
              if (options.holdFocus === true) await focus.wait;
              return { spec, unresolved: [] };
            },
          }),
          renderOverrides: {
            verify: acceptingVerify,
            runDeps: {
              run: async (opts) => {
                if (options.holdRun === true) await run.wait;
                await writingRun(opts);
              },
            },
          },
        },
      },
    });
    const other = join(dir(), "other");
    await mkdir(other);
    const render = () => started.engine.handle(command("videos.render", { spec: specOf(seeded.avatarId, seeded.freePhotoIds, 2_000) }));
    return { started, rootId, other, render, focus, focusEntered, run, seeded };
  }

  test("a render whose focus is still being judged holds the folder: the pick is refused IN_FLIGHT, though nothing is queued yet", async () => {
    const { started, other, render, focus, focusEntered } = await rig({ holdFocus: true });
    const rendering = render();
    await focusEntered.wait;

    const reply = await choose(started, other);

    expect(reply.error).toMatchObject({ code: "IN_FLIGHT" });
    expect(reply.exportFolder).toBeUndefined();
    focus.open();
    ok(await rendering);
    await started.engine.renders.idle();
  });

  test("once that render is queued and ended, the same pick goes through", async () => {
    const { started, other, render, focus, focusEntered } = await rig({ holdFocus: true });
    const rendering = render();
    await focusEntered.wait;
    focus.open();
    ok(await rendering);
    await started.engine.renders.idle();

    expect((await choose(started, other)).exportFolder).toBeDefined();
  });

  test("a render refused while it prepared (its photos were taken) does not hold the folder after", async () => {
    const { started, other, render, seeded } = await rig();
    ok(await render());
    await started.engine.renders.idle();
    // the same photos are in a video now: this render is refused as PHOTO_UNAVAILABLE
    expect(failed(await started.engine.handle(command("videos.render", { spec: specOf(seeded.avatarId, seeded.freePhotoIds, 2_000) }))).error.code).toBe("PHOTO_UNAVAILABLE");

    expect((await choose(started, other)).exportFolder).toBeDefined();
  });

  test("a render that starts while the pick is being checked is seen after the check, and the pick is refused", async () => {
    const probe = gate();
    const probeEntered = gate();
    const exportRootFs: ExportRootFs = {
      ...NODE_EXPORT_ROOT_FS,
      createExclusive: async (path, text) => {
        if (path.includes("other")) {
          probeEntered.open();
          await probe.wait;
        }
        await NODE_EXPORT_ROOT_FS.createExclusive(path, text);
      },
    };
    const { started, other, render, run } = await rig({ holdRun: true, exportRootFs });
    const picking = choose(started, other);
    await probeEntered.wait;
    ok(await render());

    probe.open();
    const reply = await picking;

    expect(reply.error).toMatchObject({ code: "IN_FLIGHT" });
    expect(reply.exportFolder).toBeUndefined();
    run.open();
    await started.engine.renders.idle();
  });

  test("after an ok pick a render is refused IN_FLIGHT until the settings arrive, so it cannot commit into the folder the window was told is empty", async () => {
    const { started, other, render } = await rig();
    expect((await choose(started, other)).exportFolder).toBeDefined();

    expect(failed(await render()).error).toMatchObject({ code: "IN_FLIGHT" });
  });

  test("the settings that follow end the wait: a render then goes into the new folder", async () => {
    const { started, other, render } = await rig();
    await choose(started, other);
    await adopt(started, other);

    ok(await render());
    await started.engine.renders.idle();

    expect((await readdir(join(other, "Mia"))).length).toBe(1);
  });

  test("a refused pick leaves no wait behind: renders go on into the old folder", async () => {
    const { started, render } = await rig();
    await choose(started, join(dir(), "nowhere"));

    ok(await render());
    await started.engine.renders.idle();
  });

  test("a render prepared for the old folder is refused IN_FLIGHT when the settings changed the folder under it, and writes nothing into the old one", async () => {
    const { started, other, render, focus, focusEntered } = await rig({ holdFocus: true });
    const rendering = render();
    await focusEntered.wait;
    await markedFolder(other);
    await adopt(started, other);
    focus.open();

    expect(failed(await rendering).error).toMatchObject({ code: "IN_FLIGHT" });
    await started.engine.renders.idle();
    expect(await readdir(join(exportDir(), "Mia"))).toHaveLength(1); // only the seeded video's file
  });
});

describe("a damaged marker when the library cannot be read", () => {
  test("is told as invalid-marker-with-records: the records could not be looked for, so the file is never advised away", async () => {
    await markedFolder(exportDir());
    await writeFile(join(exportDir(), EXPORT_MARKER_FILE), "{ damaged");
    const started = await start({ init: { settings: engineSettings(dir(), { renderConcurrency: 1, libraryPath: join(dir(), "no-such-library") }) } });

    expect(await check(started)).toEqual({ status: "unavailable", reason: "invalid-marker-with-records" });
  });

  test("and so is a library that holds an avatar nobody could read: its videos may be the ones that name the marker", async () => {
    await markedFolder(exportDir());
    const { library } = await openLibrary(libraryDir(), { now: steppingClock(), newId: sequentialIds("bad") });
    await library.createAvatar({ name: "Early", age: 25, traits: { hair: "chestnut" }, descriptor: GOOD });
    await writeFile(join(exportDir(), EXPORT_MARKER_FILE), "{ damaged");
    const started = await start();

    expect(await check(started)).toEqual({ status: "unavailable", reason: "invalid-marker-with-records" });
  });
});

describe("export.choose: the engine's own work folder", () => {
  test("a folder inside userData/render-tmp is refused, since the start-up sweep of that folder would delete what is exported there", async () => {
    await markedFolder(exportDir());
    const started = await start();
    const inside = join(dir(), "userData", "render-tmp", "exports");
    await mkdir(inside, { recursive: true });

    const reply = await choose(started, inside);

    expect(reply.error).toMatchObject({ code: "EXPORT_UNAVAILABLE", exportReason: "overlaps-work-folder" });
    expect(await readdir(inside)).toEqual([]);
  });

  test("so is the render folder itself, and a folder that holds it", async () => {
    await markedFolder(exportDir());
    const started = await start();
    await mkdir(join(dir(), "userData", "render-tmp"), { recursive: true });

    expect((await choose(started, join(dir(), "userData", "render-tmp"))).error).toMatchObject({ exportReason: "overlaps-work-folder" });
    expect((await choose(started, join(dir(), "userData"))).error).toMatchObject({ exportReason: "overlaps-work-folder" });
  });
});

describe("export.choose: counts that are not whole", () => {
  test("a record file nobody could read is said so: the counts are marked incomplete", async () => {
    const rootId = await markedFolder(exportDir());
    const seeded = await seedVideos(exportDir(), rootId, 1);
    await writeFile(join(libraryDir(), "avatars", seeded.avatarId, "videos", "video-0000000b.json"), "{ not json");
    const started = await start();

    expect((await choose(started, exportDir())).exportFolder).toMatchObject({ resolved: 1, elsewhere: 0, incomplete: true });
  });

  test("whole counts are not marked", async () => {
    const rootId = await markedFolder(exportDir());
    await seedVideos(exportDir(), rootId, 1);
    const started = await start();

    expect((await choose(started, exportDir())).exportFolder).toMatchObject({ incomplete: false });
  });
});

describe("export.check: an unplugged or replugged folder shows up without a render", () => {
  test("a folder that is fine answers ok, and says nothing", async () => {
    await markedFolder(exportDir());
    const started = await start();

    expect(await check(started)).toEqual({ status: "ok" });
    expect(exportStatusEvents(started)).toEqual([]);
  });

  test("a folder that went away answers unavailable, and tells the windows once", async () => {
    await markedFolder(exportDir());
    const started = await start();
    await rename(exportDir(), join(dir(), "unplugged"));

    expect(await check(started)).toEqual({ status: "unavailable", reason: "missing" });
    expect(await check(started)).toEqual({ status: "unavailable", reason: "missing" });

    expect(exportStatusEvents(started)).toEqual([{ status: "unavailable", reason: "missing" }]);
  });

  test("a folder that came back answers ok, and tells the windows it is usable again", async () => {
    await markedFolder(exportDir());
    const started = await start();
    await rename(exportDir(), join(dir(), "unplugged"));
    await check(started);

    await rename(join(dir(), "unplugged"), exportDir());

    expect(await check(started)).toEqual({ status: "ok" });
    expect(exportStatusEvents(started)).toEqual([{ status: "unavailable", reason: "missing" }, { status: "ok" }]);
  });

  test("the snapshot follows the check", async () => {
    await markedFolder(exportDir());
    const started = await start();
    await rename(exportDir(), join(dir(), "unplugged"));
    await check(started);

    const snapshot = ok(await started.engine.handle(command("engine.snapshot")));

    expect(snapshot.type === "engine.snapshot" ? snapshot.result.exportStatus : null).toEqual({ status: "unavailable", reason: "missing" });
  });

  test("a marker that became unreadable reads invalid-marker for a library with no video", async () => {
    await markedFolder(exportDir());
    const started = await start();
    await writeFile(join(exportDir(), EXPORT_MARKER_FILE), "{ damaged");

    expect(await check(started)).toEqual({ status: "unavailable", reason: "invalid-marker" });
  });

  test("and invalid-marker-with-records once the library holds a video, which is the one text that never suggests deleting it", async () => {
    const rootId = await markedFolder(exportDir());
    await seedVideos(exportDir(), rootId, 1);
    const started = await start();
    await writeFile(join(exportDir(), EXPORT_MARKER_FILE), "{ damaged");

    expect(await check(started)).toEqual({ status: "unavailable", reason: "invalid-marker-with-records" });
    expect(await readFile(join(exportDir(), EXPORT_MARKER_FILE), "utf8")).toBe("{ damaged");
  });

  test("a check of a hung disk is bounded, like every other export check", async () => {
    await markedFolder(exportDir());
    const exportRootFs: ExportRootFs = { ...NODE_EXPORT_ROOT_FS, stat: () => new Promise(() => undefined) };
    const started = await start({ deps: { exportRootFs, exportCheckTimeoutMs: 50 } });

    expect(await check(started)).toEqual({ status: "unavailable", reason: "not-writable" });
  });

  test("is refused by the contract when it carries a payload", async () => {
    await markedFolder(exportDir());
    const started = await start();

    const response = failed(await started.engine.handle(command("export.check", { force: true })));

    expect(response.error.code).toBe("VALIDATION");
  });
});
