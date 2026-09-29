import { z } from "zod";
import { LIBRARY_ID_PATTERN } from "./ids";
import { IMAGE_MEDIA_TYPES, extensionFor } from "./media";

export const LibraryIdSchema = z.string().regex(LIBRARY_ID_PATTERN);

const IsoTimestamp = z.iso.datetime();
const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const NonEmpty = z.string().min(1);

/** `<root>/library.json` — marks a folder as a Studio library. */
export const LibraryFileSchema = z.object({
  schemaVersion: z.literal(1),
  createdAt: IsoTimestamp,
});
export type LibraryFile = z.infer<typeof LibraryFileSchema>;

/** A trait's value as stored: text, a number, or a list of text (e.g. marks). */
export const TraitValueSchema = z.union([z.string(), z.number(), z.array(z.string())]);
export type TraitValue = z.infer<typeof TraitValueSchema>;

/** `avatars/<id>/avatar.json`. Strict: an unknown key (e.g. the dropped
 *  `language` — on-video text is English only) makes the manifest invalid.
 *  An avatar is a `draft` until a candidate portrait is picked as its master;
 *  only a draft may have no master. The master may only ever be one of this
 *  avatar's photos. Traits keep their JSON types from version 2 on; the
 *  library checks only their shape — what the values mean is the engine's
 *  business, so a stricter contract later never quarantines an avatar. */
export const AvatarManifestSchema = z
  .strictObject({
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    id: LibraryIdSchema,
    name: NonEmpty,
    age: z.int().min(21).max(35),
    traits: z.record(z.string(), TraitValueSchema),
    descriptor: NonEmpty,
    masterPhotoId: LibraryIdSchema.nullable(),
    status: z.enum(["draft", "active", "archived"]),
    createdAt: IsoTimestamp,
  })
  .refine((m) => m.status === "draft" || m.masterPhotoId !== null, {
    message: "only a draft may have no master photo",
    path: ["masterPhotoId"],
  })
  .refine((m) => m.schemaVersion !== 1 || Object.values(m.traits).every((v) => typeof v === "string"), {
    message: "version 1 traits are text only",
    path: ["traits"],
  });
export type AvatarManifest = z.infer<typeof AvatarManifestSchema>;
export type AvatarStatus = AvatarManifest["status"];

/**
 * Where a photo came from: a generated frame, or (T6c, invariant 9 widened:
 * "generated, or the owner's import") a photo the owner already had and
 * imported through the one-time image age check and vision descriptor job.
 * Still no kind for an arbitrary file: an imported photo only ever exists
 * because `avatars.importAvatar` stored it through the library, exactly like
 * a generated one — no other code path can add a `PhotoSource`. A union, not
 * an added optional field, so every existing "generated" sidecar keeps
 * parsing exactly as it did (backward-compatible parsing).
 */
const GeneratedSourceSchema = z.object({
  kind: z.literal("generated"),
  model: NonEmpty,
  provider: NonEmpty,
  jobId: NonEmpty,
  attemptId: NonEmpty,
  promptSha: Sha256Hex,
  prompt: NonEmpty,
  slot: NonEmpty.optional(),
  category: NonEmpty.optional(),
  /** Integer micro-dollars. */
  costMicros: z.int().nonnegative(),
});

/**
 * No model, provider, job, prompt or cost: none of that applies to a photo
 * the owner already had. `confirmedAiPersona` records the owner's own
 * confirmation (the payload's `confirmedAiPersona: z.literal(true)`) — the
 * engine refuses the import without it, so this field is never anything but
 * `true` once it exists (L11: recorded, not only checked and discarded).
 */
const ImportedSourceSchema = z.strictObject({
  kind: z.literal("imported"),
  importedAt: IsoTimestamp,
  confirmedAiPersona: z.literal(true),
});

export const PhotoSourceSchema = z.discriminatedUnion("kind", [GeneratedSourceSchema, ImportedSourceSchema]);
export type PhotoSource = z.infer<typeof PhotoSourceSchema>;
/** The two branches, exported so a caller that only ever builds one of them (a generated frame's own job, T6c's import job, their tests) can type a value precisely instead of the wider union. */
export type GeneratedPhotoSource = z.infer<typeof GeneratedSourceSchema>;
export type ImportedPhotoSource = z.infer<typeof ImportedSourceSchema>;

export const PhotoQaSchema = z.object({
  age: z.object({ adult: z.boolean(), confidence: z.number().min(0).max(1) }).optional(),
  /** 256-bit PDQ hash as lowercase hex. */
  pdq: Sha256Hex.optional(),
  faceCos: z.number().min(-1).max(1).optional(),
  headRatio: z.number().positive().optional(),
});
export type PhotoQa = z.infer<typeof PhotoQaSchema>;

/** One line of `avatars/<avatarId>/history.jsonl`: a scene's location and outfit. */
export const HistoryEntrySchema = z.object({
  location: NonEmpty,
  outfit: NonEmpty,
  at: IsoTimestamp,
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

/** One line of `avatars/<avatarId>/rejected.jsonl`: the owner's own mark on a photo, or its restore. */
export const RejectedEntrySchema = z.object({
  photoId: LibraryIdSchema,
  op: z.enum(["reject", "restore"]),
  at: IsoTimestamp,
});
export type RejectedEntry = z.infer<typeof RejectedEntrySchema>;

/**
 * `<root>/refused-imports.json` (T6c, H2): the sha256 of every imported
 * photo's raw bytes the mandatory one-time image age check has already
 * refused. Read at library open, written atomically (temp + fsync +
 * rename), so `import.stagePhoto` can refuse a known-refused photo for free
 * on a re-pick, before anything is downscaled or paid for.
 */
export const RefusedImportsFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sha256: z.array(Sha256Hex),
});
export type RefusedImportsFile = z.infer<typeof RefusedImportsFileSchema>;

/** `avatars/<avatarId>/photos/<id>.json` — the commit record of one photo. */
export const PhotoSidecarSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: LibraryIdSchema,
    avatarId: LibraryIdSchema,
    file: NonEmpty,
    mediaType: z.enum(IMAGE_MEDIA_TYPES),
    width: z.int().positive(),
    height: z.int().positive(),
    bytes: z.int().positive(),
    /** Of the image file; checked with `bytes` on every open. */
    sha256: Sha256Hex,
    source: PhotoSourceSchema,
    qa: PhotoQaSchema,
    createdAt: IsoTimestamp,
  })
  .refine((s) => s.file === `${s.id}.${extensionFor(s.mediaType)}`, {
    message: "file must be <id>.<extension of mediaType>",
    path: ["file"],
  });
export type PhotoSidecar = z.infer<typeof PhotoSidecarSchema>;
