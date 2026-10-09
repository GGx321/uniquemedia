import { readFileSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat, truncate, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { CommandMessage, EventMessage, MEDIA_BYTE_CAPS, ResponseMessage, type AvatarSummary, type CategoryInterrupted, type CategorySummary, type PhotoSummary } from "../../../shared/engine";
import { handleExportFolderCommand, isExportFolderCommand, type ExportFolderFlowDeps } from "../../../main/exportFolderFlow";
import { handleMediaPickCommand, isMediaPickCommand, type MediaImportFlowDeps } from "../../../main/mediaImportFlow";
import { handleSettingsCommand, isSettingsCommand, type SettingsFlowDeps } from "../../../main/settingsFlow";
import { SettingsStore } from "../../../main/settingsStore";
import { createApngEncoder } from "../../../shared/stickers/apngWriter";
import { EngineReply } from "../../control";
import { FfmpegError, type RunFfmpegArgvOptions } from "../../../node/runFfmpeg";
import { MockEngine, type MockExportPick, type MockMediaPick } from "../../../renderer/engine/mockEngine";
import { MIA, NORA, scenePhoto, SOFIA } from "../../../renderer/engine/mockEngine.testkit";
import { ManualScheduler } from "../../../renderer/engine/scheduler";
import { IDLE_STEPS } from "../../autopilot/steps";
import { manifestTraits } from "../../avatars/records";
import { EXPORT_MARKER_FILE, NODE_EXPORT_ROOT_FS, type ExportRootFs } from "../../exportRoot";
import { openLibrary } from "../../library";
import type { MediaImporter } from "../../media/imports";
import { TrackStore } from "../../music/trackStore";
import { excerptOf, fakeCdn, JPEG_1X1 } from "../../music/testing/storeKit";
import { createCaptionRenderer, type CaptionRequest } from "../../text/caption/renderer";
import { openEmojiFont } from "../../text/emoji/emojiFont";
import { loadPinnedEmojiFont } from "../../text/emoji/emojiFont.testkit";
import { createTextRasteriser, RASTER_WASM } from "../../text/rasteriser";
import type { CaptionCallOptions, GateCaption } from "../../text/worker/textGate";
import type { PreviewGate } from "../../text/preview";
import { parityDecodedMs, parityListTracks, parityMockSeeds, parityPeaks } from "./tracks";
import { PNG_1X1, samplePhotoMeta, sequentialIds, steppingClock } from "../../library/testing/helpers";
import { RenderFailure } from "../../renderQueue/queue";
import { command, engineSettings, GOOD, NOW, portraitPng, startEngine, TRAITS, until } from "../../testing/engineHarness";
import type { Reply } from "../../openrouter/testing/fakes";
import { imageReply, network as launchNetwork, writerReply } from "../../testing/wiringKit";
import { within } from "../../testing/within";
import { acceptingVerify } from "../../videos/testing/kit";
import { reportVideoClipFrames, writingRun } from "../../videos/testing/serviceKit";
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
  /** 3f.1: what main's own-media dialog answers the next `media.pickImport` (used once; with nothing said it is cancelled). */
  mediaDialog(answer: MediaDialog): Promise<void>;
  /**
   * 3f.1b: while held, an import job that starts waits before its first byte is copied (the real rig's staging copy, the mock's timer), so
   * a scenario can answer, cancel or list while it runs. `false` lets every held job go on. Needs `RigOptions.ownMedia`.
   */
  holdImports(held: boolean): void;
  /** 3c.6: the owner stored a RapidAPI key (the engine is told as main tells it after «Сохранить»). */
  musicKey(): Promise<void>;
  /** 3c.6: the flashapi quota log on disk gets a complete line that cannot be read (`corrupt`), or a folder where the file was (`unreadable`). */
  musicQuotaLog(state: "corrupt" | "unreadable" | "deleted"): Promise<void>;
  /**
   * 3d.1b: the music store holds the parity tracks (studio/engine/parity/testing/tracks.ts): the real one downloaded them from a fake CDN, the mock was seeded with the same list. Once per scenario.
   * `decoded-apart` (3d.3b verify): track one's decode proves a length shorter than the list claims (`PARITY_DECODED_APART`).
   */
  musicTracks(variant?: "decoded-apart"): Promise<void>;
  /** 3d.1b: from now a text drawing that has started waits for `releaseText`, so previews can queue behind it; `false` lets go of what waits and stops holding. */
  holdText(held: boolean): void;
  /** 3d.1b: the held drawing ends, and the next one starts (and waits again while held). With nothing held, nothing happens. */
  releaseText(): void;
  /** 3d.1b: whether the picture of a text preview id is still served (the engine's file is on disk, the mock still holds the PNG). */
  previewServed(previewId: string): Promise<boolean>;
  /** Stage 4 (S4.8): what only a rig can do to a launch's world. A rig started without `RigOptions.launch` refuses every one. */
  readonly launch: LaunchControl;
}

/**
 * Stage 4 (S4.8): the launch's outside world, told the same way to both rigs. The real rig answers through the fake OpenRouter and the engine's own process; the mock arms its testkit
 * switch (`failLaunchPaidStep`, `quitLaunch`). Needs `RigOptions.launch`.
 */
export interface LaunchControl {
  /**
   * The next paid request OpenRouter is asked gets a failure: `credits` (402) or `key` (401). Used once; the launch's next paid step meets it. `job-failed` (S4.6r) is a slice's job that
   * ends INTERNAL: the real rig damages the main avatar's master photo on disk (its run cannot prepare it as the face reference), the mock arms its switch; the compose, which does not read
   * the master, is not affected. `repairMaster` makes the master whole again.
   */
  fault(cause: "credits" | "key" | "job-failed"): void;
  /** The master photo that `fault("job-failed")` damaged is whole again. Nothing to do for a rig that did not damage one. */
  repairMaster(): Promise<void>;
  /** The owner has a key OpenRouter accepts again (a new key stored): what releases a key hold. */
  newKey(): Promise<void>;
  /** The next writer request leaves and gets no answer, for as long as the scenario lasts (a request in flight whose reserve a quit leaves open). */
  hangWriter(): void;
  /** The owner quits the app and starts it again: a request in flight died with the process, and the engine reads the running launch as paused by the quit. */
  quit(): Promise<void>;
}

/** The RapidAPI key the rigs store: obviously fake (studio/testing/keyLeaks.ts). No request is ever sent with it. */
const PARITY_MUSIC_KEY = "Zq7-vKt9-Wm2x-Lp4s-0000";
/** The OpenRouter key a launch scenario stores after a rejection: obviously fake, and sent only to the rig's fake OpenRouter. */
const PARITY_OPENROUTER_KEY = "sk-or-v1-parity0123456789abcdef-new1";

/**
 * The owner's pick in the dialog: nothing (`cancel`), a new empty folder (`fresh`), the export folder the rig started with (`first`),
 * that folder moved to another place (`moved`), a path with nothing there (`missing`), a file (`file`), a folder whose marker is
 * damaged (`damaged`), or a folder inside the library (`insideLibrary`).
 */
export type ExportDialog = "cancel" | "fresh" | "first" | "moved" | "missing" | "file" | "damaged" | "insideLibrary";

/**
 * The owner's pick in main's own-media dialog (3f.1): nothing (`cancel`), or seven files at once, each a different way for the boundary to
 * turn it away (`mixed`, see MIXED_MEDIA). The real rig makes the files on disk; the mock is told the verdict for each name, and holds no path.
 */
export type MediaDialog = "cancel" | "mixed" | "good" | "tiny" | "sticker" | "stillSticker" | "video" | "badVideo" | "preparedVideo" | "track" | "long-track";

/**
 * The video picks (3f.3a), for a rig with `ownMedia`: one clip the rigs' video importer takes (`video`), and one it refuses after its copy as
 * a codec it does not read (`badVideo`). The real rig's importer is a stand-in that decides from the bytes (the real one needs ffmpeg and has its
 * own tests): what the suite holds side by side is the JOB's behaviour around an importer's answer, in the engine and in the mock.
 */
const GOOD_VIDEO = "walk.mov";
const BAD_VIDEO = "clip.mov";
/**
 * The clip of the `preparedVideo` pick (3f.6): its importer reports its work (a stand-in for the real one's ffmpeg frames), so the story has the prepare stage. 60 output
 * frames, a step each quarter of them (the engine announces a percent at a time and the mock plays 3 steps: the numbers are not written, the stages are), and what the probe
 * judged: HDR and a 60 fps source.
 */
const PREPARED_VIDEO = "street.mov";
const PARITY_PREPARE = { total: 60, steps: 3, judged: { hdrToSdr: true, fromFps: 59.94 } } as const;
export const PARITY_VIDEO_BYTES = 200;
/** What the real rig's video importer says of a clip it takes, and what the mock is told to say. */
export const PARITY_VIDEO_FACTS = { width: 1080, height: 1920, durationMs: 6400, sourceFps: 29.97, hdrToSdr: true, loopFrames: null, delayFrames: null } as const;
/** A clip with this in its first bytes is the one the real rig's video importer refuses as a `codec`. */
const PARITY_UNSUPPORTED_CODEC = "vp09";

/** Writes a clip (an ISO box file's `ftyp` and a body) into `folder`; the bad one carries the codec the importer refuses. */
async function writeVideoMedia(folder: string, which: "good" | "bad" | "prepared"): Promise<string[]> {
  await mkdir(folder, { recursive: true });
  const bad = which === "bad";
  const name = bad ? BAD_VIDEO : which === "prepared" ? PREPARED_VIDEO : GOOD_VIDEO;
  const head = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypqt  "), Buffer.alloc(4), Buffer.from("qt  "), Buffer.from("mp41")]);
  const body = Buffer.alloc(PARITY_VIDEO_BYTES - head.length, 3);
  if (bad) body.write(PARITY_UNSUPPORTED_CODEC, 0, "latin1");
  await writeFile(join(folder, name), Buffer.concat([head, body]));
  return [join(folder, name)];
}

/** The stand-in mezzanine of the rig's video importer (3f.3b): an `isom` MP4 head and filler, `PARITY_VIDEO_BYTES` long. */
const PARITY_MEZZANINE = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(4), Buffer.from("isom"), Buffer.alloc(PARITY_VIDEO_BYTES - 24, 5)]);

/** The one good photo of the `good` pick (3f.1b): accepted by the rigs' importer, and `PARITY_PHOTO_BYTES` long. */
const GOOD_PHOTO = "lake.jpg";
export const PARITY_PHOTO_BYTES = 120;
/** What the real rig's photo importer says of any photo it takes, and what the mock is told to say. */
export const PARITY_PHOTO_FACTS = { width: 100, height: 200, durationMs: null, sourceFps: null, hdrToSdr: false, loopFrames: null, delayFrames: null } as const;

/** The one picture of the `tiny` pick (3f.2): the boundary takes it (its bytes are a photo's) and the photo importer refuses it inside the job. */
const TINY_PHOTO = "dot.jpg";

/**
 * The own sticker of the `sticker` pick (3f.5): a GIF the boundary takes, which the rigs' sticker importer stores as a real two-frame APNG (12 x 8, 3
 * slots a frame, a loop of 6), because a render reads the stored file back and checks it against its record. The `stillSticker` pick is a PNG the
 * boundary takes (a PNG may be a sticker) and the importer turns away inside the job as `not-animated`.
 */
const GOOD_STICKER = "party.gif";
const STILL_STICKER = "still.png";
export const PARITY_STICKER_BYTES = 120;
export const PARITY_STICKER_FACTS = { width: 12, height: 8, durationMs: null, sourceFps: null, hdrToSdr: false, loopFrames: 6, delayFrames: [3, 3] } as const;

/** The APNG the rigs' sticker importer stores: deterministic, valid for the strict reader, and what the record says it is. */
function parityStickerApng(): Uint8Array {
  const encoder = createApngEncoder({ width: PARITY_STICKER_FACTS.width, height: PARITY_STICKER_FACTS.height, frameCount: 2 });
  encoder.add(new Uint8Array(12 * 8 * 4).fill(60), 3);
  encoder.add(new Uint8Array(12 * 8 * 4).fill(200), 3);
  return encoder.finish();
}

/** Writes the `sticker` or `stillSticker` pick's file into `folder` and returns its path. */
async function writeStickerMedia(folder: string, still: boolean): Promise<string[]> {
  await mkdir(folder, { recursive: true });
  const name = still ? STILL_STICKER : GOOD_STICKER;
  const head = still ? Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) : Buffer.from("GIF89a");
  await writeFile(join(folder, name), Buffer.concat([head, Buffer.alloc(PARITY_STICKER_BYTES - head.length, 5)]));
  return [join(folder, name)];
}

/** The one good track of the `track` pick (3f.4): its bytes are an mp3's head, and the rigs' importer stores it as an M4A of `PARITY_TRACK_MS`. */
const GOOD_TRACK = "voice.mp3";
export const PARITY_TRACK_BYTES = 200;
export const PARITY_TRACK_MS = 12_000;
/** What the real rig's music importer says of any track it takes, and what the mock is told to say. */
export const PARITY_TRACK_FACTS = { width: null, height: null, durationMs: PARITY_TRACK_MS, sourceFps: null, hdrToSdr: false, loopFrames: null, delayFrames: null } as const;
/** The waveform both rigs keep for the good track: one value per 50 ms, 0 to 1000, never flat. */
export const PARITY_TRACK_WAVEFORM: readonly number[] = Array.from({ length: PARITY_TRACK_MS / 50 }, (_, i) => (i * 53 + 90) % 1001);

/** The one track of the `long-track` pick (3f.4): the boundary takes it (its bytes are an mp3's) and the music importer refuses it inside the job as `too-long`. */
const LONG_TRACK = "long.mp3";

/** The head of an mp3 with an ID3v2 tag, then padding: what the boundary's sniff takes for music. */
const trackHead = (fill: number): Buffer => Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]), Buffer.alloc(PARITY_TRACK_BYTES - 10, fill)]);

/** An M4A's first bytes (brand `M4A `): what the rigs' music importer "makes", so the stored track is one the render's chain could read. */
const PARITY_M4A = Buffer.from([0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0, 0, 2, 0, 0x6d, 0x70, 0x34, 0x32]);

/** Writes the `track` pick's file into `folder` and returns its path. */
async function writeGoodTrack(folder: string): Promise<string[]> {
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, GOOD_TRACK), trackHead(5));
  return [join(folder, GOOD_TRACK)];
}

/** Writes the `long-track` pick's file into `folder` and returns its path. */
async function writeLongTrack(folder: string): Promise<string[]> {
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, LONG_TRACK), trackHead(6));
  return [join(folder, LONG_TRACK)];
}

/** Writes the `tiny` pick's file into `folder` and returns its path. */
async function writeTinyMedia(folder: string): Promise<string[]> {
  await mkdir(folder, { recursive: true });
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(PARITY_PHOTO_BYTES - 4, 3)]);
  await writeFile(join(folder, TINY_PHOTO), jpeg);
  return [join(folder, TINY_PHOTO)];
}

/** Writes the `good` pick's file into `folder` and returns its path. */
async function writeGoodMedia(folder: string): Promise<string[]> {
  await mkdir(folder, { recursive: true });
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(PARITY_PHOTO_BYTES - 4, 7)]);
  await writeFile(join(folder, GOOD_PHOTO), jpeg);
  return [join(folder, GOOD_PHOTO)];
}

/** The seven files of the `mixed` pick, in the order the dialog returns them, with the verdict the boundary gives each (no importer exists yet, so a good photo is `not-yet-supported`). */
const MIXED_MEDIA: readonly MockMediaPick[] = [
  { name: "summer.jpg", reason: "not-yet-supported" },
  { name: "notes.jpg", reason: "format" },
  { name: "album.jpg", reason: "not-a-file" },
  { name: "empty.jpg", reason: "empty" },
  { name: "huge.jpg", reason: "too-large" },
  { name: "IMG_0001.HEIC", reason: "heic" },
  { name: "gone.jpg", reason: "not-a-file" },
];

/** Writes the `mixed` pick's files into `folder` and returns their paths, in the dialog's order. */
async function writeMixedMedia(folder: string): Promise<string[]> {
  await mkdir(folder, { recursive: true });
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 7)]);
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(60)]);
  await writeFile(join(folder, "summer.jpg"), jpeg);
  await writeFile(join(folder, "notes.jpg"), "just some notes, not a photo");
  await mkdir(join(folder, "album.jpg"), { recursive: true });
  await writeFile(join(folder, "empty.jpg"), "");
  await writeFile(join(folder, "huge.jpg"), jpeg);
  await truncate(join(folder, "huge.jpg"), MEDIA_BYTE_CAPS.photo + 1);
  await writeFile(join(folder, "IMG_0001.HEIC"), heic);
  return MIXED_MEDIA.map((file) => join(folder, file.name));
}

/** Breaks what the avatar's photo usage is read from, in its folder on disk (`RigOptions.usage`): the engine finds it when it opens the library. */
async function breakUsage(avatarDir: string, avatarId: string, usage: NonNullable<RigOptions["usage"]>): Promise<void> {
  if (usage === "rejects-unreadable") {
    await writeFile(join(avatarDir, "rejected.jsonl"), "not json\n");
    return;
  }
  await mkdir(join(avatarDir, "videos"), { recursive: true });
  const record = usage === "library-too-new" ? JSON.stringify({ schemaVersion: 2, id: "video-00000009", avatarId }) : "{ not json";
  await writeFile(join(avatarDir, "videos", "video-00000009.json"), record);
}

/** What a scenario may ask of a rig before it starts. */
export interface RigOptions {
  /** How many renders run at once; 1 unless a scenario needs a wider pool. */
  readonly renderConcurrency?: number;
  /** 3f.1b: the real rig gets a photo importer (as 3f.2 will give the app one), so a good photo is accepted; the mock accepts the dialog's `good` file. Without it no importer exists and a good photo is `not-yet-supported`. */
  readonly ownMedia?: boolean;
  /**
   * K16: the main avatar's photo usage cannot be trusted from the start, for one reason. The real rig writes the broken file into the avatar's folder before the
   * engine opens the library (a record that is not JSON, one a newer Studio wrote, a reject log with a bad line); the mock is seeded with the same reason.
   * (`index-stale` is memory only, never a file: the unit tests of both engines hold it.)
   */
  readonly usage?: "record-unreadable" | "library-too-new" | "rejects-unreadable";
  /**
   * CS.2: the library holds one custom category (`PARITY_CATEGORY`), one category file nothing can read, and the record of one create a closed Studio left
   * (`PARITY_INTERRUPTED`). The real rig writes them through the library's own store before the engine opens it; the mock is seeded with the same.
   */
  readonly categories?: boolean;
  /**
   * CS.4a: Mia holds one open scene set (`PARITY_SCENE_SET`: three scenes, the first written, a compose a closed Studio did not finish) and one set file
   * nothing can read. The real rig writes them through the library's own store before the engine opens it; the mock is seeded with the same.
   */
  readonly sceneSets?: boolean;
  /**
   * CS.4b: instead of `sceneSets`, Mia holds one open set of three written planned scenes and an own scene written from an idea, with the records of two
   * review writes a closed Studio left (a rewrite of scene 2, an idea write for two more scenes), and one set file nothing can read. Nothing was reserved for
   * either write, so each has both attempts. The real rig writes them through the library's own store; the mock is seeded with the same.
   */
  readonly reviewWrites?: boolean;
  /** CS.2: with `categories`, a second readable category (`PARITY_SECOND_CATEGORY`), so a rename can meet a name another category holds. */
  readonly secondCategory?: boolean;
  /**
   * Stage 4 (S4.8): a launch RUNS. The real rig leaves the engine's default launch steps in (the paid and the free path, over a fake OpenRouter that answers the writer, the
   * images and the credits, a face gate that passes, and the rig's fake ffmpeg), its renders flow freely, and the track store feeds the autopilot; the mock runs its launch on
   * its clock. Without it the real rig plugs `IDLE_STEPS` and the mock keeps its canned launch (the S4.1 stories are bound to both).
   */
  readonly launch?: boolean;
}

/** The custom category of a rig with `categories`: what the real store holds and the mock lists. */
export const PARITY_CATEGORY: Omit<CategorySummary, "createdAt" | "updatedAt"> = {
  categoryId: "cat-parity-0001",
  name: "Кофейни Парижа",
  description: "кофейни и булочные Парижа",
  label: "Paris cafes",
  style: "phone",
  pool: {
    locations: ["a corner cafe", "a flower stall", "a bookshop", "a riverside bench", "a bakery counter"].map((name, i) => ({
      name,
      times: ["morning", "midday"],
      activities: [
        { text: "reading a menu", twoHanded: false },
        { text: "stirring a cappuccino", twoHanded: true },
      ],
      mirror: i === 2,
    })),
    outfits: ["a beige trench coat and jeans", "a striped tee and a beret", "a black midi dress", "a red scarf and a coat"],
    shotDeck: ["friend", "friend", "selfie", "mirror", "candid"],
  },
  model: "x-ai/grok-4.3",
  spentMicros: 5_000,
};

/** The second category of a rig with `categories` and `secondCategory`. */
export const PARITY_SECOND_CATEGORY: Omit<CategorySummary, "createdAt" | "updatedAt"> = { ...PARITY_CATEGORY, categoryId: "cat-parity-0002", name: "Горы зимой", description: "горы зимой" };

/** The create a closed Studio left in a rig with `categories`: nothing of it is in the rig's ledger, so it is counted at nothing. */
export const PARITY_INTERRUPTED = {
  jobId: "job-parity-0001",
  kind: "create",
  name: "Горы зимой",
  description: "горы зимой",
  categoryId: null,
  startedAt: "2026-10-05T12:00:00.000Z",
  spentMicros: 0,
  openReserveMicros: 0,
} as const satisfies CategoryInterrupted;

/** The scenes of a rig with `sceneSets`: what the real store holds and the mock lists. The first has its sentence. */
export const PARITY_SCENES = [
  { category: "home", shot: "friend", pose: "front", place: { location: "a sunny kitchen", timeOfDay: "morning", activity: "pouring coffee", outfit: "a linen shirt and shorts" }, text: "A friend catches her pouring coffee in the morning light." },
  { category: "home", shot: "selfie", pose: "three-quarter", place: { location: "a cosy living room", timeOfDay: "evening", activity: "reading on the sofa", outfit: "an oversized knit sweater" } },
  { category: "home", shot: "candid", pose: "front", place: { location: "a bedroom mirror", timeOfDay: "morning", activity: "fixing her hair", outfit: "a silk robe and slacks" } },
] as const;

export const PARITY_SCENE_SET_ID = "set-parity-0001";

/** The scenes of a rig with `reviewWrites`: three planned and written, and an own scene written from an idea and typed over by hand. */
export const PARITY_REVIEW_PLANNED = PARITY_SCENES.map((scene, i) => ({ ...scene, text: "text" in scene ? scene.text : `A friend catches her in the scene ${i + 1} light.` }));
export const PARITY_REVIEW_OWN = { idea: "кофе на балконе утром", shot: "selfie", pose: "front", text: "She sips coffee on a balcony, one hand free." } as const;
/** The records of the writes a closed Studio left: a rewrite of scene 2 (a dropped connection) and an idea write of two scenes (a rate limit), under write numbers 2 and 3. */
export const PARITY_REVIEW_REWRITE = { kind: "rewrite", k: 2, sceneIds: [2], stoppedBy: "network" } as const;
export const PARITY_REVIEW_IDEA = { kind: "idea", k: 3, idea: "прогулка по набережной", count: 2, shot: null, sceneIds: [5, 6], stoppedBy: "rate-limited" } as const;

export interface ParityRig extends Recorded {
  readonly name: "mock" | "real";
  readonly world: World;
  readonly control: Control;
  /** Lets whatever is queued or running end, so nothing outlives the scenario. */
  stop(): Promise<void>;
  pump(): Promise<void>;
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
    options.usage === undefined
      ? { ...MIA, photoCount: MAIN_PHOTOS, eligibleUnusedCount: MAIN_PHOTOS }
      : { ...MIA, photoCount: MAIN_PHOTOS, eligibleUnusedCount: 0, usage: { state: "unknown", reasons: [options.usage] } },
    { ...SOFIA, photoCount: OTHER_PHOTOS, eligibleUnusedCount: OTHER_PHOTOS },
    { ...NORA, photoCount: 0, eligibleUnusedCount: 0 },
  ];
  const engine = new MockEngine({
    scheduler,
    avatars,
    photos,
    renderConcurrency: options.renderConcurrency ?? 1,
    // The S4.1 stories are bound to the mock's canned launch; a rig that asks for a running launch gets the mock that runs one.
    launchRun: options.launch === true ? "timers" : "canned",
    ...(options.categories === true
      ? {
          categories: [
            { ...PARITY_CATEGORY, createdAt: "2026-10-05T10:00:00.000Z", updatedAt: "2026-10-05T10:00:00.000Z" },
            ...(options.secondCategory === true ? [{ ...PARITY_SECOND_CATEGORY, createdAt: "2026-10-05T10:01:00.000Z", updatedAt: "2026-10-05T10:01:00.000Z" }] : []),
          ],
          unreadableCategories: 1, interruptedCategories: [{ ...PARITY_INTERRUPTED }] }
      : {}),
    ...(options.sceneSets === true
      ? { sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: PARITY_SCENE_SET_ID, count: PARITY_SCENES.length, written: 1, stopped: "closed" as const, scenes: PARITY_SCENES }], unreadableSceneSets: 1 }
      : {}),
    ...(options.reviewWrites === true
      ? {
          sceneSets: [
            {
              avatarId: MIA.avatarId,
              sceneSetId: PARITY_SCENE_SET_ID,
              count: PARITY_REVIEW_PLANNED.length,
              written: 0,
              scenes: [...PARITY_REVIEW_PLANNED, { ...PARITY_REVIEW_OWN }],
              writes: 3,
              reviewWrites: [{ ...PARITY_REVIEW_REWRITE, sceneIds: [...PARITY_REVIEW_REWRITE.sceneIds] }, { ...PARITY_REVIEW_IDEA, sceneIds: [...PARITY_REVIEW_IDEA.sceneIds] }],
            },
          ],
          unreadableSceneSets: 1,
        }
      : {}),
  });
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
    async pump() {
      scheduler.next();
    },
    control: {
      launch: {
        fault: (cause) => engine.failLaunchPaidStep(cause),
        // The mock's fault is consumed by the step that meets it: nothing was damaged, so nothing is repaired.
        repairMaster: async () => undefined,
        newKey: async () => {
          await engine.request(CommandMessage.parse({ v: 5, id: `msg-${String(++messages).padStart(6, "0")}`, kind: "command", type: "settings.setApiKey", payload: { key: PARITY_OPENROUTER_KEY } }));
        },
        // The mock's request is in flight between two ticks of its clock; the scenario stops pumping when it sees one.
        hangWriter: () => undefined,
        quit: async () => engine.quitLaunch(),
      },
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
      mediaDialog: async (answer) =>
        engine.pickMediaNext(
          answer === "cancel"
            ? null
            : answer === "good"
              ? // With an importer the good photo is accepted; without one (the app until 3f.2) it is turned away before it is copied.
                [options.ownMedia === true ? { name: GOOD_PHOTO, accept: { kind: "photo", bytes: PARITY_PHOTO_BYTES, facts: PARITY_PHOTO_FACTS } } : { name: GOOD_PHOTO, reason: "not-yet-supported" }]
              : answer === "tiny"
                ? [options.ownMedia === true ? { name: TINY_PHOTO, accept: { kind: "photo", bytes: PARITY_PHOTO_BYTES, failWith: "too-small" } } : { name: TINY_PHOTO, reason: "not-yet-supported" }]
                : answer === "sticker"
                  ? [options.ownMedia === true ? { name: GOOD_STICKER, accept: { kind: "sticker", bytes: PARITY_STICKER_BYTES, facts: { ...PARITY_STICKER_FACTS, delayFrames: [...PARITY_STICKER_FACTS.delayFrames] } } } : { name: GOOD_STICKER, reason: "not-yet-supported" }]
                  : answer === "stillSticker"
                    ? [options.ownMedia === true ? { name: STILL_STICKER, accept: { kind: "sticker", bytes: PARITY_STICKER_BYTES, failWith: "not-animated" } } : { name: STILL_STICKER, reason: "not-yet-supported" }]
                : answer === "video"
                  ? [{ name: GOOD_VIDEO, accept: { kind: "video", bytes: PARITY_VIDEO_BYTES, facts: PARITY_VIDEO_FACTS } }]
                  : answer === "badVideo"
                    ? [{ name: BAD_VIDEO, accept: { kind: "video", bytes: PARITY_VIDEO_BYTES, failWith: "codec" } }]
                    : answer === "preparedVideo"
                      ? [{ name: PREPARED_VIDEO, accept: { kind: "video", bytes: PARITY_VIDEO_BYTES, facts: PARITY_VIDEO_FACTS, prepare: { ...PARITY_PREPARE, judged: { ...PARITY_PREPARE.judged } } } }]
                : answer === "track"
                  ? [options.ownMedia === true ? { name: GOOD_TRACK, accept: { kind: "audio", bytes: PARITY_TRACK_BYTES, facts: PARITY_TRACK_FACTS, waveform: [...PARITY_TRACK_WAVEFORM] } } : { name: GOOD_TRACK, reason: "not-yet-supported" }]
                  : answer === "long-track"
                    ? [options.ownMedia === true ? { name: LONG_TRACK, accept: { kind: "audio", bytes: PARITY_TRACK_BYTES, failWith: "too-long" } } : { name: LONG_TRACK, reason: "not-yet-supported" }]
                    : MIXED_MEDIA,
        ),
      holdImports: (held) => engine.holdImports(held),
      // The mock answers main's own key command itself, as the dev build does.
      musicKey: async () => {
        await engine.request(CommandMessage.parse({ v: 5, id: `msg-${String(++messages).padStart(6, "0")}`, kind: "command", type: "settings.setMusicKey", payload: { key: PARITY_MUSIC_KEY } }));
      },
      musicQuotaLog: async (state) => engine.setMusicQuotaLog(state === "deleted" ? "missing" : state),
      musicTracks: async (variant) => engine.seedMusicTracks(parityMockSeeds(parityListTracks(), variant === "decoded-apart")),
      holdText: (held) => engine.holdTextDrawing(held),
      releaseText: () => engine.releaseTextDrawing(),
      previewServed: async (previewId) => engine.mockPreviewPng(previewId) !== null,
    },
    async stop() {
      engine.holdTextDrawing(false);
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

/** An avatar's master photo as the rig seeds it: its bytes and the size its sidecar records. */
interface SeedMaster {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** The master of a rig that never draws: nothing downscales it. */
const TINY_MASTER: SeedMaster = { bytes: PNG_1X1, width: 1, height: 1 };

async function seedAvatar(library: Awaited<ReturnType<typeof openLibrary>>["library"], name: string, seed: SeedMaster = TINY_MASTER): Promise<string> {
  const avatar = await library.createAvatar({ name, age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
  const master = await library.addPhoto(avatar.id, seed.bytes, samplePhotoMeta({ width: seed.width, height: seed.height, qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  return avatar.id;
}

// ---------- the real engine's text lane ----------

const STUDIO_DIR = join(import.meta.dir, "..", "..", "..");
let captionRenderer: Promise<ReturnType<typeof createCaptionRenderer>> | null = null;

/** The REAL caption renderer (resvg-wasm, the five fonts, the emoji font) in this process, made once: the rules, the layout and the PNG are the engine's own. */
function realCaptionRenderer(): Promise<ReturnType<typeof createCaptionRenderer>> {
  captionRenderer ??= (async () => {
    const rasteriser = createTextRasteriser({ wasmPath: join(STUDIO_DIR, "..", "node_modules", "@resvg", "resvg-wasm", RASTER_WASM.file), fontDir: join(STUDIO_DIR, "assets", "fonts") });
    await rasteriser.init();
    return createCaptionRenderer({ rasteriser, emoji: openEmojiFont(await loadPinnedEmojiFont()) });
  })();
  return captionRenderer;
}

/**
 * The text worker's lane as the engine's preview service sees it (`PreviewGate`): one drawing at a time in the order asked; a call
 * still queued is dropped when its signal aborts, one that started is never aborted; `onStart` marks the start. The drawing is the real
 * renderer's. A scenario can hold a started drawing and let it go, which a real worker's timing never lets a test do.
 */
class HeldTextLane implements PreviewGate {
  #held = false;
  #running = false;
  #waiting: { start: () => void; call: object }[] = [];
  #letGo: (() => void) | null = null;

  hold(held: boolean): void {
    this.#held = held;
    if (!held) this.release();
  }

  release(): void {
    const letGo = this.#letGo;
    this.#letGo = null;
    letGo?.();
  }

  caption(request: CaptionRequest, options: CaptionCallOptions = {}): Promise<GateCaption> {
    const { signal, onStart } = options;
    if (signal?.aborted === true) return Promise.reject(signal.reason);
    return new Promise<GateCaption>((resolve, reject) => {
      const call = {};
      const finish = async (): Promise<void> => {
        try {
          const image = await (await realCaptionRenderer()).render(request);
          resolve({ ...image, workerMs: 0 });
        } catch (error) {
          reject(error);
        } finally {
          this.#running = false;
          this.#next();
        }
      };
      const start = (): void => {
        this.#running = true;
        signal?.removeEventListener("abort", onAbort);
        onStart?.();
        if (this.#held) this.#letGo = () => void finish();
        else void finish();
      };
      const onAbort = (): void => {
        const at = this.#waiting.findIndex((entry) => entry.call === call);
        if (at >= 0) this.#waiting.splice(at, 1);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (this.#running) this.#waiting.push({ start, call });
      else start();
    });
  }

  #next(): void {
    this.#waiting.shift()?.start();
  }
}

/** The real engine over a library and an export folder in `dir` (a fresh temp dir per scenario). */
export async function realRig(dir: string, options: RigOptions = {}): Promise<ParityRig> {
  const exportDir = join(dir, "export");
  await mkdir(exportDir);
  const { library } = await openLibrary(join(dir, "library"), { now: steppingClock(), newId: sequentialIds("par") });
  // S4.8: a launch's slice run downscales the master through ffmpeg as its face reference (Library.loadReference), and the Windows ffmpeg fails a 1×1 PNG
  // deterministically (studio/node/downscale.ts, PREFLIGHT_IMAGE): the run then ends INTERNAL and the launch waits in «drawing» for ever. A launching rig's
  // masters are real portraits, as the wiring tests' are (testing/wiringKit.ts).
  const master = options.launch === true ? { bytes: portraitPng(1), width: 60, height: 80 } : TINY_MASTER;
  const avatarId = await seedAvatar(library, "Mia", master);
  // S4.6r: where Mia's master lies, for the scenario that damages it (`LaunchControl.fault("job-failed")`), and the bytes to put back.
  const masterPath = library.referencePhoto(avatarId)?.path ?? null;
  let masterWhole: Buffer | null = null;
  const photoIds = await seedPhotos(library, avatarId, MAIN_PHOTOS, 1);
  const otherAvatarId = await seedAvatar(library, "Sofia", master);
  const otherPhotoIds = await seedPhotos(library, otherAvatarId, OTHER_PHOTOS, 2);
  const archivedAvatarId = await seedAvatar(library, "Nora", master);
  if (options.usage !== undefined) await breakUsage(join(dir, "library", "avatars", avatarId), avatarId, options.usage);
  if (options.categories === true) {
    await library.categories.create(PARITY_CATEGORY);
    if (options.secondCategory === true) await library.categories.create(PARITY_SECOND_CATEGORY);
    const { spentMicros: _counted, openReserveMicros: _open, ...record } = PARITY_INTERRUPTED;
    await library.categories.writePending(record);
    await writeFile(join(dir, "library", "categories", "cat-parity-broken.json"), "{not json");
  }

  if (options.sceneSets === true) {
    await library.sceneSets.create({
      sceneSetId: PARITY_SCENE_SET_ID,
      avatarId,
      runId: "run-parity-0001",
      request: { count: PARITY_SCENES.length, categories: ["home"], poses: { profile: false, back: false } },
      models: { text: "x-ai/grok-4.3" },
      scenes: PARITY_SCENES.map((scene, i) => ({
        sceneId: i + 1,
        origin: "planned" as const,
        slot: { slotIndex: i + 1, category: scene.category, ...scene.place, shot: scene.shot, pose: scene.pose, attemptIdBase: `slot-${i + 1}`, repeatedPair: false },
        text: "text" in scene ? scene.text : null,
        edited: false,
        removed: false,
      })),
      chunks: [{ chunk: 1, sceneIds: PARITY_SCENES.map((_, i) => i + 1), attemptIds: [1, 2, 3, 4].map((n) => `${PARITY_SCENE_SET_ID}:writer-1#${n}`) }],
      write: { k: 1, kind: "compose", jobId: "job-parity-0001" },
      writes: 1,
    });
    await writeFile(join(dir, "library", "avatars", avatarId, "scenes", "set-parity-broken.json"), "{not json");
  }

  if (options.reviewWrites === true) {
    const ids = (k: number) => [1, 2, 3, 4].map((n) => `${PARITY_SCENE_SET_ID}:write-${k}#${n}`);
    await library.sceneSets.create({
      sceneSetId: PARITY_SCENE_SET_ID,
      avatarId,
      runId: "run-parity-0001",
      request: { count: PARITY_REVIEW_PLANNED.length, categories: ["home"], poses: { profile: false, back: false } },
      models: { text: "x-ai/grok-4.3" },
      scenes: [
        ...PARITY_REVIEW_PLANNED.map((scene, i) => ({
          sceneId: i + 1,
          origin: "planned" as const,
          slot: { slotIndex: i + 1, category: scene.category, ...scene.place, shot: scene.shot, pose: scene.pose, attemptIdBase: `slot-${i + 1}`, repeatedPair: false },
          text: scene.text,
          edited: false,
          removed: false,
        })),
        { sceneId: PARITY_REVIEW_PLANNED.length + 1, origin: "own" as const, idea: PARITY_REVIEW_OWN.idea, shot: PARITY_REVIEW_OWN.shot, pose: PARITY_REVIEW_OWN.pose, text: PARITY_REVIEW_OWN.text, edited: false, removed: false },
      ],
      chunks: [{ chunk: 1, sceneIds: PARITY_REVIEW_PLANNED.map((_, i) => i + 1), attemptIds: [1, 2, 3, 4].map((n) => `${PARITY_SCENE_SET_ID}:writer-1#${n}`) }],
      write: null,
      reviewWrites: [
        { kind: "rewrite", k: PARITY_REVIEW_REWRITE.k, jobId: "job-parity-0002", attemptIds: ids(PARITY_REVIEW_REWRITE.k), closed: false, sceneIds: [...PARITY_REVIEW_REWRITE.sceneIds], redraw: false, slots: [], snapshots: [], stoppedBy: PARITY_REVIEW_REWRITE.stoppedBy },
        {
          kind: "idea",
          k: PARITY_REVIEW_IDEA.k,
          jobId: "job-parity-0003",
          attemptIds: ids(PARITY_REVIEW_IDEA.k),
          closed: false,
          idea: PARITY_REVIEW_IDEA.idea,
          count: PARITY_REVIEW_IDEA.count,
          shot: PARITY_REVIEW_IDEA.shot,
          scenes: PARITY_REVIEW_IDEA.sceneIds.map((sceneId) => ({ sceneId, shot: "friend" as const, pose: "front" as const })),
          stoppedBy: PARITY_REVIEW_IDEA.stoppedBy,
        },
      ],
      writes: 3,
    });
    await writeFile(join(dir, "library", "avatars", avatarId, "scenes", "set-parity-broken.json"), "{not json");
  }

  const world: World = { avatarId, photoIds, otherAvatarId, otherPhotoIds, archivedAvatarId, scored: scored(photoIds) };
  const gate = new Gate();
  /** Renders standing at the gate now: their ffmpeg held, or their commit held at its claim. */
  let parked = 0;
  const atGate = async (level: number, signal?: AbortSignal): Promise<void> => {
    parked++;
    try {
      await gate.wait(level, signal);
    } finally {
      parked--;
    }
  };
  let failArmed: "encode" | "saving" | null = null;
  // The ffmpeg that is not there: it reports progress once the gate lets it, and writes its output once the gate lets it finish.
  const run = async (opts: RunFfmpegArgvOptions): Promise<void> => {
    await atGate(1, opts.signal);
    if (failArmed === "encode") {
      failArmed = null;
      throw new FfmpegError("ffmpeg failed", 1, "boom");
    }
    // A layer file (3f.5: the first parity render with a layer) is checked against the timeline's frames; this ffmpeg is not there to count them, so it
    // reports none for it, which the runner reads as a scripted ffmpeg that said nothing. Every other call reports far more than it has, as before.
    // The clip file of an own video (3f.3b) is held to its exact frame count, and this ffmpeg cuts nothing from the stand-in mezzanine: it reports the count its graph stops at,
    // as a real one does. Every other call reports far more than it has, as before.
    if (!reportVideoClipFrames(opts) && !basename(opts.output).startsWith("layers-")) opts.onFrames?.(1_000_000);
    await atGate(2, opts.signal);
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
  // 3c.6: the music service over a real quota log, a sink that persists (so a refresh is not refused as «not available yet»)
  // and a flashapi that must never be reached: every music story of the suite is told without a request.
  const musicDir = join(dir, "userData", "music");
  // 3d.1b: the track store is the real one, over a fake CDN that serves the 3c.4 excerpts (no network). It is empty until a scenario
  // asks for `musicTracks`, so a refresh is still never reached and every older story reads what it read with the test sink.
  const cdn = fakeCdn();
  const musicClock = Date.parse("2026-09-27T20:42:00.000Z");
  // The decode proves the claimed length, or (a scenario's `decoded-apart`) a shorter one for track one. Its envelope is that
  // of the track whose staged file it reads (the staged name carries the track's id).
  let decodedApart = false;
  const store = await TrackStore.open({
    dir: musicDir,
    transport: cdn.transport,
    clock: () => musicClock + 1000,
    log: () => undefined,
    decode: (options) => {
      const index = Math.max(0, parityListTracks().findIndex((track) => options.path.includes(track.trackId)));
      const decodedMs = parityDecodedMs(index, options.expectedMs, decodedApart);
      return Promise.resolve({ decodedMs, peaks: parityPeaks(index, decodedMs) });
    },
  });
  const textLane = new HeldTextLane();
  // 3f.1b: an import job's copy waits before its first byte while the scenario holds imports (the gate is the `.part` file's creation).
  let importGate: Promise<void> | null = null;
  let letImportsGo: () => void = () => undefined;
  const holdImports = (held: boolean): void => {
    if (held) {
      if (importGate !== null) return;
      importGate = new Promise<void>((resolve) => {
        letImportsGo = () => {
          importGate = null;
          resolve();
        };
      });
    } else letImportsGo();
  };
  // The importer takes every photo, except the 1 px picture of the `tiny` pick (3f.2: the real importer refuses it as `too-small`, inside its job).
  const parityPhotoImporter: MediaImporter = async ({ name }) => (name === TINY_PHOTO ? { ok: false, reason: "too-small" } : { ok: true, facts: PARITY_PHOTO_FACTS });
  // The sticker importer (3f.5) stores a real APNG, which the render reads back; the still file of the `stillSticker` pick is refused inside the job.
  const parityStickerImporter: MediaImporter = async ({ name, workFile }) => {
    if (name === STILL_STICKER) return { ok: false, reason: "not-animated" };
    const file = await workFile();
    await writeFile(file.path, parityStickerApng(), { flag: "wx" });
    return { ok: true, facts: { ...PARITY_STICKER_FACTS, delayFrames: [...PARITY_STICKER_FACTS.delayFrames] }, output: { file, format: "apng" } };
  };
  // 3f.3a: a stand-in for the video importer: it takes a clip and refuses the one that carries the codec it does not read, after the copy. What it stores (3f.3b)
  // is an MP4 of `PARITY_VIDEO_BYTES` bytes (a stand-in for the mezzanine: the rig's ffmpeg is not there, so a render only COPIES it, verified, and the rig's
  // ffmpeg ignores it), so the record is the same size as before and a render of an own video clip can read it back.
  const parityVideoImporter: MediaImporter = async ({ staged, name, workFile, prepare }) => {
    if (Buffer.from(staged.head).toString("latin1").includes(PARITY_UNSUPPORTED_CODEC)) return { ok: false, reason: "codec" };
    // 3f.6: the `preparedVideo` pick reports its work as the real importer does (its output frames), a quarter of them at a time.
    if (name === PREPARED_VIDEO) {
      prepare?.begin(PARITY_PREPARE.total, { ...PARITY_PREPARE.judged });
      for (const done of [15, 30, 45]) prepare?.report(done);
    }
    const file = await workFile();
    await writeFile(file.path, PARITY_MEZZANINE, { flag: "wx" });
    return { ok: true, facts: PARITY_VIDEO_FACTS, output: { file, format: "mp4" } };
  };
  // 3f.4: the music importer takes every track, except the `long-track` pick (the real importer refuses a track over ten minutes as `too-long`, inside its
  // job). What it stores is an M4A (a stand-in: the rig's ffmpeg is not there, so the render's stream check and true-peak pass are scripted below).
  const parityTrackImporter: MediaImporter = async ({ name, workFile }) => {
    if (name === LONG_TRACK) return { ok: false, reason: "too-long" };
    const file = await workFile();
    await writeFile(file.path, PARITY_M4A, { flag: "wx" });
    return { ok: true, facts: PARITY_TRACK_FACTS, output: { file, format: "m4a" }, waveform: [...PARITY_TRACK_WAVEFORM] };
  };
  // S4.8: a rig with `launch` runs the engine as the app builds it (the default launch steps) over a fake OpenRouter that answers the writer, the images and the credits; a failure the
  // scenario asks for meets the next paid request, and a writer can be left without an answer (a request in flight when the app quits). Without it the engine plugs no steps (plan §21):
  // a launch only starts here, and nothing sends a request into the harness network.
  const launching = options.launch === true;
  let faultNext: "credits" | "key" | null = null;
  let writerHung = false;
  /** How far the launching engines' clock has moved on (ms): the owner was away. */
  let shifted = 0;
  const failureOf = (cause: "credits" | "key"): Reply => (cause === "credits" ? { status: 402, body: { error: { message: "Insufficient credits" } } } : { status: 401, body: { error: { message: "No auth credentials found" } } });
  const meetFault = (): Reply | null => {
    if (faultNext === null) return null;
    const reply = failureOf(faultNext);
    faultNext = null;
    return reply;
  };
  const launchNet = launching
    ? launchNetwork({
        writer: (call) => meetFault() ?? (writerHung ? new Promise<Reply>(() => undefined) : writerReply(call)),
        image: (_call, n) => meetFault() ?? imageReply(n),
      })
    : undefined;
  // Every message every engine of this rig posts, in order (the rig may start a second engine over the same folders: the app was quit and opened again).
  const posted: unknown[] = [];
  const events = (): EventMessage[] => posted.filter((m) => typeof m === "object" && m !== null && "kind" in m && m.kind === "event").map((m) => EventMessage.parse(m));
  let boots = 0;
  const boot = async (): Promise<Awaited<ReturnType<typeof startEngine>>["engine"]> => {
    boots += 1;
    const started = await startEngine(dir, {
    ...(launchNet === undefined ? {} : { net: launchNet }),
    bootId: `boot-0000-${String.fromCharCode(96 + boots).repeat(4)}`,
    init: { renderTmpDir: join(dir, "userData", "render-tmp"), settings: settings(launching ? { imageAgeCheck: "off" } : {}), musicDir },
    deps: {
      post: (message) => posted.push(message),
      // A launch's reconcile is allowed once the ledger has been quiet for a while: the rig moves the clock when the owner is away (`quit`).
      ...(launching ? { clock: () => NOW + shifted, monotonic: () => shifted } : {}),
      musicSink: store,
      musicTracks: store,
      ...(launching
        ? { musicTrends: store, qaGates: [{ name: "face", paid: false, check: async () => ({ verdict: "pass" as const }) }] }
        : { launchSteps: IDLE_STEPS }),
      text: { gate: textLane },
      ...(options.ownMedia === true ? { mediaImporters: { photo: parityPhotoImporter, video: parityVideoImporter, audio: parityTrackImporter, sticker: parityStickerImporter } } : {}),
      mediaStaging: {
        fs: {
          openOut: async (path) => {
            if (importGate !== null) await importGate;
            return open(path, "wx");
          },
        },
      },
      musicFetch: () => Promise.reject(new Error("the parity suite never sends a flashapi request")),
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
          // An own track's private copy is a stand-in, not audio ffmpeg could read: its stream check and true-peak pass are scripted (a quiet track, no gain).
          runDeps: { run, measure: async () => -5.7 },
          inspectStreams: async () => ["Audio"],
          // The commit stops at its claim, past the saving announcement, until the gate is open; a commit that cannot write fails there.
          hooks: {
            reached: async (step) => {
              if (step !== "name-claimed") return;
              await atGate(3);
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
    await started.engine.settled();
    return started.engine;
  };
  let engine = await boot();
  // Nora is retired: the engine's own command, so the library's state is the engine's.
  const archived = ResponseMessage.parse(await engine.handle(command("avatars.archive", { avatarId: archivedAvatarId })));
  if (!archived.ok) throw new Error(`could not archive the third avatar: ${archived.error.code}`);
  // A launch's renders flow on their own: the gate is open for good.
  if (launching) gate.set(3);

  const settle = async (): Promise<void> => {
    gate.set(3);
    await engine.renders.idle();
    await engine.settled();
    await engine.mediaSettled();
    if (!launching) gate.reset();
  };

  // The app quit and opened again (S4.8): the first engine shuts down (a request in flight dies with it; its reserve stays open in the ledger), a second one opens the same folders.
  const quitAndReopen = async (): Promise<void> => {
    await within(engine.shutdown(50), 30_000, "the engine to shut down");
    writerHung = false;
    engine = await within(boot(), 60_000, "the engine to start again");
    // The owner waits some minutes before the reconcile: it needs the new process to have been quiet for a while (the crash matrix moves its clock the same way).
    shifted += 10 * 60_000;
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
  // Main's half of the settings commands it owns (`settings.setModels`, `settings.setCameraRealism`): the real flow (main/settingsFlow.ts) over
  // the real engine and the same settings file. The engine answers `settings.imageModels` itself (offline here: its bundled list).
  const settingsDeps: SettingsFlowDeps = {
    settings: mainSettings,
    engine: {
      send: (control) => void told.push(engine.applyControl(control)),
      request: (asked) => engine.handle(asked),
      openLibrary: async () => ({ code: "INTERNAL", detail: "the parity rig never switches the library" }),
      confirmLibrary: async () => ({ code: "INTERNAL", detail: "the parity rig never switches the library" }),
    },
    pickFolder: async () => null,
    keyStatus: () => ({ stored: true, last4: "wxyz", encryptionAvailable: true, rejected: false }),
    musicKeyStatus: () => ({ stored: false, last4: null, rejected: false }),
    newId: () => `host-${String(++hostCalls).padStart(8, "0")}`,
  };
  // Main's half of `media.pickImport` (3f.1): the real flow (main/mediaImportFlow.ts) over the real engine, with the dialog answered by the
  // rig and the engine's staging area inside the rig's library. No importer is wired, as in the app until 3f.2, so a good file is refused.
  let nextMedia: string[] | null = null;
  const mediaDeps: MediaImportFlowDeps = {
    pickFiles: async () => {
      const pick = nextMedia;
      nextMedia = null;
      return pick;
    },
    engine: {
      importMedia: async (file) => {
        const callId = `call-${String(++hostCalls).padStart(8, "0")}`;
        await engine.receive({ kind: "control", type: "media.import", callId, ...file });
        const reply = posted.map((m) => EngineReply.safeParse(m)).find((r) => r.success && r.data.callId === callId);
        if (reply === undefined || !reply.success) throw new Error("the engine did not answer media.import");
        return { error: reply.data.error ?? null, mediaJobId: reply.data.mediaJobId, mediaReason: reply.data.mediaReason };
      },
    },
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
      if (type === "settings.setModels" || type === "settings.setCameraRealism") {
        const asked = CommandMessage.safeParse({ v: 5, id: `msg-${String(++hostCalls).padStart(6, "0")}`, kind: "command", type, payload });
        if (!asked.success || !isSettingsCommand(asked.data)) return { ok: false, error: { code: "VALIDATION", detail: `${type}: the payload breaks the contract` } };
        const response = await handleSettingsCommand(asked.data, settingsDeps);
        await Promise.all(told.splice(0));
        return answerOf(ResponseMessage.parse(response));
      }
      if (type === "media.pickImport") {
        const asked = CommandMessage.safeParse({ v: 5, id: `msg-${String(++hostCalls).padStart(6, "0")}`, kind: "command", type, payload });
        if (!asked.success || !isMediaPickCommand(asked.data)) return { ok: false, error: { code: "VALIDATION", detail: `${type}: the payload breaks the contract` } };
        return answerOf(ResponseMessage.parse(await handleMediaPickCommand(asked.data, mediaDeps)));
      }
      // A cancel lands only on renders held at the gate, as the mock's renders are between its steps. A render still in its
      // export-folder prep (\`guarded\`) ends on the abort through promises alone, before the answer is back and before
      // \`advance("end")\` takes its starting point: its end would be missed (a timeout) or written early (a diff).
      if (type === "videos.cancel") {
        const running = (): number => engine.renders.states().filter((s) => s.status === "running").length;
        await until(() => parked >= running(), "every running render at the gate", 10_000);
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
    async pump() {
      await new Promise<void>((resolve) => setTimeout(resolve, 15));
    },
    // What a launch that did not move leaves behind: every job's end as the windows heard it (a failed run says its error), the jobs the engine holds, the
    // requests the fake OpenRouter was asked, and the last lines of each run journal. Read only when a story gives up waiting.
    async diagnose() {
      const lines: string[] = [`platform ${process.platform}, boots ${boots}, clock moved ${shifted} ms`];
      for (const message of posted) {
        if (typeof message !== "object" || message === null || !("type" in message) || typeof message.type !== "string") continue;
        if (/^job\.(failed|cancelled|done)$/.test(message.type)) lines.push(`event ${JSON.stringify(message).slice(0, 700)}`);
      }
      const snapshot = ResponseMessage.parse(await engine.handle(command("engine.snapshot", {})));
      lines.push(`jobs ${snapshot.ok && "jobs" in snapshot.result ? JSON.stringify(snapshot.result.jobs).slice(0, 1500) : "no snapshot"}`);
      if (launchNet !== undefined) {
        const counts = new Map<string, number>();
        for (const call of launchNet.calls) counts.set(`${call.method} ${call.url}`, (counts.get(`${call.method} ${call.url}`) ?? 0) + 1);
        lines.push(`network ${JSON.stringify([...counts])}`);
      }
      const library = join(dir, "library");
      const files = await readdir(library, { recursive: true }).catch(() => []);
      for (const file of files.filter((f) => f.endsWith("journal.jsonl"))) {
        const text = await readFile(join(library, file), "utf8").catch((error: unknown) => `unreadable (${error instanceof Error ? error.message : String(error)})`);
        lines.push(`journal ${file}: ${text.split("\n").filter((l) => l !== "").slice(-10).map((l) => l.slice(0, 500)).join(" | ")}`);
      }
      return lines.join("\n");
    },
    control: {
      launch: {
        fault: (cause) => {
          if (!launching) throw new Error("this rig has no launch");
          if (cause !== "job-failed") {
            faultNext = cause;
            return;
          }
          // Damaged on disk, same length: the library reads it and finds that its sha256 is not the sidecar's. The slice's run ends INTERNAL before any image is requested.
          if (masterPath === null) throw new Error("the rig has no master photo to damage");
          const whole = readFileSync(masterPath);
          masterWhole ??= whole;
          const damaged = Buffer.from(whole);
          damaged[damaged.length - 1] = (damaged[damaged.length - 1] ?? 0) ^ 0xff;
          writeFileSync(masterPath, damaged);
        },
        repairMaster: async () => {
          if (masterPath === null || masterWhole === null) return;
          await writeFile(masterPath, masterWhole);
          masterWhole = null;
        },
        newKey: async () => {
          await within(engine.applyControl({ kind: "control", type: "apiKey.set", key: PARITY_OPENROUTER_KEY }), 30_000, "the new key to be stored");
        },
        hangWriter: () => {
          writerHung = true;
        },
        quit: quitAndReopen,
      },
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
      mediaDialog: async (answer) => {
        const folder = join(dir, `picked-media-${++dialogs}`);
        nextMedia =
          answer === "cancel"
            ? null
            : answer === "good"
              ? await writeGoodMedia(folder)
              : answer === "tiny"
                ? await writeTinyMedia(folder)
                : answer === "sticker" || answer === "stillSticker"
                  ? await writeStickerMedia(folder, answer === "stillSticker")
                : answer === "video" || answer === "badVideo" || answer === "preparedVideo"
                  ? await writeVideoMedia(folder, answer === "badVideo" ? "bad" : answer === "preparedVideo" ? "prepared" : "good")
                : answer === "track"
                  ? await writeGoodTrack(folder)
                  : answer === "long-track"
                    ? await writeLongTrack(folder)
                    : await writeMixedMedia(folder);
      },
      holdImports,
      // Main's half of «Сохранить»: the key is stored, then handed to the engine as the owner's (a key line in the quota log).
      musicKey: () => engine.applyControl({ kind: "control", type: "musicKey.set", key: PARITY_MUSIC_KEY, origin: "user" }),
      musicTracks: async (variant) => {
        decodedApart = variant === "decoded-apart";
        const tracks = parityListTracks();
        tracks.forEach((track, i) => {
          cdn.serve(track.downloadUrl, { bytes: excerptOf(i) });
          if (track.coverUrl !== null) cdn.serve(track.coverUrl, { bytes: JPEG_1X1 });
        });
        await store.accept({ fetchedAt: musicClock, tracks }, () => undefined, new AbortController().signal);
      },
      holdText: (held) => textLane.hold(held),
      releaseText: () => textLane.release(),
      previewServed: async (previewId) =>
        stat(join(dir, "userData", "render-tmp", "text", `${previewId}.png`)).then(
          (info) => info.isFile(),
          () => false,
        ),
      musicQuotaLog: async (state) => {
        const log = join(musicDir, "quota.jsonl");
        // Review round 1: the owner deletes the whole music folder; the marker beside it, in userData, stays.
        if (state === "deleted") {
          await rm(musicDir, { recursive: true, force: true });
          return;
        }
        await mkdir(musicDir, { recursive: true });
        if (state === "corrupt") await appendFile(log, "not json at all\n");
        else {
          await rm(log, { force: true });
          await mkdir(log);
        }
      },
    },
    stop: async () => {
      textLane.hold(false);
      holdImports(false);
      // A launch's free runs poll on timers: the engine is shut down so none outlives the scenario.
      if (launching) await within(engine.shutdown(50), 30_000, "the engine to shut down");
      else await settle();
    },
  };
}
