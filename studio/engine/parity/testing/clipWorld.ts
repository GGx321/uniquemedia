import type { PhotoQaSummary } from "../../../shared/engine";

// Stage 5, 5b.1, S5.V7: the avatar of the clip stories, ONE definition for both rigs. Lia is an active avatar whose photos tell the clip rules apart. A photo with no run plan on disk is judged by its own face
// marks (engine/clips/frameFacts.ts, `planlessFacts`), which is what the mock plays: so a photo is «a frame with a likeness» (three code motions), «a frame whose face is not known to show» (no
// motion), a frame of «Смелая» (nightwear), a frame the age check did not call adult, a frame the face gate marked (never judged), a landscape one (not vertical) and one whose file no longer matches
// its sidecar (unreadable). The real rig seeds real JPEGs; the mock is seeded with the same summaries.

export const CLIP_AVATAR_NAME = "Lia";
export const MOCK_CLIP_AVATAR_ID = "avatar-lia-0007";
export const MOCK_CLIP_MASTER_ID = "photo-lia-master";

export const CLIP_PHOTO_KINDS = ["plain", "unknown", "bold", "aged", "hidden", "landscape", "unreadable"] as const;
export type ClipPhotoKind = (typeof CLIP_PHOTO_KINDS)[number];

export interface ClipPhotoSpec {
  readonly category: "home" | "nightwear";
  readonly qa: PhotoQaSummary;
  /** A 1280 x 720 picture: the first frame of a clip is 9:16. */
  readonly landscape?: true;
}

export const CLIP_PHOTO_SPEC: Readonly<Record<ClipPhotoKind, ClipPhotoSpec>> = {
  plain: { category: "home", qa: { faceCos: 0.86 } },
  unknown: { category: "home", qa: {} },
  bold: { category: "nightwear", qa: { faceCos: 0.86 } },
  aged: { category: "home", qa: { faceCos: 0.7, age: { adult: false, confidence: 0.9 } } },
  hidden: { category: "home", qa: { faceCos: 0.48, faceMarked: true } },
  landscape: { category: "home", qa: { faceCos: 0.86 }, landscape: true },
  unreadable: { category: "home", qa: { faceCos: 0.86 } },
};

/** The ids a story needs: the avatar, its master (not a gallery photo) and a photo of each kind. */
export interface ClipWorld {
  readonly avatarId: string;
  readonly masterPhotoId: string;
  readonly photos: Readonly<Record<ClipPhotoKind, string>>;
}

export function mockClipPhotoId(kind: ClipPhotoKind): string {
  return `photo-lia-${kind}`;
}

/** The photo of each kind, by `idOf`. */
export function clipPhotoMap(idOf: (kind: ClipPhotoKind) => string): Record<ClipPhotoKind, string> {
  return { plain: idOf("plain"), unknown: idOf("unknown"), bold: idOf("bold"), aged: idOf("aged"), hidden: idOf("hidden"), landscape: idOf("landscape"), unreadable: idOf("unreadable") };
}
