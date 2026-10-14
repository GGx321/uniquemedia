import type { MediaSummary } from "../../shared/engine";
import { EngineFailure } from "../engineFailure";

// Stage 5, 5b.2, S5.WA2 (plan s5b2 §5.1.2, I5.59, r2.1 N5): how long a clip's montage copy lives. A copy is made on first use, one per clip, and goes with the clip:
//   - a `clips.delete` removes the clip's copy FIRST (the caller holds the clip's lock), and the clip only then; a render that holds the copy makes the delete IN_FLIGHT `in-use`, with nothing removed;
//   - an avatar delete removes the avatar's copies only at the `trashed` outcome, asynchronously, after the avatar was forgotten (never at `kept`, never inside the synchronous finish);
//   - a copy that is left behind (a failure there, a crash) is swept at the next library open: a copy whose `origin.avatarId` names no avatar of the library AND whose folder `avatars/<id>/` is really
//     gone from the disk. An avatar the index lacks but whose folder is still there (a manifest that did not read) keeps its copies.
// A copy is never shown in «Мои» and never deleted by hand, so nothing else removes one.

/** What the copy rules need of the media service. */
export interface ClipCopyMedia {
  /** Every live copy of an avatar's clip (normally one). */
  copiesOfClip(avatarId: string, clipId: string): Promise<MediaSummary[]>;
  /**
   * Every copy of the library (the live one, or the one at `root`: the sweep reads the library it was started for and holds nothing); `readable` is false when the library's own media folder could
   * not be read (then the list says nothing).
   */
  copies(root?: string): Promise<{ readable: boolean; copies: MediaSummary[] }>;
  /** `media.delete`'s path: `in-use` while a queued or running render holds the media. */
  deleteMedia(mediaId: string): Promise<"deleted" | "not-found" | "in-use">;
}

/** Whether an avatar's folder is on the disk right now. `unknown`: it could not be looked at (the copy is then kept). */
export type AvatarFolderState = "there" | "gone" | "unknown";

/** The library as the sweep needs it. */
export interface KnownAvatars {
  /** The library's root: the sweep lists the copies of this library. */
  readonly root: string;
  /** The avatar is in the library's index. */
  has(avatarId: string): boolean;
  /** Whether `avatars/<avatarId>/` is on the disk, whatever the index says. */
  folderState(avatarId: string): Promise<AvatarFolderState>;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** A saved draft as the draft uses of a clip need it: its name and, per clip, the media an own video clip names. */
export interface DraftView {
  readonly name: string | null;
  readonly clips: readonly { readonly kind: string; readonly mediaId?: string | undefined }[];
}

/** How many saved drafts hold a copy of a clip, and, for exactly one, which draft and which clip of it (1-based): `ClipUse.inDrafts`. */
export interface DraftUse {
  readonly count: number;
  readonly first?: { readonly name: string | null; readonly frame: number };
}

export class ClipCopies {
  readonly #media: ClipCopyMedia;
  readonly #drafts: ((avatarId: string) => Promise<readonly DraftView[]>) | undefined;
  readonly #log: (line: string) => void;

  constructor(deps: { media: ClipCopyMedia; drafts?: (avatarId: string) => Promise<readonly DraftView[]>; log: (line: string) => void }) {
    this.#media = deps.media;
    this.#drafts = deps.drafts;
    this.#log = deps.log;
  }

  /**
   * How many saved drafts of the avatar hold each clip's copy, by clip id (`ClipUse.inDrafts`, the delete dialog's warning). A draft counts once per clip however often it holds the copy; `first` is
   * set ONLY when exactly one draft holds it (the dialog names a draft only then): that draft's name (null when it has none) and the 1-based place of the clip in it. A clip no draft holds has no entry.
   * The drafts are read only when the avatar has a copy at all; drafts or media that cannot be read say nothing (logged, never thrown): the warning is a help, not a gate.
   */
  async draftUsesOf(avatarId: string): Promise<ReadonlyMap<string, DraftUse>> {
    const uses = new Map<string, DraftUse>();
    if (this.#drafts === undefined) return uses;
    try {
      const copies = (await this.#media.copies()).copies.filter((copy) => copy.origin?.avatarId === avatarId);
      if (copies.length === 0) return uses;
      const clipOfMedia = new Map(copies.flatMap((copy) => (copy.origin === undefined ? [] : [[copy.mediaId, copy.origin.clipId] as const])));
      const holders = new Map<string, { name: string | null; frame: number }[]>();
      for (const draft of await this.#drafts(avatarId)) {
        const placed = new Map<string, number>();
        draft.clips.forEach((clip, index) => {
          const clipId = clip.kind === "video" && clip.mediaId !== undefined ? clipOfMedia.get(clip.mediaId) : undefined;
          if (clipId !== undefined && !placed.has(clipId)) placed.set(clipId, index + 1);
        });
        for (const [clipId, frame] of placed) holders.set(clipId, [...(holders.get(clipId) ?? []), { name: draft.name, frame }]);
      }
      for (const [clipId, held] of holders) {
        const only = held.length === 1 ? held[0] : undefined;
        uses.set(clipId, only === undefined ? { count: held.length } : { count: 1, first: only });
      }
    } catch (error) {
      this.#log(`[clip] the drafts that hold clip copies could not be read (${errorName(error)})`);
      return new Map();
    }
    return uses;
  }

  /**
   * Removes EVERY copy of the avatar's clip (normally one): true when one was removed. IN_FLIGHT `in-use` when a render holds one (the clip stays); INTERNAL when the disk fails, so the caller
   * deletes nothing of the clip either. A copy that vanished meanwhile is no error.
   */
  async removeOfClip(avatarId: string, clipId: string): Promise<boolean> {
    let removed = false;
    for (const copy of await this.#media.copiesOfClip(avatarId, clipId)) {
      let outcome: Awaited<ReturnType<ClipCopyMedia["deleteMedia"]>>;
      try {
        outcome = await this.#media.deleteMedia(copy.mediaId);
      } catch (error) {
        if (error instanceof EngineFailure) throw error;
        this.#log(`[clip] ${clipId}: its montage copy could not be removed (${errorName(error)})`);
        throw new EngineFailure({ code: "INTERNAL", detail: "the clip's copy for the montage could not be removed" });
      }
      if (outcome === "in-use") throw new EngineFailure({ code: "IN_FLIGHT", clipReason: "in-use", detail: `a render holds the montage copy of clip ${clipId}` });
      if (outcome === "deleted") removed = true;
    }
    return removed;
  }

  /**
   * Removes every copy of an avatar's clips (the avatar went to the Trash). Never throws: a copy that cannot go now (a render holds it, the disk fails) is logged and left for the next
   * library open's sweep.
   */
  async removeOfAvatar(avatarId: string): Promise<void> {
    let copies: MediaSummary[];
    try {
      copies = (await this.#media.copies()).copies.filter((copy) => copy.origin?.avatarId === avatarId);
    } catch (error) {
      this.#log(`[clip] the copies of a deleted avatar could not be listed (${errorName(error)}); the next library open sweeps them`);
      return;
    }
    for (const copy of copies) await this.#removeQuietly(copy, "left");
  }

  /**
   * The library-open sweep: removes the copies whose avatar is not in the library AND whose folder is gone from the disk. Returns how many it removed. Never throws, and removes nothing when the
   * library's media cannot be read.
   */
  async sweep(avatars: KnownAvatars): Promise<number> {
    let listed: Awaited<ReturnType<ClipCopyMedia["copies"]>>;
    try {
      listed = await this.#media.copies(avatars.root);
    } catch (error) {
      this.#log(`[clip] the montage copies could not be listed for the sweep (${errorName(error)})`);
      return 0;
    }
    if (!listed.readable) return 0;
    const folders = new Map<string, Promise<AvatarFolderState>>();
    let removed = 0;
    for (const copy of listed.copies) {
      const avatarId = copy.origin?.avatarId;
      if (avatarId === undefined || avatars.has(avatarId)) continue;
      let state = folders.get(avatarId);
      if (state === undefined) {
        state = avatars.folderState(avatarId).catch((): AvatarFolderState => "unknown");
        folders.set(avatarId, state);
      }
      const folder = await state;
      if (folder === "there") {
        this.#log(`[clip] a montage copy names avatar ${avatarId}, which the library did not list but whose folder is on the disk; it is kept`);
        continue;
      }
      if (folder === "unknown") continue;
      if (await this.#removeQuietly(copy, "kept for the next sweep")) removed++;
    }
    return removed;
  }

  /** Removes one copy; true when it went. A copy that is held or whose removal fails is logged and stays. */
  async #removeQuietly(copy: MediaSummary, what: string): Promise<boolean> {
    try {
      const outcome = await this.#media.deleteMedia(copy.mediaId);
      if (outcome === "in-use") {
        this.#log(`[clip] a montage copy is held by a render and is ${what}`);
        return false;
      }
      return outcome === "deleted";
    } catch (error) {
      this.#log(`[clip] a montage copy could not be removed (${errorName(error)}) and is ${what}`);
      return false;
    }
  }
}
