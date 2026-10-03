import { basename } from "node:path";
import {
  AvatarName,
  AvatarSummary,
  AvatarTraits,
  Draft,
  MAX_UNREADABLE_AVATARS,
  UNREADABLE_REASON_DETAIL,
  type AvatarUsage,
  type UnreadableAvatar,
  type UnreadableReason,
} from "../../shared/engine";
import { isLibraryId, type Library, type QuarantineEntry } from "../library";
import type { AvatarManifest, PhotoSidecar, TraitValue } from "../library/schemas";
import { looksLikeRunPhoto } from "../library/photoRecords";
import { passesAgeThreshold } from "./ageCheck";

/** The two skip reasons `libraryView` can tell apart; the third, `manifest-unreadable`, never reaches here — see engine.ts. */
export type SkippedReason = Exclude<UnreadableReason, "manifest-unreadable">;

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
 * given order, minus any whose stored age-check verdict no longer passes
 * today's threshold (a later, stricter calibration; `passesAgeThreshold`,
 * ageCheck.ts) — so pick is never asked for something the UI never offered.
 * The next batch's estimate is left null: pricing is the avatar jobs'
 * business. Null for a saved avatar or a record the contract refuses.
 */
export function draftFrom(manifest: AvatarManifest, photos: readonly PhotoSidecar[]): Draft | null {
  if (manifest.status !== "draft") return null;
  const traits = traitsFrom(manifest);
  if (traits === null) return null;
  const shown = photos.filter((p) => passesAgeThreshold(p.qa.age));
  const parsed = Draft.safeParse({
    avatarId: manifest.id,
    traits,
    descriptor: descriptorOf(manifest),
    candidates: shown.map((p) => ({ avatarId: p.avatarId, photoId: p.id })),
    // The photos below-threshold are still on disk; only their count is
    // told apart from "never generated" (candidates: [] either way).
    hiddenBelowThreshold: photos.length - shown.length,
    estimate: null,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * `AvatarSummary.photoCount`: the avatar's gallery photos, the same set
 * `photos.list` shows (`looksLikeRunPhoto`, so a run photo the contract
 * cannot list still counts, as the gallery's own "skipped" tally does). The
 * master portrait, unpicked candidates and imported photos are not gallery
 * photos.
 */
export function galleryPhotoCount(library: Pick<Library, "photosByAvatar">, avatarId: string): number {
  return library.photosByAvatar(avatarId).filter(looksLikeRunPhoto).length;
}

/** The counts an avatar tile shows, all derived: photos, video records and the photos a montage may still use. */
export interface AvatarCounts {
  photoCount: number;
  videoCount: number;
  eligibleUnusedCount: number;
  /** Whether the counts can be trusted, and if not why (3e.2, K16). */
  usage: AvatarUsage;
}

/**
 * The avatar's counts from the library, every one through the library's own
 * answers: the gallery photos, the video records (whatever state their files
 * are in) and `eligibleUnusedCount` (the one eligibility rule, minus used,
 * minus reserved; 0 while the avatar's video records cannot all be read, so a
 * listing never fails over it), and the reasons it cannot vouch for that
 * usage (`usage`), read at the same moment.
 */
export function avatarCounts(library: Pick<Library, "photosByAvatar" | "videoCount" | "eligibleUnusedCount" | "usageReasons">, avatarId: string): AvatarCounts {
  const [first, ...rest] = library.usageReasons(avatarId);
  return {
    photoCount: galleryPhotoCount(library, avatarId),
    videoCount: library.videoCount(avatarId),
    eligibleUnusedCount: library.eligibleUnusedCount(avatarId),
    usage: first === undefined ? { state: "ok" } : { state: "unknown", reasons: [first, ...rest] },
  };
}

/** A saved avatar as the grid lists it; null for a draft or a record the contract refuses. */
export function avatarSummaryFrom(manifest: AvatarManifest, counts: AvatarCounts): AvatarSummary | null {
  if (manifest.status === "draft") return null;
  const parsed = AvatarSummary.safeParse({
    avatarId: manifest.id,
    name: manifest.name,
    descriptor: descriptorOf(manifest),
    masterPhotoId: manifest.masterPhotoId,
    createdAt: manifest.createdAt,
    status: manifest.status,
    photoCount: counts.photoCount,
    videoCount: counts.videoCount,
    eligibleUnusedCount: counts.eligibleUnusedCount,
    usage: counts.usage,
  });
  return parsed.success ? parsed.data : null;
}

/** An avatar record the contract refuses, with which of the two known causes it is. */
export interface SkippedAvatar {
  avatarId: string;
  /** The manifest's own name, when it still fits `AvatarName`; null when even the name no longer fits the contract. The manifest itself was always read here — see `unreadableFromQuarantine` for the case where it was not. */
  name: string | null;
  reason: SkippedReason;
}

export interface LibraryView {
  avatars: AvatarSummary[];
  drafts: Draft[];
  /** Avatars the contract refuses (e.g. free-form traits of an early library, or a descriptor today's rules no longer accept). */
  skipped: SkippedAvatar[];
}

/** A descriptor that always passes `AvatarDescriptor` for `age`: used only to test whether a record would fit the contract with a valid descriptor in place of its stored one — never stored, sent to a model, or shown. */
function placeholderDescriptor(age: number): string {
  return `${age}-year-old placeholder woman.`;
}

/**
 * Whether `avatars.rewriteDescriptor` could recover `manifest`: its traits
 * are typed and still fit the contract (schema version 2, `AvatarTraits`
 * parses — the vibe included, since a vibe that now fails even the lenient
 * hard-marker check leaves nothing valid to feed the descriptor job), and,
 * with a placeholder descriptor that always passes `AvatarDescriptor` stood
 * in for its stored one, the record would fit `draftFrom`/`avatarSummaryFrom`
 * (the `AvatarName` ≤60 rule included). Says nothing about whether the
 * stored descriptor itself needs rewriting — only whether rewriting it could
 * ever help.
 */
export function isRewritable(manifest: AvatarManifest): boolean {
  if (manifest.schemaVersion < 2) return false;
  if (!AvatarTraits.safeParse({ ...manifest.traits, age: manifest.age }).success) return false;
  const withPlaceholder = { ...manifest, descriptor: placeholderDescriptor(manifest.age) };
  return manifest.status === "draft" ? draftFrom(withPlaceholder, []) !== null : avatarSummaryFrom(withPlaceholder, { photoCount: 0, videoCount: 0, eligibleUnusedCount: 0, usage: { state: "ok" } }) !== null;
}

/**
 * The manifest's own name, as `SkippedAvatar.name` and the unreadable
 * contract entry carry it: `manifest.name` when it still fits `AvatarName`
 * (the same schema `AvatarSummary`'s own name uses), null otherwise — a
 * manifest whose name alone no longer fits today's rules (e.g. over 60
 * chars), independently of whether its descriptor or traits do.
 */
function skippedNameOf(manifest: AvatarManifest): string | null {
  const parsed = AvatarName.safeParse(manifest.name);
  return parsed.success ? parsed.data : null;
}

/**
 * Why `manifest` could not be listed as a draft or a saved avatar:
 * `descriptor-invalid` when rewriting the stored descriptor alone would fix
 * it (`isRewritable`); `contract-mismatch` for everything else (untyped
 * traits, a vibe that no longer parses, a name over 60 chars, ...) —
 * whatever its own stored descriptor says, since no descriptor could recover it.
 */
function skipReason(manifest: AvatarManifest): SkippedReason {
  return isRewritable(manifest) ? "descriptor-invalid" : "contract-mismatch";
}

/** Saved avatars and drafts from the library's in-memory index, oldest first. */
export function libraryView(library: Library): LibraryView {
  const view: LibraryView = { avatars: [], drafts: [], skipped: [] };
  for (const manifest of library.listAvatars()) {
    if (manifest.status === "draft") {
      const draft = draftFrom(manifest, library.photosByAvatar(manifest.id));
      if (draft === null) view.skipped.push({ avatarId: manifest.id, name: skippedNameOf(manifest), reason: skipReason(manifest) });
      else view.drafts.push(draft);
    } else {
      const avatar = avatarSummaryFrom(manifest, avatarCounts(library, manifest.id));
      if (avatar === null) view.skipped.push({ avatarId: manifest.id, name: skippedNameOf(manifest), reason: skipReason(manifest) });
      else view.avatars.push(avatar);
    }
  }
  return view;
}

/**
 * The library's `invalid-manifest` quarantine entries (a whole avatar folder
 * moved out at open, before it ever reached the in-memory index) as the
 * contract's unreadable list: the folder name is the id `survey.ts` already
 * checked, so it is dropped only when that check somehow fails. `detail` is
 * always the reason's fixed sentence — never the quarantine's own detail,
 * which may hold a stray value read straight out of the corrupt manifest.
 */
export function unreadableFromQuarantine(entries: readonly QuarantineEntry[], max = MAX_UNREADABLE_AVATARS): UnreadableAvatar[] {
  return entries
    .filter((e) => e.reason === "invalid-manifest")
    .slice(0, max)
    .map((e) => {
      const id = basename(e.from);
      return { avatarId: isLibraryId(id) ? id : null, name: null, reason: "manifest-unreadable", detail: UNREADABLE_REASON_DETAIL["manifest-unreadable"] };
    });
}

/** A `descriptor-invalid` entry (the only one `avatars.rewriteDescriptor` can act on) must survive the bound ahead of everything else: a library with many quarantined or otherwise-broken folders must never push a fixable one off the list. */
const REASON_PRIORITY: Record<UnreadableReason, number> = { "descriptor-invalid": 0, "contract-mismatch": 1, "manifest-unreadable": 2 };

/**
 * `fromLibrary` (this call's skipped avatars, already classified) and
 * `fromQuarantine` (this library's fixed quarantine list), combined with
 * `descriptor-invalid` first (L2) and bounded at `max` (L1/L11). A stable
 * sort keeps each priority's own order (oldest avatar first, since both
 * inputs are already oldest-first).
 */
export function combineUnreadable(
  fromLibrary: readonly UnreadableAvatar[],
  fromQuarantine: readonly UnreadableAvatar[],
  max = MAX_UNREADABLE_AVATARS,
): UnreadableAvatar[] {
  return [...fromLibrary, ...fromQuarantine].sort((a, b) => REASON_PRIORITY[a.reason] - REASON_PRIORITY[b.reason]).slice(0, max);
}
