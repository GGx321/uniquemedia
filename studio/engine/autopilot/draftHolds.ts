// Stage 4 (plan §5.1, §19, A7): the photos any saved montage draft holds, as the launch needs them. A draft reserves nothing, so a photo it names could be taken for a launch video and
// the owner's own render of the draft would then hit PHOTO_UNAVAILABLE. THE ONE definition: the estimate, the start and the free steps all read it here, from S4.5c's
// `DraftStore.photoIdsInDrafts` (per avatar; `complete` is false when a draft file could not be read, and the call throws `DraftFolderError` when the folder cannot be listed).
//
// It fails closed PER AVATAR. An avatar whose drafts are not fully known has NO library photo in this launch (`PlanAvatarInput.draftsKnown`); the other avatars are unaffected, and the
// photos a partial listing did name stay held.

export type DraftHoldsReader = (avatarId: string) => Promise<{ photoIds: ReadonlySet<string>; complete: boolean }>;

export interface DraftHolds {
  /** The union, over the asked avatars, of the photos their drafts name. */
  held: ReadonlySet<string>;
  /** The avatars whose drafts could not be listed in full. */
  unknown: ReadonlySet<string>;
}

export async function readDraftHolds(avatarIds: readonly string[], read: DraftHoldsReader): Promise<DraftHolds> {
  const held = new Set<string>();
  const unknown = new Set<string>();
  for (const avatarId of avatarIds) {
    try {
      const answer = await read(avatarId);
      for (const photoId of answer.photoIds) held.add(photoId);
      if (!answer.complete) unknown.add(avatarId);
    } catch {
      // Whatever the reason (a folder that cannot be listed, a disk that does not answer), the drafts of this avatar are not known.
      unknown.add(avatarId);
    }
  }
  return { held, unknown };
}
