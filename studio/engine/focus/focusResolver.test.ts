import { describe, expect, test } from "bun:test";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MontageDraft } from "../../shared/engine/montage";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { FaceLaneFullError, type FaceDetection } from "../face/worker/workerGate";
import { LibraryError } from "../library/errors";
import { FOCUS_FILE } from "../library/layout";
import { openLibrary, type Library } from "../library/library";
import { JPEG_HEADER_ONLY, SAMPLE_AVATAR, samplePhotoMeta, sequentialIds, steppingClock, useTempDir } from "../library/testing/helpers";
import { FOCUS_METHOD, readFocusCache, rememberFocus } from "./focusCache";
import { createFocusResolver, type FocusFaceGate, type FocusLibrary } from "./focusResolver";
useNativeGlobals();

// S8: the focus point of a placed photo. The face gate is a scripted fake here
// (the real YuNet on the real fixtures is pinned in face/testing/workerGate.real.node-test.ts);
// the library is a real one on a temp folder, so the cache file lives where it
// really would and the library's own survey sees it.

const FALLBACK = { x: 0.5, y: 0.38 };
const FACE_FOCUS = { x: 0.3, y: 0.4 };
const root = useTempDir("studio-focus-");

/** Distinct bytes per photo (a JPEG header plus a marker byte), so each has its own sha256. */
const photoBytes = (marker: number): Uint8Array => Uint8Array.from([...JPEG_HEADER_ONLY, marker]);

interface FakeGate extends FocusFaceGate {
  readonly calls: Uint8Array[];
  broken: boolean;
}

type Script = (bytes: Uint8Array) => FaceDetection | Error | "hang" | "ignore-signal";

/** A detection of a 1000x2000 image with a face box centred at (300, 800), i.e. focus (0.3, 0.4). The sidecars below are 1000x2000 too. */
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
      if (outcome === "ignore-signal") return new Promise<FaceDetection>(() => {});
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
    const photo = await library.addPhoto(avatar.id, photoBytes(i), samplePhotoMeta({ mediaType: "image/jpeg", width: 1000, height: 2000 }));
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

/** A library whose photo reads never come back (a hung volume). Everything else is the real library's. */
function libraryWithHungReads(library: Library): FocusLibrary {
  return {
    getPhoto: (id) => library.getPhoto(id),
    photosByAvatar: (id) => library.photosByAvatar(id),
    focusCachePath: (id) => library.focusCachePath(id),
    readPhotoVerified: () => new Promise<Uint8Array>(() => {}),
  };
}

const RESOLVED = (focus: { x: number; y: number }) => ({ focus, resolved: true });
const UNRESOLVED = { focus: FALLBACK, resolved: false };

describe("focusFor: a face, or the fallback", () => {
  test("returns the centre of the largest face as fractions of the source image, resolved", async () => {
    const f = await fixture();
    const { focusFor } = createFocusResolver({ library: f.library, faceGate: fakeGate() });
    expect(await focusFor(f.avatarId, only(f.photoIds))).toEqual(RESOLVED(FACE_FOCUS));
  });

  test("returns the (0.5, 0.38) fallback as RESOLVED, not an error, when the photo has no face: the pixels were judged", async () => {
    const f = await fixture();
    const { focusFor } = createFocusResolver({ library: f.library, faceGate: fakeGate(() => NO_FACE) });
    expect(await focusFor(f.avatarId, only(f.photoIds))).toEqual(RESOLVED(FALLBACK));
  });

  test("clamps a face box that reaches past the image edge into 0..1", async () => {
    const f = await fixture();
    const overhang: FaceDetection = { width: 1000, height: 2000, face: { x: 900, y: -100, width: 400, height: 300 } };
    const { focusFor } = createFocusResolver({ library: f.library, faceGate: fakeGate(() => overhang) });
    expect(await focusFor(f.avatarId, only(f.photoIds))).toEqual(RESOLVED({ x: 1, y: 0.025 }));
  });

  test("hands the photo's own bytes to the detector", async () => {
    const f = await fixture(2);
    const gate = fakeGate();
    const { focusFor } = createFocusResolver({ library: f.library, faceGate: gate });
    await focusFor(f.avatarId, f.photoIds[1] ?? "");
    expect(Array.from(only(gate.calls))).toEqual(Array.from(photoBytes(1)));
  });
});

describe("focusFor: the face gate is unavailable — a fallback that is NOT a judgement, so unresolved", () => {
  test("no gate at all (the models failed to load)", async () => {
    const f = await fixture();
    const { focusFor } = createFocusResolver({ library: f.library, faceGate: null });
    expect(await focusFor(f.avatarId, only(f.photoIds))).toEqual(UNRESOLVED);
  });

  test("a broken gate is not asked to detect", async () => {
    const f = await fixture();
    const gate = fakeGate();
    gate.broken = true;
    const { focusFor } = createFocusResolver({ library: f.library, faceGate: gate });
    expect(await focusFor(f.avatarId, only(f.photoIds))).toEqual(UNRESOLVED);
    expect(gate.calls).toHaveLength(0);
  });

  test("a failed detection is unresolved and not remembered: the next call tries again", async () => {
    const f = await fixture();
    let fail = true;
    const gate = fakeGate(() => (fail ? new Error("the worker died") : FACE));
    const { focusFor } = createFocusResolver({ library: f.library, faceGate: gate });
    expect(await focusFor(f.avatarId, only(f.photoIds))).toEqual(UNRESOLVED);
    fail = false;
    expect(await focusFor(f.avatarId, only(f.photoIds))).toEqual(RESOLVED(FACE_FOCUS));
  });

  test("a failed detection leaves no cache file behind", async () => {
    const f = await fixture();
    const resolver = createFocusResolver({ library: f.library, faceGate: fakeGate(() => new Error("boom")) });
    await resolver.focusFor(f.avatarId, only(f.photoIds));
    await resolver.flush();
    expect(await readdir(join(root(), "avatars", f.avatarId))).not.toContain(FOCUS_FILE);
  });

  test("a detection that never returns is given up on after the bound, unresolved, and not remembered", async () => {
    const f = await fixture();
    let hang = true;
    const gate = fakeGate(() => (hang ? "hang" : FACE));
    // 250 ms, not less: the second call must read the photo and still have minStartMs left on a slow CI runner.
    const { focusFor } = createFocusResolver({ library: f.library, faceGate: gate, detectTimeoutMs: 250 });
    const started = performance.now();
    expect(await focusFor(f.avatarId, only(f.photoIds))).toEqual(UNRESOLVED);
    expect(performance.now() - started).toBeLessThan(1_000);
    hang = false;
    expect(await focusFor(f.avatarId, only(f.photoIds))).toEqual(RESOLVED(FACE_FOCUS));
  });

  test("a gate that ignores its signal cannot pin the answer: the bound still fires and the memo is freed", async () => {
    const f = await fixture();
    let stuck = true;
    const gate = fakeGate(() => (stuck ? "ignore-signal" : FACE));
    // 250 ms for the same reason as above: the resolved second call needs room after the photo read.
    const { focusFor } = createFocusResolver({ library: f.library, faceGate: gate, detectTimeoutMs: 250 });
    expect(await focusFor(f.avatarId, only(f.photoIds))).toEqual(UNRESOLVED);
    stuck = false;
    expect(await focusFor(f.avatarId, only(f.photoIds))).toEqual(RESOLVED(FACE_FOCUS));
  });

  test("a photo read that never returns (a hung volume) is bounded too, and the next call is not stuck behind it", async () => {
    const f = await fixture();
    const gate = fakeGate();
    const hung = createFocusResolver({ library: libraryWithHungReads(f.library), faceGate: gate, detectTimeoutMs: 30 });
    const started = performance.now();
    expect(await hung.focusFor(f.avatarId, only(f.photoIds))).toEqual(UNRESOLVED);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(gate.calls).toHaveLength(0);
    expect(await hung.focusFor(f.avatarId, only(f.photoIds))).toEqual(UNRESOLVED); // not remembered
    const healthy = createFocusResolver({ library: f.library, faceGate: gate });
    expect(await healthy.focusFor(f.avatarId, only(f.photoIds))).toEqual(RESOLVED(FACE_FOCUS));
  });

  test("a cache read that never returns is bounded as well", async () => {
    const f = await fixture();
    const { focusFor } = createFocusResolver({
      library: f.library,
      faceGate: fakeGate(),
      detectTimeoutMs: 30,
      cache: { read: () => new Promise(() => {}), remember: () => Promise.resolve() },
    });
    expect(await focusFor(f.avatarId, only(f.photoIds))).toEqual(UNRESOLVED);
  });

  test("a cache save that never returns does not hold the answer back", async () => {
    const f = await fixture();
    const { focusFor } = createFocusResolver({
      library: f.library,
      faceGate: fakeGate(),
      cache: { read: (path) => readFocusCache(path), remember: () => new Promise<void>(() => {}) },
    });
    const started = performance.now();
    expect(await focusFor(f.avatarId, only(f.photoIds))).toEqual(RESOLVED(FACE_FOCUS));
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("does not start a detection with too little of its bound left, and says unresolved", async () => {
    const f = await fixture();
    const gate = fakeGate();
    const { focusFor } = createFocusResolver({
      library: f.library,
      faceGate: gate,
      detectTimeoutMs: 60,
      // A cache read that eats most of the bound before the detection could start.
      cache: { read: async () => (await Bun.sleep(45), new Map()), remember: () => Promise.resolve() },
    });
    expect(await focusFor(f.avatarId, only(f.photoIds))).toEqual(UNRESOLVED);
    expect(gate.calls).toHaveLength(0);
  });

  test("a photo file that no longer matches its sidecar is unresolved and never detected", async () => {
    const f = await fixture();
    await writeFile(f.photoPath(only(f.photoIds)), photoBytes(99));
    const gate = fakeGate();
    const { focusFor } = createFocusResolver({ library: f.library, faceGate: gate });
    expect(await focusFor(f.avatarId, only(f.photoIds))).toEqual(UNRESOLVED);
    expect(gate.calls).toHaveLength(0);
  });

  test("a photo file that is gone is unresolved", async () => {
    const f = await fixture();
    await rm(f.photoPath(only(f.photoIds)));
    const { focusFor } = createFocusResolver({ library: f.library, faceGate: fakeGate() });
    expect(await focusFor(f.avatarId, only(f.photoIds))).toEqual(UNRESOLVED);
  });
});

describe("focusFor: a detection that disagrees with the library", () => {
  test("an image size different from the sidecar's is answered but never cached", async () => {
    const f = await fixture();
    const odd: FaceDetection = { width: 500, height: 500, face: { x: 100, y: 100, width: 100, height: 100 } };
    const resolver = createFocusResolver({ library: f.library, faceGate: fakeGate(() => odd) });
    expect(await resolver.focusFor(f.avatarId, only(f.photoIds))).toEqual(RESOLVED({ x: 0.3, y: 0.3 }));
    await resolver.flush();
    expect(await readdir(join(root(), "avatars", f.avatarId))).not.toContain(FOCUS_FILE);
  });

  test("a photo deleted while its detection ran is not written back", async () => {
    const f = await fixture(2);
    const [gone = "", kept = ""] = f.photoIds;
    const gate = fakeGate();
    gate.detect = async (bytes) => {
      gate.calls.push(bytes);
      await f.library.deletePhoto(f.avatarId, gone);
      return FACE;
    };
    const resolver = createFocusResolver({ library: f.library, faceGate: gate });
    expect(await resolver.focusFor(f.avatarId, gone)).toEqual(RESOLVED(FACE_FOCUS));
    await resolver.flush();
    expect(Array.from((await readFocusCache(f.focusPath)).keys())).toEqual([]);
    expect(kept).not.toBe("");
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
    expect(await second).toEqual(RESOLVED(FACE_FOCUS));
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
    expect(results).toEqual([RESOLVED(FACE_FOCUS), RESOLVED(FACE_FOCUS), RESOLVED(FACE_FOCUS)]);
    expect(gate.calls).toHaveLength(1);
  });

  test("survives a restart: a new resolver reads the persisted answer and never detects", async () => {
    const f = await fixture();
    const first = createFocusResolver({ library: f.library, faceGate: fakeGate() });
    await first.focusFor(f.avatarId, only(f.photoIds));
    await first.flush();
    const gate = fakeGate();
    const restarted = createFocusResolver({ library: f.library, faceGate: gate });
    expect(await restarted.focusFor(f.avatarId, only(f.photoIds))).toEqual(RESOLVED(FACE_FOCUS));
    expect(gate.calls).toHaveLength(0);
  });

  test("remembers 'no face' across a restart too, and still answers with the fallback, resolved", async () => {
    const f = await fixture();
    const first = createFocusResolver({ library: f.library, faceGate: fakeGate(() => NO_FACE) });
    await first.focusFor(f.avatarId, only(f.photoIds));
    await first.flush();
    const gate = fakeGate();
    expect(await createFocusResolver({ library: f.library, faceGate: gate }).focusFor(f.avatarId, only(f.photoIds))).toEqual(RESOLVED(FALLBACK));
    expect(gate.calls).toHaveLength(0);
  });

  test("a persisted answer is served even when the gate is unavailable, and is resolved", async () => {
    const f = await fixture();
    const first = createFocusResolver({ library: f.library, faceGate: fakeGate() });
    await first.focusFor(f.avatarId, only(f.photoIds));
    await first.flush();
    expect(await createFocusResolver({ library: f.library, faceGate: null }).focusFor(f.avatarId, only(f.photoIds))).toEqual(RESOLVED(FACE_FOCUS));
  });

  test("recomputes when the cache file is not JSON, and rewrites it", async () => {
    const f = await fixture();
    await writeFile(f.focusPath, "{ this is not json");
    const gate = fakeGate();
    const resolver = createFocusResolver({ library: f.library, faceGate: gate });
    expect(await resolver.focusFor(f.avatarId, only(f.photoIds))).toEqual(RESOLVED(FACE_FOCUS));
    await resolver.flush();
    expect(gate.calls).toHaveLength(1);
    expect(JSON.parse(await readFile(f.focusPath, "utf8"))).toMatchObject({ schemaVersion: 1, method: FOCUS_METHOD });
  });

  test("recomputes when the cache file is valid JSON of the wrong shape", async () => {
    const f = await fixture();
    await writeFile(f.focusPath, JSON.stringify({ schemaVersion: 1, method: FOCUS_METHOD, photos: { [only(f.photoIds)]: { sha256: "abc", focus: { x: 7, y: "up" } } } }));
    const gate = fakeGate();
    expect(await createFocusResolver({ library: f.library, faceGate: gate }).focusFor(f.avatarId, only(f.photoIds))).toEqual(RESOLVED(FACE_FOCUS));
    expect(gate.calls).toHaveLength(1);
  });

  test("recomputes when the entry was made for other bytes (the photo's sha256 changed)", async () => {
    const f = await fixture();
    const photoId = only(f.photoIds);
    const first = createFocusResolver({ library: f.library, faceGate: fakeGate(() => NO_FACE) });
    await first.focusFor(f.avatarId, photoId);
    await first.flush();
    const cache = JSON.parse(await readFile(f.focusPath, "utf8"));
    cache.photos[photoId].sha256 = "0".repeat(64);
    await writeFile(f.focusPath, JSON.stringify(cache));
    const gate = fakeGate();
    expect(await createFocusResolver({ library: f.library, faceGate: gate }).focusFor(f.avatarId, photoId)).toEqual(RESOLVED(FACE_FOCUS));
    expect(gate.calls).toHaveLength(1);
  });

  test("recomputes when the cache was made by another focus method", async () => {
    const f = await fixture();
    const photoId = only(f.photoIds);
    const first = createFocusResolver({ library: f.library, faceGate: fakeGate(() => NO_FACE) });
    await first.focusFor(f.avatarId, photoId);
    await first.flush();
    const cache = JSON.parse(await readFile(f.focusPath, "utf8"));
    cache.method = "eyes-line-v0";
    await writeFile(f.focusPath, JSON.stringify(cache));
    const gate = fakeGate();
    await createFocusResolver({ library: f.library, faceGate: gate }).focusFor(f.avatarId, photoId);
    expect(gate.calls).toHaveLength(1);
  });

  test("keeps the entries of the avatar's other photos when it adds one", async () => {
    const f = await fixture(2);
    const resolver = createFocusResolver({ library: f.library, faceGate: fakeGate() });
    await Promise.all(f.photoIds.map((id) => resolver.focusFor(f.avatarId, id)));
    await resolver.flush();
    expect(Object.keys(JSON.parse(await readFile(f.focusPath, "utf8")).photos).sort()).toEqual([...f.photoIds].sort());
  });

  test("drops the entry of a photo that has been deleted when it next writes", async () => {
    const f = await fixture(2);
    const resolver = createFocusResolver({ library: f.library, faceGate: fakeGate() });
    await resolver.focusFor(f.avatarId, f.photoIds[0] ?? "");
    await resolver.flush();
    await f.library.deletePhoto(f.avatarId, f.photoIds[0] ?? "");
    await resolver.focusFor(f.avatarId, f.photoIds[1] ?? "");
    await resolver.flush();
    expect(Object.keys(JSON.parse(await readFile(f.focusPath, "utf8")).photos)).toEqual([f.photoIds[1] ?? ""]);
  });

  test("writes compact JSON with coordinates rounded to four decimals", async () => {
    const f = await fixture();
    const third: FaceDetection = { width: 1000, height: 2000, face: { x: 0, y: 0, width: 2000 / 3, height: 4000 / 3 } };
    const resolver = createFocusResolver({ library: f.library, faceGate: fakeGate(() => third) });
    const { focus } = await resolver.focusFor(f.avatarId, only(f.photoIds));
    await resolver.flush();
    const text = await readFile(f.focusPath, "utf8");
    expect(focus).toEqual({ x: 0.3333, y: 0.3333 });
    expect(text.trim().includes("\n")).toBe(false);
    expect(text).toContain('"x":0.3333');
  });

  test("leaves no temp file behind after writing", async () => {
    const f = await fixture();
    const resolver = createFocusResolver({ library: f.library, faceGate: fakeGate() });
    await resolver.focusFor(f.avatarId, only(f.photoIds));
    await resolver.flush();
    expect((await readdir(join(root(), "avatars", f.avatarId))).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  test("the library's own survey leaves the cache file alone when it reopens", async () => {
    const f = await fixture();
    const resolver = createFocusResolver({ library: f.library, faceGate: fakeGate() });
    await resolver.focusFor(f.avatarId, only(f.photoIds));
    await resolver.flush();
    const { report } = await openLibrary(root(), { now: steppingClock(), newId: sequentialIds("other") });
    expect(report.quarantined).toEqual([]);
    expect(await readdir(join(root(), "avatars", f.avatarId))).toContain(FOCUS_FILE);
  });

  test("still answers when the cache cannot be written (a directory where the file should go)", async () => {
    const f = await fixture();
    await mkdir(f.focusPath); // the atomic rename fails
    const resolver = createFocusResolver({ library: f.library, faceGate: fakeGate() });
    expect(await resolver.focusFor(f.avatarId, only(f.photoIds))).toEqual(RESOLVED(FACE_FOCUS));
    await resolver.flush();
  });
});

describe("the cache file under concurrent writers", () => {
  test("two saves for different photos at once both survive (the lock orders the read-modify-write)", async () => {
    const f = await fixture(2);
    const [a = "", b = ""] = f.photoIds;
    const sha = (id: string) => f.library.getPhoto(id)?.sha256 ?? "";
    const live = (id: string) => f.photoIds.includes(id);
    await Promise.all([
      rememberFocus(f.focusPath, a, { sha256: sha(a), focus: { x: 0.1, y: 0.2 } }, live),
      rememberFocus(f.focusPath, b, { sha256: sha(b), focus: null }, live),
    ]);
    const cache = await readFocusCache(f.focusPath);
    expect([...cache.keys()].sort()).toEqual([a, b].sort());
    expect(cache.get(a)?.focus).toEqual({ x: 0.1, y: 0.2 });
    expect(cache.get(b)?.focus).toBeNull();
  });

  test("a save for a photo that is not live writes nothing", async () => {
    const f = await fixture();
    await rememberFocus(f.focusPath, only(f.photoIds), { sha256: "0".repeat(64), focus: null }, () => false);
    expect(await readdir(join(root(), "avatars", f.avatarId))).not.toContain(FOCUS_FILE);
  });
});

// ---- fillMissingFocus ----------------------------------------------------------

const scene = (photoId: string) => ({ source: "scene" as const, photoId });

function specOf(avatarId: string, clips: MontageDraft["clips"]): MontageDraft {
  return { schemaVersion: 1, avatarId, layers: [], music: null, seed: 1, clips };
}

const base = (n: number) => ({ clipId: `clip-00${n}`, durationMs: 2_000, transitionIn: "cut" as const });

describe("fillMissingFocus", () => {
  test("resolves the null focus of a photo cell from its photo, reporting nothing unresolved", async () => {
    const f = await fixture();
    const { fillMissingFocus } = createFocusResolver({ library: f.library, faceGate: fakeGate() });
    const { spec, unresolved } = await fillMissingFocus(specOf(f.avatarId, [{ ...base(1), kind: "photo", motion: "kenburns", cell: { photo: scene(only(f.photoIds)), focus: null } }]));
    expect(only(spec.clips)).toMatchObject({ kind: "photo", cell: { focus: FACE_FOCUS } });
    expect(unresolved).toEqual([]);
  });

  test("resolves every null cell of a collage, each from its own photo", async () => {
    const f = await fixture(2);
    const byMarker: Script = (bytes) => (bytes[bytes.length - 1] === 0 ? FACE : NO_FACE);
    const { fillMissingFocus } = createFocusResolver({ library: f.library, faceGate: fakeGate(byMarker) });
    const [a = "", b = ""] = f.photoIds;
    const { spec } = await fillMissingFocus(
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
    const clip = only(spec.clips);
    expect(clip.kind === "collage" ? clip.cells.map((c) => c.focus) : []).toEqual([FACE_FOCUS, FALLBACK]);
  });

  test("leaves a focus that is already set exactly as it is, and never detects for it", async () => {
    const f = await fixture();
    const gate = fakeGate();
    const { fillMissingFocus } = createFocusResolver({ library: f.library, faceGate: gate });
    const { spec } = await fillMissingFocus(specOf(f.avatarId, [{ ...base(1), kind: "photo", motion: "kenburns", cell: { photo: scene(only(f.photoIds)), focus: { x: 0.9, y: 0.1 } } }]));
    expect(only(spec.clips)).toMatchObject({ cell: { focus: { x: 0.9, y: 0.1 } } });
    expect(gate.calls).toHaveLength(0);
  });

  test("keeps a focus of zero (a real value, not a missing one)", async () => {
    const f = await fixture();
    const { fillMissingFocus } = createFocusResolver({ library: f.library, faceGate: fakeGate() });
    const { spec } = await fillMissingFocus(specOf(f.avatarId, [{ ...base(1), kind: "photo", motion: "kenburns", cell: { photo: scene(only(f.photoIds)), focus: { x: 0, y: 0 } } }]));
    expect(only(spec.clips)).toMatchObject({ cell: { focus: { x: 0, y: 0 } } });
  });

  test("gives the fallback to a cell with no photo, an own-media cell and a video clip, without detecting", async () => {
    const f = await fixture();
    const gate = fakeGate();
    const { fillMissingFocus } = createFocusResolver({ library: f.library, faceGate: gate });
    const { spec } = await fillMissingFocus(
      specOf(f.avatarId, [
        { ...base(1), kind: "photo", motion: "static", cell: { photo: null, focus: null } },
        { ...base(2), kind: "photo", motion: "static", cell: { photo: { source: "own", mediaId: "media-0001" }, focus: null } },
        { ...base(3), kind: "video", mediaId: "media-0002", trimStartMs: 0, focus: null },
      ]),
    );
    expect(spec.clips.map((c) => (c.kind === "photo" ? c.cell.focus : c.kind === "video" ? c.focus : null))).toEqual([FALLBACK, FALLBACK, FALLBACK]);
    expect(gate.calls).toHaveLength(0);
  });

  test("falls back for every null cell when the gate is unavailable, and reports each scene-photo cell as unresolved", async () => {
    const f = await fixture(2);
    const { fillMissingFocus } = createFocusResolver({ library: f.library, faceGate: null });
    const [a = "", b = ""] = f.photoIds;
    const { spec, unresolved } = await fillMissingFocus(
      specOf(f.avatarId, [
        { ...base(1), kind: "photo", motion: "kenburns", cell: { photo: scene(a), focus: null } },
        {
          ...base(2),
          kind: "collage",
          layout: "collage2",
          motion: "static",
          stagger: false,
          cells: [
            { photo: scene(b), focus: { x: 0.2, y: 0.2 } },
            { photo: scene(b), focus: null },
          ],
        },
      ]),
    );
    const [first, second] = spec.clips;
    expect(first).toMatchObject({ cell: { focus: FALLBACK } });
    expect(second?.kind === "collage" ? second.cells.map((c) => c.focus) : []).toEqual([{ x: 0.2, y: 0.2 }, FALLBACK]);
    expect(unresolved).toEqual([
      { clipId: "clip-001", cellIndex: 0 },
      { clipId: "clip-002", cellIndex: 1 },
    ]);
  });

  test("does not modify the spec it was given", async () => {
    const f = await fixture();
    const { fillMissingFocus } = createFocusResolver({ library: f.library, faceGate: fakeGate() });
    const input = specOf(f.avatarId, [{ ...base(1), kind: "photo", motion: "kenburns", cell: { photo: scene(only(f.photoIds)), focus: null } }]);
    const before = structuredClone(input);
    await fillMissingFocus(input);
    expect(input).toEqual(before);
  });

  test("changes nothing but the focus values", async () => {
    const f = await fixture();
    const { fillMissingFocus } = createFocusResolver({ library: f.library, faceGate: fakeGate() });
    const input = specOf(f.avatarId, [{ ...base(1), kind: "photo", motion: "pan", cell: { photo: scene(only(f.photoIds)), focus: null } }]);
    const { spec } = await fillMissingFocus(input);
    expect({ ...spec, clips: [] }).toEqual({ ...input, clips: [] });
    expect(only(spec.clips)).toMatchObject({ clipId: "clip-001", durationMs: 2_000, motion: "pan", cell: { photo: scene(only(f.photoIds)) } });
  });

  test("returns an empty draft as it is", async () => {
    const f = await fixture();
    const { fillMissingFocus } = createFocusResolver({ library: f.library, faceGate: fakeGate() });
    expect((await fillMissingFocus(specOf(f.avatarId, []))).spec.clips).toEqual([]);
  });

  test("does not start a cell with too little of the budget left: the rest take the fallback and are reported", async () => {
    const f = await fixture(2);
    const slow = fakeGate();
    slow.detect = async (bytes) => {
      slow.calls.push(bytes);
      await Bun.sleep(60);
      return FACE;
    };
    const { fillMissingFocus } = createFocusResolver({ library: f.library, faceGate: slow, fillBudgetMs: 100 });
    const [a = "", b = ""] = f.photoIds;
    const { spec, unresolved } = await fillMissingFocus(
      specOf(f.avatarId, [
        { ...base(1), kind: "photo", motion: "static", cell: { photo: scene(a), focus: null } },
        { ...base(2), kind: "photo", motion: "static", cell: { photo: scene(b), focus: null } },
      ]),
    );
    expect(spec.clips.map((c) => (c.kind === "photo" ? c.cell.focus : null))).toEqual([FACE_FOCUS, FALLBACK]);
    expect(unresolved).toEqual([{ clipId: "clip-002", cellIndex: 0 }]);
    expect(slow.calls).toHaveLength(1);
  });

  test("a budget given for ONE call cuts it short and keeps every cell already judged: the rest take the fallback and are reported", async () => {
    const f = await fixture(2);
    const slow = fakeGate();
    slow.detect = async (bytes) => {
      slow.calls.push(bytes);
      await Bun.sleep(60);
      return FACE;
    };
    const { fillMissingFocus } = createFocusResolver({ library: f.library, faceGate: slow, fillBudgetMs: 10_000 });
    const [a = "", b = ""] = f.photoIds;
    const { spec, unresolved } = await fillMissingFocus(
      specOf(f.avatarId, [
        { ...base(1), kind: "photo", motion: "static", cell: { photo: scene(a), focus: null } },
        { ...base(2), kind: "photo", motion: "static", cell: { photo: scene(b), focus: null } },
      ]),
      undefined,
      { budgetMs: 100 },
    );
    expect(spec.clips.map((c) => (c.kind === "photo" ? c.cell.focus : null))).toEqual([FACE_FOCUS, FALLBACK]);
    expect(unresolved).toEqual([{ clipId: "clip-002", cellIndex: 0 }]);
  });

  test("a cell that is still being resolved when the budget runs out takes the fallback at once, and the shared detection carries on", async () => {
    const f = await fixture();
    let release: (value: FaceDetection) => void = () => {};
    const gate = fakeGate();
    gate.detect = (bytes) => {
      gate.calls.push(bytes);
      return new Promise<FaceDetection>((resolve) => {
        release = resolve;
      });
    };
    const resolver = createFocusResolver({ library: f.library, faceGate: gate, fillBudgetMs: 80 });
    const started = performance.now();
    const { spec, unresolved } = await resolver.fillMissingFocus(specOf(f.avatarId, [{ ...base(1), kind: "photo", motion: "static", cell: { photo: scene(only(f.photoIds)), focus: null } }]));
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(only(spec.clips)).toMatchObject({ cell: { focus: FALLBACK } });
    expect(unresolved).toEqual([{ clipId: "clip-001", cellIndex: 0 }]);
    release(FACE);
    expect(await resolver.focusFor(f.avatarId, only(f.photoIds))).toEqual(RESOLVED(FACE_FOCUS)); // the same detection, not a second one
    expect(gate.calls).toHaveLength(1);
  });

  test("a hung photo read cannot hold the fill past its budget", async () => {
    const f = await fixture();
    const { fillMissingFocus } = createFocusResolver({ library: libraryWithHungReads(f.library), faceGate: fakeGate(), fillBudgetMs: 60 });
    const started = performance.now();
    const { unresolved } = await fillMissingFocus(specOf(f.avatarId, [{ ...base(1), kind: "photo", motion: "static", cell: { photo: scene(only(f.photoIds)), focus: null } }]));
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(unresolved).toEqual([{ clipId: "clip-001", cellIndex: 0 }]);
  });

  test("rejects with the abort reason when the signal is already aborted", async () => {
    const f = await fixture();
    const { fillMissingFocus } = createFocusResolver({ library: f.library, faceGate: fakeGate() });
    const controller = new AbortController();
    controller.abort(new Error("job cancelled"));
    await expect(fillMissingFocus(specOf(f.avatarId, [{ ...base(1), kind: "photo", motion: "static", cell: { photo: scene(only(f.photoIds)), focus: null } }]), controller.signal)).rejects.toThrow("job cancelled");
  });

  test("rejects with the abort reason when the signal fires in the middle of a fill", async () => {
    const f = await fixture(2);
    const [a = "", b = ""] = f.photoIds;
    const gate = fakeGate((bytes) => (bytes[bytes.length - 1] === 1 ? "hang" : FACE));
    const { fillMissingFocus } = createFocusResolver({ library: f.library, faceGate: gate, detectTimeoutMs: 5_000 });
    const controller = new AbortController();
    const running = fillMissingFocus(
      specOf(f.avatarId, [
        { ...base(1), kind: "photo", motion: "static", cell: { photo: scene(a), focus: null } },
        { ...base(2), kind: "photo", motion: "static", cell: { photo: scene(b), focus: null } },
      ]),
      controller.signal,
    ).then(
      () => "finished",
      (e: unknown) => (e instanceof Error ? e.message : "not an error"),
    );
    await Bun.sleep(40); // the first cell is done, the second is hanging
    controller.abort(new Error("job cancelled"));
    expect(await running).toBe("job cancelled");
  });

  test("refuses a spec that names a photo the avatar does not have", async () => {
    const f = await fixture();
    const { fillMissingFocus } = createFocusResolver({ library: f.library, faceGate: fakeGate() });
    await expect(fillMissingFocus(specOf(f.avatarId, [{ ...base(1), kind: "photo", motion: "static", cell: { photo: scene("no-such-photo"), focus: null } }]))).rejects.toMatchObject({ code: "photo-not-found" });
  });
});

// S4.P3: the autopilot resolves focus AHEAD of rendering, behind paid face checks. A prefetch has its own (longer)
// timeout, waits out a full lane instead of falling back, and shares the per-photo memo and cache with focusFor.
describe("prefetchFocus (S4.P3)", () => {
  /** A gate whose first `refusals` detects are refused because the lane is full. */
  function refusingGate(refusals: number): FakeGate {
    let left = refusals;
    const inner = fakeGate();
    return {
      ...inner,
      calls: inner.calls,
      isBroken: () => false,
      detect: (bytes, signal) => {
        if (left > 0) {
          left -= 1;
          inner.calls.push(bytes);
          return Promise.reject(new FaceLaneFullError());
        }
        return inner.detect(bytes, signal);
      },
    };
  }

  test("returns the same resolved answer focusFor would", async () => {
    const f = await fixture();
    const { prefetchFocus, flush } = createFocusResolver({ library: f.library, faceGate: fakeGate() });
    expect(await prefetchFocus(f.avatarId, only(f.photoIds))).toEqual(RESOLVED(FACE_FOCUS));
    await flush();
  });

  test("two concurrent prefetches of the same photo run one detection", async () => {
    const f = await fixture();
    const gate = fakeGate();
    const { prefetchFocus, flush } = createFocusResolver({ library: f.library, faceGate: gate });
    const [a, b] = await Promise.all([prefetchFocus(f.avatarId, only(f.photoIds)), prefetchFocus(f.avatarId, only(f.photoIds))]);
    expect(a).toEqual(b);
    expect(gate.calls).toHaveLength(1);
    await flush();
  });

  test("a second prefetch of an already resolved photo does not touch the face lane", async () => {
    const f = await fixture();
    const gate = fakeGate();
    const { prefetchFocus, flush } = createFocusResolver({ library: f.library, faceGate: gate });
    await prefetchFocus(f.avatarId, only(f.photoIds));
    await flush();
    await prefetchFocus(f.avatarId, only(f.photoIds));
    expect(gate.calls).toHaveLength(1);
  });

  test("a prefetch survives a restart: the answer is in focus.json, so a new resolver detects nothing", async () => {
    const f = await fixture();
    const first = createFocusResolver({ library: f.library, faceGate: fakeGate() });
    await first.prefetchFocus(f.avatarId, only(f.photoIds));
    await first.flush();
    const gate = fakeGate();
    const second = createFocusResolver({ library: f.library, faceGate: gate });
    expect(await second.prefetchFocus(f.avatarId, only(f.photoIds))).toEqual(RESOLVED(FACE_FOCUS));
    expect(gate.calls).toHaveLength(0);
  });

  test("a render's focusFor after the prefetch never touches the face lane", async () => {
    const f = await fixture();
    const gate = fakeGate();
    const resolver = createFocusResolver({ library: f.library, faceGate: gate });
    await resolver.prefetchFocus(f.avatarId, only(f.photoIds));
    await resolver.flush();
    expect(await resolver.focusFor(f.avatarId, only(f.photoIds))).toEqual(RESOLVED(FACE_FOCUS));
    expect(gate.calls).toHaveLength(1);
  });

  test("a headless spec's fillMissingFocus after the prefetch makes no detection", async () => {
    const f = await fixture();
    const gate = fakeGate();
    const resolver = createFocusResolver({ library: f.library, faceGate: gate });
    await resolver.prefetchFocus(f.avatarId, only(f.photoIds));
    await resolver.flush();
    const filled = await resolver.fillMissingFocus(specOf(f.avatarId, [{ ...base(1), kind: "photo", motion: "kenburns", cell: { photo: scene(only(f.photoIds)), focus: null } }]));
    expect(filled.unresolved).toEqual([]);
    expect(gate.calls).toHaveLength(1);
  });

  test("waits out a full lane and retries until the photo is judged", async () => {
    const f = await fixture();
    const gate = refusingGate(3);
    const { prefetchFocus, flush } = createFocusResolver({ library: f.library, faceGate: gate });
    expect(await prefetchFocus(f.avatarId, only(f.photoIds), { retryMs: 10 })).toEqual(RESOLVED(FACE_FOCUS));
    expect(gate.calls).toHaveLength(4);
    await flush();
  });

  test("uses its own timeout, not detectTimeoutMs: a lane that stays full longer than detectTimeoutMs still gets judged", async () => {
    const f = await fixture();
    const gate = refusingGate(8);
    const { prefetchFocus, flush } = createFocusResolver({ library: f.library, faceGate: gate, detectTimeoutMs: 40 });
    expect(await prefetchFocus(f.avatarId, only(f.photoIds), { timeoutMs: 5_000, retryMs: 20 })).toEqual(RESOLVED(FACE_FOCUS));
    await flush();
  });

  test("gives up at its own timeout with an unresolved fallback when the lane never frees, and remembers nothing", async () => {
    const f = await fixture();
    const gate = refusingGate(Number.POSITIVE_INFINITY);
    const resolver = createFocusResolver({ library: f.library, faceGate: gate });
    const startedAt = performance.now();
    expect(await resolver.prefetchFocus(f.avatarId, only(f.photoIds), { timeoutMs: 200, retryMs: 20 })).toEqual(UNRESOLVED);
    // It keeps asking until less than minStart (100 ms of a 200 ms bound) is left, so it waited at least that long.
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(90);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    const fresh = fakeGate();
    const later = createFocusResolver({ library: f.library, faceGate: fresh });
    const answer = await later.prefetchFocus(f.avatarId, only(f.photoIds));
    await later.flush();
    expect(answer).toEqual(RESOLVED(FACE_FOCUS));
  });

  test("a hung detection ends at the prefetch's timeout as unresolved, not at detectTimeoutMs", async () => {
    const f = await fixture();
    const { prefetchFocus } = createFocusResolver({ library: f.library, faceGate: fakeGate(() => "hang"), detectTimeoutMs: 20 });
    const startedAt = performance.now();
    expect(await prefetchFocus(f.avatarId, only(f.photoIds), { timeoutMs: 300 })).toEqual(UNRESOLVED);
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(250);
  });

  test("a manual focusFor whose detect the gate refuses (another consumer filled the lane) falls back at once, unresolved, without retrying", async () => {
    const f = await fixture();
    const gate = refusingGate(Number.POSITIVE_INFINITY);
    const { focusFor } = createFocusResolver({ library: f.library, faceGate: gate });
    expect(await focusFor(f.avatarId, only(f.photoIds))).toEqual(UNRESOLVED);
    expect(gate.calls).toHaveLength(1);
  });

  test("never has more than two detects at the gate (the lane's cap on waiting ones, whatever holds the lane) however many photos are asked for at once", async () => {
    const f = await fixture(12);
    let atGate = 0;
    let most = 0;
    const gate: FakeGate = {
      ...fakeGate(),
      detect: async () => {
        atGate += 1;
        most = Math.max(most, atGate);
        await Bun.sleep(5);
        atGate -= 1;
        return FACE;
      },
    };
    const { focusFor, flush } = createFocusResolver({ library: f.library, faceGate: gate });
    const results = await Promise.all(f.photoIds.map((id) => focusFor(f.avatarId, id)));
    await flush();
    expect(results.every((r) => r.resolved)).toBe(true);
    expect(most).toBe(2);
  });

  test("a photo waiting for admission has not been read yet: at most two photo reads are in flight", async () => {
    const f = await fixture(10);
    let reading = 0;
    let most = 0;
    const library: FocusLibrary = {
      getPhoto: (id) => f.library.getPhoto(id),
      photosByAvatar: (id) => f.library.photosByAvatar(id),
      focusCachePath: (id) => f.library.focusCachePath(id),
      readPhotoVerified: async (id) => {
        reading += 1;
        most = Math.max(most, reading);
        await Bun.sleep(1);
        reading -= 1;
        return f.library.readPhotoVerified(id);
      },
    };
    const gate = fakeGate(() => "hang");
    const { focusFor } = createFocusResolver({ library, faceGate: gate, detectTimeoutMs: 150 });
    await Promise.all(f.photoIds.map((id) => focusFor(f.avatarId, id)));
    expect(gate.calls).toHaveLength(2);
    expect(most).toBeLessThanOrEqual(2);
  });

  test("a photo waiting for admission gives up at its own bound, unresolved, and is never sent to the gate", async () => {
    const f = await fixture(6);
    const gate = fakeGate(() => "hang");
    const { focusFor } = createFocusResolver({ library: f.library, faceGate: gate, detectTimeoutMs: 120 });
    const startedAt = performance.now();
    const results = await Promise.all(f.photoIds.map((id) => focusFor(f.avatarId, id)));
    expect(results.every((r) => !r.resolved)).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(gate.calls).toHaveLength(2);
  });

  test("a prefetch that joined a failed focusFor resolves again with what is left of its own budget", async () => {
    const f = await fixture();
    let n = 0;
    const gate = fakeGate(() => (n++ === 0 ? new Error("decoder hiccup") : FACE));
    const { focusFor, prefetchFocus, flush } = createFocusResolver({ library: f.library, faceGate: gate });
    const manual = focusFor(f.avatarId, only(f.photoIds));
    const prefetched = prefetchFocus(f.avatarId, only(f.photoIds));
    expect(await manual).toEqual(UNRESOLVED);
    expect(await prefetched).toEqual(RESOLVED(FACE_FOCUS));
    expect(gate.calls).toHaveLength(2);
    await flush();
  });

  test("a prefetch does not ask the gate again once less than the minimum start time of its bound is left", async () => {
    const f = await fixture();
    const gate = refusingGate(Number.POSITIVE_INFINITY);
    const asked: number[] = [];
    const watched: FakeGate = { ...gate, detect: (bytes, signal) => (asked.push(performance.now()), gate.detect(bytes, signal)) };
    const { prefetchFocus } = createFocusResolver({ library: f.library, faceGate: watched });
    const startedAt = performance.now();
    expect(await prefetchFocus(f.avatarId, only(f.photoIds), { timeoutMs: 400, retryMs: 20 })).toEqual(UNRESOLVED);
    expect(Math.max(...asked) - startedAt).toBeLessThan(260); // minStart(400 ms) = 200 ms
  });

  test("refuses a photo the avatar does not have", async () => {
    const f = await fixture();
    const { prefetchFocus } = createFocusResolver({ library: f.library, faceGate: fakeGate() });
    await expect(prefetchFocus(f.avatarId, "no-such-photo")).rejects.toMatchObject({ code: "photo-not-found" });
  });

  test("rejects with the abort reason when the caller's signal aborts while the lane is full", async () => {
    const f = await fixture();
    const gate = refusingGate(Number.POSITIVE_INFINITY);
    const { prefetchFocus } = createFocusResolver({ library: f.library, faceGate: gate });
    const controller = new AbortController();
    const pending = prefetchFocus(f.avatarId, only(f.photoIds), { signal: controller.signal, retryMs: 20, timeoutMs: 300 });
    setTimeout(() => controller.abort(new Error("autopilot stopped")), 40);
    await expect(pending).rejects.toThrow("autopilot stopped");
    await Bun.sleep(350); // the shared computation outlives its caller until its own bound: let it finish before the fixture goes
    const callsThen = gate.calls.length;
    await Bun.sleep(100);
    expect(gate.calls).toHaveLength(callsThen);
  });
});
