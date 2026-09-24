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

/** Where a photo came from. Only generated frames exist — there is no kind
 *  for a user-supplied file, so none can ever become a reference (invariant 9). */
export const PhotoSourceSchema = z.object({
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
export type PhotoSource = z.infer<typeof PhotoSourceSchema>;

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

/** One line of `avatars/<avatarId>/used.jsonl`. */
export const UsedEntrySchema = z.object({
  photoId: LibraryIdSchema,
  videoId: LibraryIdSchema,
  at: IsoTimestamp,
});
export type UsedEntry = z.infer<typeof UsedEntrySchema>;

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
