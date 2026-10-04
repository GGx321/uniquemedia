import { describe, expect, test } from "bun:test";
import type { MontageDraft } from "../../shared/engine/montage";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import type { FaceDetection } from "../face/worker/workerGate";
import type { Library } from "../library/library";
import { createFocusResolver, type FocusFaceGate, type FocusLibrary, type OwnPhotoReader } from "./focusResolver";
useNativeGlobals();

// The focus of an OWN photo (3f.2): the face detector looks at the stored JPEG, or the fallback point stands in. As for a scene photo,
// failing to judge is never an error for the caller: `resolved: false` says nothing was looked at and the draft stores null.

const FALLBACK = { x: 0.5, y: 0.38 };
/** A 1000x2000 picture with a face centred at (300, 800): focus (0.3, 0.4). */
const FACE: FaceDetection = { width: 1000, height: 2000, face: { x: 200, y: 600, width: 200, height: 400 } };
const NO_FACE: FaceDetection = { width: 1000, height: 2000, face: null };

interface FakeGate extends FocusFaceGate {
  readonly calls: Uint8Array[];
  broken: boolean;
}

type Script = (bytes: Uint8Array) => FaceDetection | Error | "hang";

function fakeGate(script: Script = () => FACE): FakeGate {
  const gate: FakeGate = {
    calls: [],
    broken: false,
    isBroken: () => gate.broken,
    detect: (bytes, signal) => {
      gate.calls.push(bytes);
      const outcome = script(bytes);
      if (outcome === "hang") return new Promise<FaceDetection>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
    },
  };
  return gate;
}

/** The library's scene side is not used here: an own photo never touches it. */
const NO_LIBRARY: FocusLibrary = {
  getPhoto: () => undefined,
  photosByAvatar: () => [],
  focusCachePath: () => "/never/read/focus.json",
  readPhotoVerified: () => Promise.reject(new Error("an own photo must not be read as a scene photo")),
} satisfies Partial<Record<keyof Library, unknown>> as FocusLibrary;

interface Reader extends OwnPhotoReader {
  readonly reads: string[];
}

function reader(held: Record<string, { bytes?: Uint8Array; width?: number; height?: number } | "throws">): Reader {
  const reads: string[] = [];
  return {
    reads,
    read: async (mediaId) => {
      reads.push(mediaId);
      const entry = held[mediaId];
      if (entry === undefined) return undefined;
      if (entry === "throws") throw new Error("the file could not be read");
      return { bytes: entry.bytes ?? Uint8Array.from([0xff, 0xd8, 0xff, 1]), width: entry.width ?? 1000, height: entry.height ?? 2000 };
    },
  };
}

const resolverWith = (gate: FocusFaceGate | null, own: OwnPhotoReader | undefined, extra: { detectTimeoutMs?: number; fillBudgetMs?: number } = {}) =>
  createFocusResolver({ library: NO_LIBRARY, faceGate: gate, ...(own === undefined ? {} : { ownMedia: own }), ...extra });

const signal = (): AbortSignal => new AbortController().signal;

describe("focusForOwn: a face, or the fallback", () => {
  test("returns the centre of the largest face on the stored photo, resolved", async () => {
    const own = reader({ "media-0000001": {} });
    const resolver = resolverWith(fakeGate(), own);
    expect(await resolver.focusForOwn("media-0000001")).toEqual({ focus: { x: 0.3, y: 0.4 }, resolved: true });
    expect(own.reads).toEqual(["media-0000001"]);
  });

  test("hands the detector the bytes the reader verified", async () => {
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 42]);
    const gate = fakeGate();
    await resolverWith(gate, reader({ "media-0000001": { bytes } })).focusForOwn("media-0000001");
    expect(gate.calls).toEqual([bytes]);
  });

  test("returns the fallback as RESOLVED when the photo has no face: the pixels were judged", async () => {
    const resolver = resolverWith(fakeGate(() => NO_FACE), reader({ "media-0000001": {} }));
    expect(await resolver.focusForOwn("media-0000001")).toEqual({ focus: FALLBACK, resolved: true });
  });
});

describe("focusForOwn: nothing was judged", () => {
  test("a gate that did not load falls back, unresolved, and reads nothing", async () => {
    const own = reader({ "media-0000001": {} });
    expect(await resolverWith(null, own).focusForOwn("media-0000001")).toEqual({ focus: FALLBACK, resolved: false });
    expect(own.reads).toEqual([]);
  });

  test("a gate that is broken falls back, unresolved", async () => {
    const gate = fakeGate();
    gate.broken = true;
    expect(await resolverWith(gate, reader({ "media-0000001": {} })).focusForOwn("media-0000001")).toEqual({ focus: FALLBACK, resolved: false });
    expect(gate.calls).toEqual([]);
  });

  test("with no media reader wired the photo cannot be read: unresolved", async () => {
    expect(await resolverWith(fakeGate(), undefined).focusForOwn("media-0000001")).toEqual({ focus: FALLBACK, resolved: false });
  });

  test("a media the library does not hold is unresolved, never an error", async () => {
    expect(await resolverWith(fakeGate(), reader({})).focusForOwn("media-0000404")).toEqual({ focus: FALLBACK, resolved: false });
  });

  test("a read that fails is unresolved", async () => {
    expect(await resolverWith(fakeGate(), reader({ "media-0000001": "throws" })).focusForOwn("media-0000001")).toEqual({ focus: FALLBACK, resolved: false });
  });

  test("a detector that throws is unresolved", async () => {
    const resolver = resolverWith(fakeGate(() => new Error("the face worker broke")), reader({ "media-0000001": {} }));
    expect(await resolver.focusForOwn("media-0000001")).toEqual({ focus: FALLBACK, resolved: false });
  });

  test("a detection made on a picture of another size than the record's is not this photo's answer: unresolved", async () => {
    const resolver = resolverWith(fakeGate(() => ({ ...FACE, width: 500 })), reader({ "media-0000001": {} }));
    expect(await resolver.focusForOwn("media-0000001")).toEqual({ focus: FALLBACK, resolved: false });
  });

  test("a detector that never answers ends at the bound with the fallback, unresolved", async () => {
    const resolver = resolverWith(fakeGate(() => "hang"), reader({ "media-0000001": {} }), { detectTimeoutMs: 40 });
    expect(await resolver.focusForOwn("media-0000001")).toEqual({ focus: FALLBACK, resolved: false });
  });

  test("a cancel rejects with the signal's reason", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    await expect(resolverWith(fakeGate(), reader({ "media-0000001": {} })).focusForOwn("media-0000001", controller.signal)).rejects.toThrow("stopped");
  });
});

type Clip = MontageDraft["clips"][number];
const ownCell = (mediaId: string, focus: { x: number; y: number } | null = null) => ({ photo: { source: "own" as const, mediaId }, focus });
const photoClip = (n: number, cell: ReturnType<typeof ownCell>): Clip => ({ clipId: `clip-${n}`, durationMs: 2000, transitionIn: "cut", kind: "photo", cell, motion: "static" });
const collage = (n: number, cells: ReturnType<typeof ownCell>[]): Clip => ({ clipId: `clip-${n}`, durationMs: 2000, transitionIn: "cut", kind: "collage", layout: "collage2", cells, stagger: false, motion: "static" });
const specOf = (clips: Clip[]): MontageDraft => ({ schemaVersion: 1, avatarId: "avatar-00000001", clips, layers: [], music: null, seed: 1 });

describe("fillMissingFocus: own photo cells", () => {
  test("fills an own photo's null focus from its face", async () => {
    const filled = await resolverWith(fakeGate(), reader({ "media-0000001": {} })).fillMissingFocus(specOf([photoClip(1, ownCell("media-0000001"))]));
    expect(filled.spec.clips[0]).toMatchObject({ cell: { focus: { x: 0.3, y: 0.4 } } });
    expect(filled.unresolved).toEqual([]);
  });

  test("keeps a focus the owner already set, and reads nothing for it", async () => {
    const own = reader({ "media-0000001": {} });
    const set = { x: 0.7, y: 0.2 };
    const filled = await resolverWith(fakeGate(), own).fillMissingFocus(specOf([photoClip(1, ownCell("media-0000001", set))]));
    expect(filled.spec.clips[0]).toMatchObject({ cell: { focus: set } });
    expect(own.reads).toEqual([]);
  });

  test("an own photo that could not be judged gets the fallback and is listed as unresolved at its cell", async () => {
    const filled = await resolverWith(fakeGate(() => new Error("broke")), reader({ "media-0000001": {} })).fillMissingFocus(specOf([photoClip(1, ownCell("media-0000001")), collage(2, [ownCell("media-0000001"), ownCell("media-0000002")])]));
    expect(filled.spec.clips[0]).toMatchObject({ cell: { focus: FALLBACK } });
    expect(filled.unresolved).toEqual([
      { clipId: "clip-1", cellIndex: 0 },
      { clipId: "clip-2", cellIndex: 0 },
      { clipId: "clip-2", cellIndex: 1 },
    ]);
  });

  test("judges a media that two cells use once", async () => {
    const own = reader({ "media-0000001": {} });
    const gate = fakeGate();
    await resolverWith(gate, own).fillMissingFocus(specOf([photoClip(1, ownCell("media-0000001")), photoClip(2, ownCell("media-0000001"))]));
    expect(gate.calls).toHaveLength(1);
    expect(own.reads).toEqual(["media-0000001"]);
  });

  test("does not change the spec it was given", async () => {
    const spec = specOf([photoClip(1, ownCell("media-0000001"))]);
    const copy = JSON.stringify(spec);
    await resolverWith(fakeGate(), reader({ "media-0000001": {} })).fillMissingFocus(spec);
    expect(JSON.stringify(spec)).toBe(copy);
  });

  test("a cancel rejects with the signal's reason", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    await expect(resolverWith(fakeGate(), reader({ "media-0000001": {} })).fillMissingFocus(specOf([photoClip(1, ownCell("media-0000001"))]), controller.signal)).rejects.toThrow("stopped");
    void signal;
  });
});
