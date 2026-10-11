import { join } from "node:path";
import { manifestTraits } from "../avatars/records";
import type { PortraitFaceGate } from "../engine";
import type { FaceVerdict } from "../face/verdict";
import { openLibrary, type PhotoQa } from "../library";
import { SAMPLE_IMPORTED_SOURCE, SAMPLE_SOURCE, samplePhotoMeta, sequentialIds, steppingClock } from "../library/testing/helpers";
import { GOOD, portraitPng, TRAITS } from "./engineHarness";

// Test-only (Stage 5, S5.3c): an imported avatar with reference portraits in a real library, and a scripted face gate. Shared by the engine's portrait tests.

export function match(similarity: number, headRatio = 0.3): FaceVerdict {
  return { kind: "match", similarity, faces: 1, headRatio };
}

export interface GateRig {
  gate: PortraitFaceGate;
  /** The bytes each `embed` call was given, in order. */
  embedded: Uint8Array[];
  /** The bytes each `check` call was given, in order, with the embedding it compared with. */
  checked: { bytes: Uint8Array; embedding: Float32Array }[];
}

/**
 * A face gate that answers from a script. `verdicts` is consumed in `check` call order (the settings run one slot at a time, so the n-th image is slot n); past its end the answer is
 * a 0.7 match. `embed` answers `[1, 2, 3]`, or what `embed` says.
 */
export function fakeGate(
  opts: { verdicts?: readonly (FaceVerdict | Error)[]; embed?: (bytes: Uint8Array, call: number) => Promise<Float32Array>; broken?: () => boolean; check?: (bytes: Uint8Array, call: number) => Promise<FaceVerdict> } = {},
): GateRig {
  const embedded: Uint8Array[] = [];
  const checked: GateRig["checked"] = [];
  const gate: PortraitFaceGate = {
    embed: async (bytes) => {
      embedded.push(bytes);
      return opts.embed === undefined ? Float32Array.of(1, 2, 3) : opts.embed(bytes, embedded.length);
    },
    check: async ({ bytes, masterEmbedding }) => {
      checked.push({ bytes, embedding: masterEmbedding });
      if (opts.check !== undefined) return opts.check(bytes, checked.length);
      const scripted = opts.verdicts?.[checked.length - 1];
      if (scripted instanceof Error) throw scripted;
      return scripted ?? match(0.7);
    },
    isBroken: () => opts.broken?.() ?? false,
  };
  return { gate, embedded, checked };
}

let seeded = 0;

export interface SeededPortraits {
  avatarId: string;
  sourceId: string;
  /** The pending portraits, in the order of `portraits` (the likenesses asked for). */
  portraitIds: string[];
}

/**
 * An imported avatar (master = the imported photo, a real PNG) with one portrait photo per entry of `portraits`, each a different real PNG with that `qa.faceCos`. `master` (an index
 * into `portraits`) makes that portrait the master. `age` is the stored age verdict of every portrait.
 */
export async function seedImportedAvatar(
  dir: string,
  opts: { portraits?: readonly number[]; master?: number; descriptor?: string; age?: PhotoQa["age"]; status?: "active" | "archived" } = {},
): Promise<SeededPortraits> {
  const { library } = await openLibrary(join(dir, "library"), { now: steppingClock(), newId: sequentialIds(`pt${++seeded}`) });
  const { avatar, photo: source } = await library.createImportedAvatar({
    name: "Nini",
    age: 25,
    traits: manifestTraits(TRAITS),
    descriptor: opts.descriptor ?? GOOD,
    photoBytes: portraitPng(1),
    photoMeta: samplePhotoMeta({ width: 60, height: 80, source: SAMPLE_IMPORTED_SOURCE }),
  });
  const portraitIds: string[] = [];
  for (const [i, faceCos] of (opts.portraits ?? []).entries()) {
    const photo = await library.addPhoto(
      avatar.id,
      portraitPng(i + 2),
      samplePhotoMeta({ width: 60, height: 80, source: { ...SAMPLE_SOURCE, slot: `portrait-${(i % 5) + 1}` }, qa: { faceCos, headRatio: 0.3, ...(opts.age === undefined ? {} : { age: opts.age }) } }),
    );
    portraitIds.push(photo.id);
  }
  if (opts.master !== undefined) await library.updateAvatar(avatar.id, { masterPhotoId: portraitIds[opts.master] });
  if (opts.status === "archived") await library.updateAvatar(avatar.id, { status: "archived" });
  return { avatarId: avatar.id, sourceId: source.id, portraitIds };
}
