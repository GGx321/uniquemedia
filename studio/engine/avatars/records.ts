import { AvatarSummary, AvatarTraits, Draft } from "../../shared/engine";
import type { Library } from "../library";
import type { AvatarManifest, PhotoSidecar, TraitValue } from "../library/schemas";

// The library (T4) keeps an avatar's traits as a record of JSON-typed values
// and its descriptor as plain text; the contract (T0) has typed traits and a
// descriptor with its age. This is the one place that maps between them.
// Every record is parsed with the contract's schema on the way out, so a
// manifest the contract refuses is counted as unreadable instead of breaking
// a snapshot.

/**
 * How a draft's traits are stored in `avatar.json` (manifest version 2):
 * every trait as it is, marks as a list. The age is not in here: the
 * manifest has its own.
 */
export function manifestTraits(traits: AvatarTraits): Record<string, TraitValue> {
  const { age: _age, ...rest } = traits;
  return rest;
}

function traitsFrom(manifest: AvatarManifest): AvatarTraits | null {
  const parsed = AvatarTraits.safeParse({ ...manifest.traits, age: manifest.age });
  return parsed.success ? parsed.data : null;
}

function descriptorOf(manifest: AvatarManifest): { age: number; text: string } {
  return { age: manifest.age, text: manifest.descriptor };
}

/**
 * A draft as the contract lists it: its candidates are its photos in the
 * given order. The next batch's estimate is left null: pricing is the avatar
 * jobs' business. Null for a saved avatar or a record the contract refuses.
 */
export function draftFrom(manifest: AvatarManifest, photos: readonly PhotoSidecar[]): Draft | null {
  if (manifest.status !== "draft") return null;
  const traits = traitsFrom(manifest);
  if (traits === null) return null;
  const parsed = Draft.safeParse({
    avatarId: manifest.id,
    traits,
    descriptor: descriptorOf(manifest),
    candidates: photos.map((p) => ({ avatarId: p.avatarId, photoId: p.id })),
    estimate: null,
  });
  return parsed.success ? parsed.data : null;
}

/** A saved avatar as the grid lists it; null for a draft or a record the contract refuses. */
export function avatarSummaryFrom(manifest: AvatarManifest, photoCount: number): AvatarSummary | null {
  if (manifest.status === "draft") return null;
  const parsed = AvatarSummary.safeParse({
    avatarId: manifest.id,
    name: manifest.name,
    descriptor: descriptorOf(manifest),
    masterPhotoId: manifest.masterPhotoId,
    createdAt: manifest.createdAt,
    status: manifest.status,
    photoCount,
  });
  return parsed.success ? parsed.data : null;
}

export interface LibraryView {
  avatars: AvatarSummary[];
  drafts: Draft[];
  /** Ids of the avatars the contract refuses (e.g. free-form traits of an early library). */
  skipped: string[];
}

/** Saved avatars and drafts from the library's in-memory index, oldest first. */
export function libraryView(library: Library): LibraryView {
  const view: LibraryView = { avatars: [], drafts: [], skipped: [] };
  for (const manifest of library.listAvatars()) {
    if (manifest.status === "draft") {
      const draft = draftFrom(manifest, library.photosByAvatar(manifest.id));
      if (draft === null) view.skipped.push(manifest.id);
      else view.drafts.push(draft);
    } else {
      const avatar = avatarSummaryFrom(manifest, library.photoCount(manifest.id));
      if (avatar === null) view.skipped.push(manifest.id);
      else view.avatars.push(avatar);
    }
  }
  return view;
}
