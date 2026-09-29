import { describe, expect, test } from "bun:test";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MontageDraft } from "../../shared/engine/montage";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import type { FaceDetection } from "../face/worker/workerGate";
import { LibraryError } from "../library/errors";
import { openLibrary, type Library } from "../library/library";
import { JPEG_HEADER_ONLY, SAMPLE_AVATAR, samplePhotoMeta, sequentialIds, steppingClock, useTempDir } from "../library/testing/helpers";
import { FOCUS_FILE, FOCUS_METHOD } from "./focusCache";
import { createFocusResolver, type FocusFaceGate } from "./focusResolver";
useNativeGlobals();

// S8: the focus point of a placed photo. The face gate is a scripted fake here
// (the real YuNet on the real fixtures is pinned in workerGate.real.test.ts);
// the library is a real one on a temp folder, so the cache file lives where it
// really would and the library's own survey sees it.

const FALLBACK = { x: 0.5, y: 0.38 };
const root = useTempDir("studio-focus-");

/** Distinct bytes per photo (a JPEG header plus a marker byte), so each has its own sha256. */
const photoBytes = (marker: number): Uint8Array => Uint8Array.from([...JPEG_HEADER_ONLY, marker]);

interface FakeGate extends FocusFaceGate {
  readonly calls: Uint8Array[];
  broken: boolean;
}

type Script = (bytes: Uint8Array) => FaceDetection | Error | "hang";

/** A detection of a 1000x2000 image with a face box centred at (300, 800), i.e. focus (0.3, 0.4). */
const FACE: FaceDetection = { width: 1000, height: 2000, face: { x: 200, y: 600, width: 200, height: 400 } };
const NO_FACE: FaceDetection = { width: 1000, height: 2000, face: null };

function fakeGate(script: Script = () => FACE): FakeGate {
  const gate: FakeGate = {
    calls: [],
    broken: false,
    isBroken: () => gate.broken,
    detect: (bytes, signal) => {
      gate.calls.push(bytes);
      const outcome = script(bytes);
      if (outcome === "hang") {
        return new Promise<FaceDetection>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
    },
  };
  return gate;
}

interface Fixture {
  library: Library;
  avatarId: string;
  photoIds: string[];
  focusPath: string;
  photoPath: (photoId: string) => string;
}

async function fixture(photos = 1): Promise<Fixture> {
  const { library } = await openLibrary(root(), { now: steppingClock(), newId: sequentialIds() });
  const avatar = await library.createAvatar(SAMPLE_AVATAR);
  const photoIds: string[] = [];
  for (let i = 0; i < photos; i++) {
    const photo = await library.addPhoto(avatar.id, photoBytes(i), samplePhotoMeta({ mediaType: "image/jpeg" }));
    photoIds.push(photo.id);
  }
  const avatarDir = join(root(), "avatars", avatar.id);
  return { library, avatarId: avatar.id, photoIds, focusPath: join(avatarDir, FOCUS_FILE), photoPath: (id) => join(avatarDir, "photos", `${id}.jpg`) };
}

const only = <T>(items: readonly T[]): T => {
  const [first] = items;
  if (first === undefined) throw new Error("expected one item");
  return first;
};

describe("focusFor: a face, or the fallback", () => {
  test("returns the centre of the largest face as fractions of the source image", async () => {
    const f = await fixture();
    const { focusFor } = createFocusResolver({ library: f.library, faceGate: fakeGate() });
    expect(await focusFor(f.avatarId, only(f.photoIds))).toEqual({ x: 0.3, y: 0.4 });
  });

  test("returns the (0.5, 0.38) fallback, not an error, when the photo has no face", async () => {
    const f = await fixture();
    const { focusFor } = createFocusResolver({ library: f.library, faceGate: fakeGate(() => NO_FACE) });
    expect(await focusFor(f.avatarId, only(f.photoIds))).toEqual(FALLBACK);
  });

  test("clamps a face box that reaches past the image edge into 0..1", async () => {
    const f = await fixture();
    const overhang: FaceDetection = { width: 1000, height: 1000, face: { x: 900, y: -400, width: 400, height: 300 } };
    const { focusFor } = createFocusResolver({ library: f.library, faceGate: fakeGate(() => overhang) });
    expect(await focusFor(f.avatarId, only(f.photoIds))).toEqual({ x: 1, y: 0 });
  });

  test("hands the photo's own bytes to the detector", async () => {
    const f = await fixture(2);
    const gate = fakeGate();
    const { focusFor } = createFocusResolver({ library: f.library, faceGate: gate });
    await focusFor(f.avatarId, f.photoIds[1] ?? "");
    expect(Array.from(only(gate.calls))).toEqual(Array.from(photoBytes(1)));
  });
});

describe("focusFor: the face gate is unavailable", () => {
  test("falls back when there is no gate at all (the models failed to load)", async () => {
    const f = await fixture();
    const { focusFor } = createFocusResolver({ library: f.library, faceGate: null });
    expect(await focusFor(f.avatarId, only(f.photoIds))).toEqual(FALLBACK);
  });

  test("falls back without asking a broken gate to detect", async () => {
    const f = await fixture();
    const gate = fakeGate();
    gate.broken = true;
    const { focusFor } = createFocusResolver({ library: f.library, faceGate: gate });
    expect(await focusFor(f.avatarId, only(f.photoIds))).toEqual(FALLBACK);
    expect(gate.calls).toHaveLength(0);
  });

  test("falls back when the detection fails, and does not remember that: the next call tries again", async () => {
    const f = await fixture();
    let fail = true;
    const gate = fakeGate(() => (fail ? new Error("the worker died") : FACE));
    const { focusFor } = createFocusResolver({ library: f.library, faceGate: gate });
    expect(await focusFor(f.avatarId, only(f.photoIds))).toEqual(FALLBACK);
    fail = false;
    expect(await focusFor(f.avatarId, only(f.photoIds))).toEqual({ x: 0.3, y: 0.4 });
  });

  test("a failed detection leaves no cache file behind", async () => {
    const f = await fixture();
    const { focusFor } = createFocusResolver({ library: f.library, faceGate: fakeGate(() => new Error("boom")) });
    await focusFor(f.avatarId, only(f.photoIds));
    expect(await readdir(join(root(), "avatars", f.avatarId))).not.toContain(FOCUS_FILE);
  });

  test("gives up on a detection that never returns after the bound, with the fallback, and does not remember it", async () => {
    const f = await fixture();
    let hang = true;
    const gate = fakeGate(() => (hang ? "hang" : FACE));
    const { focusFor } = createFocusResolver({ library: f.library, faceGate: gate, detectTimeoutMs: 30 });
    const started = performance.now();
    expect(await focusFor(f.avatarId, only(f.photoIds))).toEqual(FALLBACK);
    expect(performance.now() - started).toBeLessThan(1_000);
    hang = false;
    expect(await focusFor(f.avatarId, only(f.photoIds))).toEqual({ x: 0.3, y: 0.4 });
  });

  test("falls back, without detecting, when the photo file no longer matches its sidecar", async () => {
    const f = await fixture();
    await writeFile(f.photoPath(only(f.photoIds)), photoBytes(99));
    const gate = fakeGate();
    const { focusFor } = createFocusResolver({ library: f.library, faceGate: gate });
    expect(await focusFor(f.avatarId, only(f.photoIds))).toEqual(FALLBACK);
    expect(gate.calls).toHaveLength(0);
  });

  test("falls back when the photo file is gone", async () => {
    const f = await fixture();
    await rm(f.photoPath(only(f.photoIds)));
    const { focusFor } = createFocusResolver({ library: f.library, faceGate: fakeGate() });
    expect(await focusFor(f.avatarId, only(f.photoIds))).toEqual(FALLBACK);
  });
});

describe("focusFor: the caller is wrong or gives up", () => {
  test("refuses a photo that does not exist", async () => {
    const f = await fixture();
    const { focusFor } = createFocusResolver({ library: f.library, faceGate: fakeGate() });
    const error = await focusFor(f.avatarId, "no-such-photo").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(LibraryError);
    expect(error).toMatchObject({ code: "photo-not-found" });
  });

  test("refuses a photo that belongs to another avatar", async () => {
    const f = await fixture();
    const other = await f.library.createAvatar(SAMPLE_AVATAR);
    const { focusFor } = createFocusResolver({ library: f.library, faceGate: fakeGate() });
    await expect(focusFor(other.id, only(f.photoIds))).rejects.toMatchObject({ code: "photo-not-found" });
  });

  test("rejects with the abort reason, without detecting, when the signal is already aborted", async () => {
    const f = await fixture();
    const gate = fakeGate();
    const { focusFor } = createFocusResolver({ library: f.library, faceGate: gate });
    const controller = new AbortController();
    controller.abort(new Error("owner left"));
    await expect(focusFor(f.avatarId, only(f.photoIds), controller.signal)).rejects.toThrow("owner left");
    expect(gate.calls).toHaveLength(0);
  });

  test("rejects with the abort reason as soon as the signal fires mid-detection", async () => {
    const f = await fixture();
    const { focusFor } = createFocusResolver({ library: f.library, faceGate: fakeGate(() => "hang"), detectTimeoutMs: 5_000 });
    const controller = new AbortController();
    const running = focusFor(f.avatarId, only(f.photoIds), controller.signal).then(
      () => "resolved",
      (e: unknown) => (e instanceof Error ? e.message : "not an error"),
    );
    await Bun.sleep(20);
    controller.abort(new Error("owner left"));
    expect(await running).toBe("owner left");
  });

  test("one caller giving up does not stop the detection another caller is waiting on", async () => {
    const f = await fixture();
    let release: (value: FaceDetection) => void = () => {};
    const gate = fakeGate();
    gate.detect = (bytes) => {
      gate.calls.push(bytes);
      return new Promise<FaceDetection>((resolve) => {
        release = resolve;
      });
    };
    const { focusFor } = createFocusResolver({ library: f.library, faceGate: gate });
    const impatient = new AbortController();
    const first = focusFor(f.avatarId, only(f.photoIds), impatient.signal).catch(() => "gave up");
    const second = focusFor(f.avatarId, only(f.photoIds));
    await Bun.sleep(20);
    impatient.abort(new Error("enough"));
    expect(await first).toBe("gave up");
    release(FACE);
    expect(await second).toEqual({ x: 0.3, y: 0.4 });
    expect(gate.calls).toHaveLength(1);
  });
});

describe("focusFor: the cache", () => {
  test("detects a photo once: a second call is answered from memory", async () => {
    const f = await fixture();
    const gate = fakeGate();
    const { focusFor } = createFocusResolver({ library: f.library, faceGate: gate });
    await focusFor(f.avatarId, only(f.photoIds));
    await focusFor(f.avatarId, only(f.photoIds));
    expect(gate.calls).toHaveLength(1);
  });

  test("concurrent calls for one photo share a single detection", async () => {
    const f = await fixture();
    const gate = fakeGate();
    const { focusFor } = createFocusResolver({ library: f.library, faceGate: gate });
    const results = await Promise.all([focusFor(f.avatarId, only(f.photoIds)), focusFor(f.avatarId, only(f.photoIds)), focusFor(f.avatarId, only(f.photoIds))]);
    expect(results).toEqual([{ x: 0.3, y: 0.4 }, { x: 0.3, y: 0.4 }, { x: 0.3, y: 0.4 }]);
    expect(gate.calls).toHaveLength(1);
  });

  test("survives a restart: a new resolver reads the persisted answer and never detects", async () => {
    const f = await fixture();
    await createFocusResolver({ library: f.library, faceGate: fakeGate() }).focusFor(f.avatarId, only(f.photoIds));
    const gate = fakeGate();
    const restarted = createFocusResolver({ library: f.library, faceGate: gate });
    expect(await restarted.focusFor(f.avatarId, only(f.photoIds))).toEqual({ x: 0.3, y: 0.4 });
    expect(gate.calls).toHaveLength(0);
  });

  test("remembers 'no face' across a restart too, and still answers with the fallback", async () => {
    const f = await fixture();
    await createFocusResolver({ library: f.library, faceGate: fakeGate(() => NO_FACE) }).focusFor(f.avatarId, only(f.photoIds));
    const gate = fakeGate();
    expect(await createFocusResolver({ library: f.library, faceGate: gate }).focusFor(f.avatarId, only(f.photoIds))).toEqual(FALLBACK);
    expect(gate.calls).toHaveLength(0);
  });

  test("a persisted answer is served even when the gate is unavailable", async () => {
    const f = await fixture();
    await createFocusResolver({ library: f.library, faceGate: fakeGate() }).focusFor(f.avatarId, only(f.photoIds));
    expect(await createFocusResolver({ library: f.library, faceGate: null }).focusFor(f.avatarId, only(f.photoIds))).toEqual({ x: 0.3, y: 0.4 });
  });

  test("recomputes when the cache file is not JSON, and rewrites it", async () => {
    const f = await fixture();
    await writeFile(f.focusPath, "{ this is not json");
    const gate = fakeGate();
    expect(await createFocusResolver({ library: f.library, faceGate: gate }).focusFor(f.avatarId, only(f.photoIds))).toEqual({ x: 0.3, y: 0.4 });
    expect(gate.calls).toHaveLength(1);
    expect(JSON.parse(await readFile(f.focusPath, "utf8"))).toMatchObject({ schemaVersion: 1, method: FOCUS_METHOD });
  });

  test("recomputes when the cache file is valid JSON of the wrong shape", async () => {
    const f = await fixture();
    await writeFile(f.focusPath, JSON.stringify({ schemaVersion: 1, method: FOCUS_METHOD, photos: { [only(f.photoIds)]: { sha256: "abc", focus: { x: 7, y: "up" } } } }));
    const gate = fakeGate();
    expect(await createFocusResolver({ library: f.library, faceGate: gate }).focusFor(f.avatarId, only(f.photoIds))).toEqual({ x: 0.3, y: 0.4 });
    expect(gate.calls).toHaveLength(1);
  });

  test("recomputes when the entry was made for other bytes (the photo's sha256 changed)", async () => {
    const f = await fixture();
    const photoId = only(f.photoIds);
    await createFocusResolver({ library: f.library, faceGate: fakeGate(() => NO_FACE) }).focusFor(f.avatarId, photoId);
    const cache = JSON.parse(await readFile(f.focusPath, "utf8"));
    cache.photos[photoId].sha256 = "0".repeat(64);
    await writeFile(f.focusPath, JSON.stringify(cache));
    const gate = fakeGate();
    expect(await createFocusResolver({ library: f.library, faceGate: gate }).focusFor(f.avatarId, photoId)).toEqual({ x: 0.3, y: 0.4 });
    expect(gate.calls).toHaveLength(1);
  });

  test("recomputes when the cache was made by another focus method", async () => {
    const f = await fixture();
    const photoId = only(f.photoIds);
    await createFocusResolver({ library: f.library, faceGate: fakeGate(() => NO_FACE) }).focusFor(f.avatarId, photoId);
    const cache = JSON.parse(await readFile(f.focusPath, "utf8"));
    cache.method = "eyes-line-v0";
    await writeFile(f.focusPath, JSON.stringify(cache));
    const gate = fakeGate();
    await createFocusResolver({ library: f.library, faceGate: gate }).focusFor(f.avatarId, photoId);
    expect(gate.calls).toHaveLength(1);
  });

  test("keeps the entries of the avatar's other photos when it adds one", async () => {
    const f = await fixture(2);
    const { focusFor } = createFocusResolver({ library: f.library, faceGate: fakeGate() });
    await focusFor(f.avatarId, f.photoIds[0] ?? "");
    await focusFor(f.avatarId, f.photoIds[1] ?? "");
    expect(Object.keys(JSON.parse(await readFile(f.focusPath, "utf8")).photos).sort()).toEqual([...f.photoIds].sort());
  });

  test("drops the entry of a photo that has been deleted when it next writes", async () => {
    const f = await fixture(2);
    const { focusFor } = createFocusResolver({ library: f.library, faceGate: fakeGate() });
    await focusFor(f.avatarId, f.photoIds[0] ?? "");
    await f.library.deletePhoto(f.avatarId, f.photoIds[0] ?? "");
    await focusFor(f.avatarId, f.photoIds[1] ?? "");
    expect(Object.keys(JSON.parse(await readFile(f.focusPath, "utf8")).photos)).toEqual([f.photoIds[1] ?? ""]);
  });

  test("leaves no temp file behind after writing", async () => {
    const f = await fixture();
    await createFocusResolver({ library: f.library, faceGate: fakeGate() }).focusFor(f.avatarId, only(f.photoIds));
    expect((await readdir(join(root(), "avatars", f.avatarId))).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  test("the library's own survey leaves the cache file alone when it reopens", async () => {
    const f = await fixture();
    await createFocusResolver({ library: f.library, faceGate: fakeGate() }).focusFor(f.avatarId, only(f.photoIds));
    const { report } = await openLibrary(root(), { now: steppingClock(), newId: sequentialIds("other") });
    expect(report.quarantined).toEqual([]);
    expect(await readdir(join(root(), "avatars", f.avatarId))).toContain(FOCUS_FILE);
  });

  test("still answers when the cache cannot be written (the avatar folder is read-only or gone)", async () => {
    const f = await fixture();
    await mkdir(f.focusPath); // a directory where the file should go: the atomic rename fails
    const { focusFor } = createFocusResolver({ library: f.library, faceGate: fakeGate() });
    expect(await focusFor(f.avatarId, only(f.photoIds))).toEqual({ x: 0.3, y: 0.4 });
  });
});

// ---- fillMissingFocus ----------------------------------------------------------

const scene = (photoId: string) => ({ source: "scene" as const, photoId });

function specOf(avatarId: string, clips: MontageDraft["clips"]): MontageDraft {
  return { schemaVersion: 1, avatarId, layers: [], music: null, seed: 1, clips };
}

const base = (n: number) => ({ clipId: `clip-00${n}`, durationMs: 2_000, transitionIn: "cut" as const });

describe("fillMissingFocus", () => {
  test("resolves the null focus of a photo cell from its photo", async () => {
    const f = await fixture();
    const { fillMissingFocus } = createFocusResolver({ library: f.library, faceGate: fakeGate() });
    const filled = await fillMissingFocus(specOf(f.avatarId, [{ ...base(1), kind: "photo", motion: "kenburns", cell: { photo: scene(only(f.photoIds)), focus: null } }]));
    expect(only(filled.clips)).toMatchObject({ kind: "photo", cell: { focus: { x: 0.3, y: 0.4 } } });
  });

  test("resolves every null cell of a collage, each from its own photo", async () => {
    const f = await fixture(2);
    const byMarker: Script = (bytes) => (bytes[bytes.length - 1] === 0 ? FACE : NO_FACE);
    const { fillMissingFocus } = createFocusResolver({ library: f.library, faceGate: fakeGate(byMarker) });
    const [a = "", b = ""] = f.photoIds;
    const filled = await fillMissingFocus(
      specOf(f.avatarId, [
        {
          ...base(1),
          kind: "collage",
          layout: "collage2",
          motion: "static",
          stagger: false,
          cells: [
            { photo: scene(a), focus: null },
            { photo: scene(b), focus: null },
          ],
        },
      ]),
    );
    const clip = only(filled.clips);
    expect(clip.kind === "collage" ? clip.cells.map((c) => c.focus) : []).toEqual([{ x: 0.3, y: 0.4 }, FALLBACK]);
  });

  test("leaves a focus that is already set exactly as it is, and never detects for it", async () => {
    const f = await fixture();
    const gate = fakeGate();
    const { fillMissingFocus } = createFocusResolver({ library: f.library, faceGate: gate });
    const spec = specOf(f.avatarId, [{ ...base(1), kind: "photo", motion: "kenburns", cell: { photo: scene(only(f.photoIds)), focus: { x: 0.9, y: 0.1 } } }]);
    const filled = await fillMissingFocus(spec);
    expect(only(filled.clips)).toMatchObject({ cell: { focus: { x: 0.9, y: 0.1 } } });
    expect(gate.calls).toHaveLength(0);
  });

  test("keeps a focus of zero (a real value, not a missing one)", async () => {
    const f = await fixture();
    const { fillMissingFocus } = createFocusResolver({ library: f.library, faceGate: fakeGate() });
    const filled = await fillMissingFocus(specOf(f.avatarId, [{ ...base(1), kind: "photo", motion: "kenburns", cell: { photo: scene(only(f.photoIds)), focus: { x: 0, y: 0 } } }]));
    expect(only(filled.clips)).toMatchObject({ cell: { focus: { x: 0, y: 0 } } });
  });

  test("gives the fallback to a cell with no photo, an own-media cell and a video clip", async () => {
    const f = await fixture();
    const gate = fakeGate();
    const { fillMissingFocus } = createFocusResolver({ library: f.library, faceGate: gate });
    const filled = await fillMissingFocus(
      specOf(f.avatarId, [
        { ...base(1), kind: "photo", motion: "static", cell: { photo: null, focus: null } },
        { ...base(2), kind: "photo", motion: "static", cell: { photo: { source: "own", mediaId: "media-0001" }, focus: null } },
        { ...base(3), kind: "video", mediaId: "media-0002", trimStartMs: 0, focus: null },
      ]),
    );
    expect(filled.clips.map((c) => (c.kind === "photo" ? c.cell.focus : c.kind === "video" ? c.focus : null))).toEqual([FALLBACK, FALLBACK, FALLBACK]);
    expect(gate.calls).toHaveLength(0);
  });

  test("falls back for every null cell when the gate is unavailable, and does not fail", async () => {
    const f = await fixture();
    const { fillMissingFocus } = createFocusResolver({ library: f.library, faceGate: null });
    const filled = await fillMissingFocus(specOf(f.avatarId, [{ ...base(1), kind: "photo", motion: "kenburns", cell: { photo: scene(only(f.photoIds)), focus: null } }]));
    expect(only(filled.clips)).toMatchObject({ cell: { focus: FALLBACK } });
  });

  test("does not modify the spec it was given", async () => {
    const f = await fixture();
    const { fillMissingFocus } = createFocusResolver({ library: f.library, faceGate: fakeGate() });
    const spec = specOf(f.avatarId, [{ ...base(1), kind: "photo", motion: "kenburns", cell: { photo: scene(only(f.photoIds)), focus: null } }]);
    const before = structuredClone(spec);
    await fillMissingFocus(spec);
    expect(spec).toEqual(before);
  });

  test("changes nothing but the focus values", async () => {
    const f = await fixture();
    const { fillMissingFocus } = createFocusResolver({ library: f.library, faceGate: fakeGate() });
    const spec = specOf(f.avatarId, [{ ...base(1), kind: "photo", motion: "pan", cell: { photo: scene(only(f.photoIds)), focus: null } }]);
    const filled = await fillMissingFocus(spec);
    expect({ ...filled, clips: [] }).toEqual({ ...spec, clips: [] });
    expect(only(filled.clips)).toMatchObject({ clipId: "clip-001", durationMs: 2_000, motion: "pan", cell: { photo: scene(only(f.photoIds)) } });
  });

  test("returns an empty draft as it is", async () => {
    const f = await fixture();
    const { fillMissingFocus } = createFocusResolver({ library: f.library, faceGate: fakeGate() });
    expect((await fillMissingFocus(specOf(f.avatarId, []))).clips).toEqual([]);
  });

  test("uses the fallback for the rest once its time budget is spent, instead of failing", async () => {
    const f = await fixture(2);
    const slow = fakeGate();
    slow.detect = async (bytes) => {
      slow.calls.push(bytes);
      await Bun.sleep(60); // longer than the whole budget
      return FACE;
    };
    const { fillMissingFocus } = createFocusResolver({ library: f.library, faceGate: slow, fillBudgetMs: 20 });
    const [a = "", b = ""] = f.photoIds;
    const filled = await fillMissingFocus(
      specOf(f.avatarId, [
        { ...base(1), kind: "photo", motion: "static", cell: { photo: scene(a), focus: null } },
        { ...base(2), kind: "photo", motion: "static", cell: { photo: scene(b), focus: null } },
      ]),
    );
    expect(filled.clips.map((c) => (c.kind === "photo" ? c.cell.focus : null))).toEqual([{ x: 0.3, y: 0.4 }, FALLBACK]);
    expect(slow.calls).toHaveLength(1);
  });

  test("rejects with the abort reason when the signal is aborted", async () => {
    const f = await fixture();
    const { fillMissingFocus } = createFocusResolver({ library: f.library, faceGate: fakeGate() });
    const controller = new AbortController();
    controller.abort(new Error("job cancelled"));
    await expect(fillMissingFocus(specOf(f.avatarId, [{ ...base(1), kind: "photo", motion: "static", cell: { photo: scene(only(f.photoIds)), focus: null } }]), controller.signal)).rejects.toThrow("job cancelled");
  });

  test("refuses a spec that names a photo the avatar does not have", async () => {
    const f = await fixture();
    const { fillMissingFocus } = createFocusResolver({ library: f.library, faceGate: fakeGate() });
    await expect(fillMissingFocus(specOf(f.avatarId, [{ ...base(1), kind: "photo", motion: "static", cell: { photo: scene("no-such-photo"), focus: null } }]))).rejects.toMatchObject({ code: "photo-not-found" });
  });
});
