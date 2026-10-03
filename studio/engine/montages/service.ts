import { randomInt } from "node:crypto";
import { DRAFT_CHANGING_DETAIL, DRAFT_TOO_NEW_DETAIL, PROTOCOL_VERSION, type CommandPayload, type CommandResult, type UnsequencedEvent } from "../../shared/engine";
import { MAX_CLIPS, MAX_LISTED_MONTAGES, Montage, type Focus, type MontageIssue } from "../../shared/engine/montage";
import { defaultSpec } from "../../shared/montage";
import { EngineFailure } from "../engineFailure";
import type { FocusResolver } from "../focus/focusResolver";
import type { Library } from "../library";
import { photoAvailability, type Availability } from "./availability";
import type { TrackLookup } from "../music/renderTrack";
import { draftIssues } from "./issues";
import { DraftFolderError, DraftNotAFileError, type DraftRead, type DraftStore } from "./store";

// The montage drafts (Stage 3 plan, 3d.1a): `montages.create`, `get`, `list`, `save`, `delete` and `focus`. The engine
// wires it; the library, the focus resolver, the disk (through `DraftStore`) and the clock come in as dependencies, so each
// mapping is tested with a fake.
//
// A draft is the owner's work in progress: it may be incomplete (no clips, any total length, a photo that was rejected since),
// and nothing about it is reserved or counted as "used". Only a render (`videos.render`) needs a complete spec.
//
// Every write to one draft goes through the store's per-draft queue (`exclusive`), which is entered SYNCHRONOUSLY when a
// command arrives: two saves of one draft are applied in the order they arrived, the last one wins, and a save that
// arrives after a delete finds nothing and is NOT_FOUND. The renderer serialises its own saves on top (3d.2); the engine
// does not depend on that.
//
// `montages.create` asks the focus of all its photos at the SAME TIME under ONE budget. Main answers a command that takes
// longer than 30 s with a timeout, so the budget is what is left of `MONTAGE_COMMAND_DEADLINE_MS` after a margin for
// the rest of the command (its checks, the write, the announcement), and at most `MONTAGE_FOCUS_BUDGET_MS`. A photo whose
// focus was not judged in time, or could not be, is stored as `null` (legal in a draft; the preview draws the stand-in
// point and a render tries again).

/** Under main's 30 s command deadline (`REQUEST_TIMEOUT_MS`), with room for the answer to travel. */
export const MONTAGE_COMMAND_DEADLINE_MS = 25_000;
/** Kept back from the deadline for what follows the focus: the second look at the photos, the write and the announcement. */
export const MONTAGE_COMMAND_MARGIN_MS = 5_000;
/** What one `montages.create` or `montages.focus` may spend on the focus of its photos: the resolver's own bound for one detect. */
export const MONTAGE_FOCUS_BUDGET_MS = 20_000;

export interface MontageServiceDeps {
  readonly store: DraftStore;
  /** Runs `work` with the live library, counted as a write so a library switch cannot land inside it; throws the engine's own refusal (LIBRARY_UNAVAILABLE, IN_FLIGHT) when there is none. */
  readonly withLibrary: <T>(work: (library: Library) => Promise<T>) => Promise<T>;
  /** The open library, unchecked (reads only); null when none. */
  readonly openLibrary: () => Library | null;
  /** The focus resolver of `library`. */
  readonly focus: (library: Library) => Pick<FocusResolver, "focusFor">;
  /** What the track store holds (3c.5): a draft's trending track is judged against it. Absent: no track is held. */
  readonly tracks?: TrackLookup;
  readonly newId: () => string;
  readonly now: () => Date;
  /** The variety seed of a new draft (a uint32); a random one when absent. */
  readonly randomSeed?: () => number;
  readonly emit: (event: UnsequencedEvent) => void;
  /** Codes and counts only: never a path, a message or a file's text. */
  readonly log: (line: string) => void;
  /** From entry to a command's answer; `MONTAGE_COMMAND_DEADLINE_MS` when absent. */
  readonly commandDeadlineMs?: number;
  /** What is kept back from that deadline for the rest of a command after the focus; `MONTAGE_COMMAND_MARGIN_MS` when absent. */
  readonly commandMarginMs?: number;
  /** The most the focus of a command's photos may take; `MONTAGE_FOCUS_BUDGET_MS` when absent. */
  readonly focusBudgetMs?: number;
}

/** How many times `create` looks for an id no draft has before it gives up (a random id never collides; a broken generator must not loop). */
const ID_ATTEMPTS = 8;

/** What may be logged of an error: its class or errno code. Never its message (it may name the owner's paths). */
function kindOf(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  return "code" in error && typeof error.code === "string" ? error.code : error.name;
}

/** A draft file that is there and cannot be used, told by its reason code alone (never a path or the file's text). */
function unreadable(read: Exclude<DraftRead, { kind: "ok" }>, montageId: string): EngineFailure {
  if (read.kind === "missing") return new EngineFailure({ code: "NOT_FOUND", detail: `no montage draft ${montageId}` });
  if (read.reason === "changing") return new EngineFailure({ code: "INTERNAL", detail: DRAFT_CHANGING_DETAIL });
  if (read.reason === "too-new") return new EngineFailure({ code: "INTERNAL", detail: DRAFT_TOO_NEW_DETAIL });
  return new EngineFailure({ code: "INTERNAL", detail: `the draft cannot be read (${read.reason})` });
}

/**
 * A save's `updatedAt`: the clock's now, but always after the stamp it replaces (by 1 ms at least). The wall clock can
 * go back (an NTP step, a clock corrected), and a library in a synced folder may hold drafts stamped by a machine whose
 * clock ran ahead: the draft's own stamps still only move forward. Compared as instants, never as text (an ISO stamp
 * may come in another precision: «…:00Z» sorts after «…:00.000Z» as text).
 */
function nextStamp(now: Date, stored: string): string {
  const after = Date.parse(stored) + 1;
  return new Date(Number.isNaN(after) ? now.getTime() : Math.max(now.getTime(), after)).toISOString();
}

const libraryUnavailable = (): EngineFailure => new EngineFailure({ code: "LIBRARY_UNAVAILABLE", detail: "no library is open: its folder is missing or unreadable; choose one in Settings" });

export class MontageService {
  readonly #deps: MontageServiceDeps;
  /** Avatars whose untrusted usage was already logged. */
  readonly #untrustedLogged = new Set<string>();

  constructor(deps: MontageServiceDeps) {
    this.#deps = deps;
  }

  // ---------- montages.create ----------

  async create(payload: CommandPayload<"montages.create">): Promise<CommandResult<"montages.create">> {
    const entered = performance.now();
    const { avatarId, photoIds } = payload;
    // The contract already refuses both; the service is also called by code that did not go through it.
    if (photoIds.length > MAX_CLIPS) throw new EngineFailure({ code: "VALIDATION", detail: `at most ${MAX_CLIPS} photos, got ${photoIds.length}` });
    if (new Set(photoIds).size !== photoIds.length) throw new EngineFailure({ code: "VALIDATION", detail: "a photo can appear only once in a montage" });
    return this.#deps.withLibrary(async (library) => {
      const avatar = library.getAvatar(avatarId);
      // Only an ACTIVE avatar has scene photos to put in a montage, and an archived one is retired: like `videos.render`.
      if (avatar === undefined || avatar.status !== "active") throw new EngineFailure({ code: "NOT_FOUND", detail: `no active avatar ${avatarId} in the open library` });

      if (photoIds.length > 0) this.#assertPhotosFree(library, avatarId, photoIds);

      const montageId = await this.#freshId(library);
      const focuses = photoIds.length === 0 ? [] : await this.#focusAll(library, avatarId, photoIds, this.#focusBudget(entered), "montages.create");
      // A photo may have been rejected, or taken by a render, while its focus was being judged: look again. Everything from
      // here to queueing the write is synchronous (the id was taken above), so no event of the engine can land in between and
      // nothing is stored for a photo the owner just put out of reach.
      if (photoIds.length > 0) this.#assertPhotosFree(library, avatarId, photoIds);

      const spec = defaultSpec(avatarId, photoIds, this.#seed());
      const montage = Montage.parse({ montageId, name: null, spec: withFocus(spec, new Map(photoIds.map((id, i) => [id, focuses[i] ?? null]))), updatedAt: this.#deps.now().toISOString() });
      await this.#deps.store.exclusive(montage.montageId, () => this.#write(library, montage));
      this.#announceUpsert(montage);
      return { montage };
    });
  }

  /** The most the focus of the photos may take: the configured budget, and no more than what the command's deadline leaves after the margin. */
  #focusBudget(entered: number): number {
    const deadline = this.#deps.commandDeadlineMs ?? MONTAGE_COMMAND_DEADLINE_MS;
    const margin = this.#deps.commandMarginMs ?? MONTAGE_COMMAND_MARGIN_MS;
    const left = deadline - (performance.now() - entered) - margin;
    return Math.max(0, Math.min(this.#deps.focusBudgetMs ?? MONTAGE_FOCUS_BUDGET_MS, left));
  }

  /**
   * The focus of every photo, asked all at once under ONE budget: each photo's answer is raced against the same timer, so
   * a resolver that never answers (or ignores its signal) costs the budget once, not once per photo. The point of a photo
   * that was judged, or `null` for one that was not (unresolved, failed, or not done in time).
   */
  async #focusAll(library: Library, avatarId: string, photoIds: readonly string[], budgetMs: number, command: string): Promise<(Focus | null)[]> {
    const resolver = this.#deps.focus(library);
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<"late">((resolve) => {
      timer = setTimeout(() => {
        resolve("late");
        stop.abort(new Error("the focus budget of this command is spent"));
      }, budgetMs);
    });
    try {
      const focuses = await Promise.all(
        photoIds.map(async (photoId): Promise<Focus | null> => {
          // Never rejects, so a photo that loses the race to the budget cannot leave an unhandled rejection behind.
          const judged = (async (): Promise<Focus | null> => {
            try {
              const answer = await resolver.focusFor(avatarId, photoId, stop.signal);
              return answer.resolved ? answer.focus : null;
            } catch {
              return null;
            }
          })();
          const outcome = await Promise.race([judged, budget]);
          return outcome === "late" ? null : outcome;
        }),
      );
      const unresolved = focuses.filter((focus) => focus === null).length;
      if (unresolved > 0) this.#deps.log(`${command}: ${unresolved} of ${photoIds.length} photo(s) could not be judged for their focus; they are answered without one`);
      return focuses;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * K11: refuses, with the index of each in `photoIds`, a photo that is not an eligible, unused, unreserved scene photo of
   * this avatar, through the same refusal-aware function a render uses. While the avatar's usage cannot be trusted every
   * photo is refused (fail closed), and a record from a newer Studio is LIBRARY_TOO_NEW.
   */
  #assertPhotosFree(library: Library, avatarId: string, photoIds: readonly string[]): void {
    const availability = photoAvailability(library, avatarId);
    if (availability.state === "too-new") throw new EngineFailure({ code: "LIBRARY_TOO_NEW", detail: "a video record of this avatar was written by a newer version of Studio" });
    const issues: MontageIssue[] = [];
    photoIds.forEach((photoId, i) => {
      if (availability.state !== "known" || !availability.usable(photoId)) issues.push({ code: "photo-unavailable", path: ["photoIds", i] });
    });
    if (issues.length === 0) return;
    const detail = availability.state === "untrusted" ? `the usage of this avatar's photos cannot be trusted right now (${availability.reason})` : undefined;
    throw new EngineFailure({ code: "PHOTO_UNAVAILABLE", issues, ...(detail === undefined ? {} : { detail }) });
  }

  #seed(): number {
    const seed = this.#deps.randomSeed?.() ?? randomInt(0, 2 ** 32);
    return seed;
  }

  /** An id no avatar's folder has a draft under: `find` looks in every avatar, so an id is unique across the library. */
  async #freshId(library: Library): Promise<string> {
    for (let attempt = 0; attempt < ID_ATTEMPTS; attempt++) {
      const id = this.#deps.newId();
      if ((await this.#deps.store.find(library, id)) === null) return id;
    }
    throw new EngineFailure({ code: "INTERNAL", detail: "no unused draft id could be made" });
  }

  // ---------- the other commands ----------

  // ---------- montages.get ----------

  /** The draft as stored and the engine's verdict on it (`draftIssues`). A read: it takes no lock and changes nothing. */
  async get(montageId: string): Promise<CommandResult<"montages.get">> {
    const library = this.#readableLibrary();
    const found = await this.#deps.store.find(library, montageId);
    if (found === null) throw new EngineFailure({ code: "NOT_FOUND", detail: `no montage draft ${montageId}` });
    if (found.read.kind !== "ok") throw unreadable(found.read, montageId);
    const { montage } = found.read;
    return { montage, issues: draftIssues(library, montage.spec, this.#deps.log, this.#availabilityOf(library, montage.spec.avatarId), this.#deps.tracks) };
  }

  // ---------- montages.list ----------

  /**
   * Drafts newest first (at most `MAX_LISTED_MONTAGES`), each with its issues and its video count. A file that cannot be used
   * is left out and counted, never a failed list. An avatar's photo state is asked once for the whole list. `total` counts the
   * drafts the listing could read: no more than `MAX_DRAFT_FILES_READ` files are read (the log says when that cut it short).
   */
  async list(avatarId: string | undefined): Promise<CommandResult<"montages.list">> {
    const library = this.#readableLibrary();
    if (avatarId !== undefined && library.getAvatar(avatarId) === undefined) throw new EngineFailure({ code: "NOT_FOUND", detail: `no avatar ${avatarId} in the open library` });
    let listing;
    try {
      listing = await this.#deps.store.list(library, avatarId);
    } catch (error) {
      if (error instanceof DraftFolderError) throw new EngineFailure({ code: "INTERNAL", detail: `the drafts folder could not be listed (${error.code})` });
      throw error;
    }
    const availability = new Map<string, Availability>();
    const items = listing.montages.slice(0, MAX_LISTED_MONTAGES).map((montage) => {
      const owner = montage.spec.avatarId;
      let known = availability.get(owner);
      if (known === undefined) {
        known = this.#availabilityOf(library, owner);
        availability.set(owner, known);
      }
      return { montage, issues: draftIssues(library, montage.spec, this.#deps.log, known, this.#deps.tracks), videoCount: library.videoCountForMontage(owner, montage.montageId) };
    });
    return { items, total: listing.montages.length, skippedTotal: listing.skipped };
  }

  /**
   * The avatar's photo state for a read. While it cannot be trusted the log says so ONCE per avatar (until it is trusted
   * again), not on every `get` of every draft the window opens.
   */
  #availabilityOf(library: Library, avatarId: string): Availability {
    const availability = photoAvailability(library, avatarId, this.#untrustedLogged.has(avatarId) ? undefined : this.#deps.log);
    if (availability.state === "known") this.#untrustedLogged.delete(avatarId);
    else this.#untrustedLogged.add(avatarId);
    return availability;
  }

  /** The open library for a read, or the engine's own refusal. */
  #readableLibrary(): Library {
    const library = this.#deps.openLibrary();
    if (library === null) throw libraryUnavailable();
    return library;
  }

  // ---------- montages.save ----------

  /**
   * Replaces a draft's spec and name. The draft's own queue is entered at once, BEFORE the library is looked up (which
   * awaits), so saves are applied in the order they arrived and the last one wins. The stored draft is read inside the
   * queue: a draft deleted meanwhile is NOT_FOUND and is never brought back, and a draft this build cannot read is not
   * overwritten. `spec.avatarId` must be the draft's own; nothing else is checked against the library (a draft may hold
   * a photo the owner rejected since).
   */
  save(payload: CommandPayload<"montages.save">): Promise<CommandResult<"montages.save">> {
    const { montageId, spec, name } = payload;
    return this.#deps.store.exclusive(montageId, () =>
      this.#deps.withLibrary(async (library) => {
        const found = await this.#deps.store.find(library, montageId);
        if (found === null) throw new EngineFailure({ code: "NOT_FOUND", detail: `no montage draft ${montageId}` });
        if (found.read.kind !== "ok") throw unreadable(found.read, montageId);
        if (spec.avatarId !== found.avatarId) throw new EngineFailure({ code: "VALIDATION", detail: "the spec belongs to another avatar than the draft" });
        const montage = Montage.parse({ montageId, name, spec, updatedAt: nextStamp(this.#deps.now(), found.read.montage.updatedAt) });
        await this.#write(library, montage);
        this.#announceUpsert(montage);
        return { montage };
      }),
    );
  }

  // ---------- montages.delete ----------

  /**
   * Removes a draft, a damaged one too (the owner can always clear it). Allowed while a render of it is queued or running:
   * the job keeps its own copy of the spec, and the store remembers the id as removed so the video's record then lists
   * `montageId: null` (`VideoService`). The videos already rendered from it stay. In the draft's queue like a save, so a
   * save asked before it is applied first, and one asked after finds nothing.
   */
  delete(montageId: string): Promise<CommandResult<"montages.delete">> {
    return this.#deps.store.exclusive(montageId, () =>
      this.#deps.withLibrary(async (library) => {
        const found = await this.#deps.store.find(library, montageId);
        if (found === null) throw new EngineFailure({ code: "NOT_FOUND", detail: `no montage draft ${montageId}` });
        let removed: boolean;
        try {
          removed = await this.#deps.store.remove(library, found.avatarId, montageId);
        } catch (error) {
          this.#deps.log(`a draft could not be deleted (${kindOf(error)})`);
          if (error instanceof DraftNotAFileError) throw new EngineFailure({ code: "INTERNAL", detail: "the draft cannot be deleted: its name is taken by something that is not a file" });
          throw new EngineFailure({ code: "INTERNAL", detail: `the draft could not be deleted (${kindOf(error)})` });
        }
        if (!removed) throw new EngineFailure({ code: "NOT_FOUND", detail: `no montage draft ${montageId}` });
        this.#emit({ v: PROTOCOL_VERSION, id: this.#deps.newId(), kind: "event", type: "montage.changed", payload: { change: "removed", montageId, avatarId: found.avatarId } });
        return { montageId };
      }),
    );
  }

  // ---------- montages.focus ----------

  /**
   * The focus of one photo the owner has just placed, under the same budget as `create`'s (`null` when it was not judged: the
   * draft stores null and the preview draws the stand-in point). The photo must be an eligible one of an ACTIVE avatar; whether
   * it is used is a different question (the draft it came from may be open). A read: it takes no lock.
   */
  async focus(payload: CommandPayload<"montages.focus">): Promise<CommandResult<"montages.focus">> {
    const entered = performance.now();
    const library = this.#readableLibrary();
    const { avatarId, photo } = payload;
    const avatar = library.getAvatar(avatarId);
    if (avatar === undefined || avatar.status !== "active") throw new EngineFailure({ code: "NOT_FOUND", detail: `no active avatar ${avatarId} in the open library` });
    // TODO(3f.2): an own photo's focus, from the media store, once there is one.
    if (photo.source === "own") throw new EngineFailure({ code: "NOT_FOUND", detail: "own photos are not available yet" });
    if (!library.isEligible(avatarId, photo.photoId)) throw new EngineFailure({ code: "PHOTO_UNAVAILABLE", issues: [{ code: "photo-unavailable", path: ["photo"] }] });
    const [focus = null] = await this.#focusAll(library, avatarId, [photo.photoId], this.#focusBudget(entered), "montages.focus");
    return { focus };
  }

  // ---------- shared ----------

  /** The write, with a failing disk told as INTERNAL by its code alone: a raw fs error's message names the owner's path. */
  async #write(library: Library, montage: Montage): Promise<void> {
    try {
      await this.#deps.store.write(library, montage);
    } catch (error) {
      this.#deps.log(`a draft could not be written (${kindOf(error)})`);
      throw new EngineFailure({ code: "INTERNAL", detail: `the draft could not be saved (${kindOf(error)})` });
    }
  }

  #announceUpsert(montage: Montage): void {
    this.#emit({ v: PROTOCOL_VERSION, id: this.#deps.newId(), kind: "event", type: "montage.changed", payload: { change: "upserted", montage } });
  }

  /** Emits, and never throws: a closed window must not fail a command whose work is done. */
  #emit(event: UnsequencedEvent): void {
    try {
      this.#deps.emit(event);
    } catch (error) {
      this.#deps.log(`an event (${event.type}) could not be emitted (${kindOf(error)})`);
    }
  }
}

/** `spec` with each scene photo's cell focus set from `focuses` (by photo id): what `create` stores. */
function withFocus(spec: ReturnType<typeof defaultSpec>, focuses: ReadonlyMap<string, Focus | null>): ReturnType<typeof defaultSpec> {
  const focusOf = <C extends { photo: { source: string; photoId?: string } | null; focus: Focus | null }>(cell: C): C => {
    const photoId = cell.photo?.source === "scene" ? cell.photo.photoId : undefined;
    return photoId === undefined ? cell : { ...cell, focus: focuses.get(photoId) ?? null };
  };
  return {
    ...spec,
    clips: spec.clips.map((clip) => {
      if (clip.kind === "photo") return { ...clip, cell: focusOf(clip.cell) };
      if (clip.kind === "collage") return { ...clip, cells: clip.cells.map(focusOf) };
      return clip;
    }),
  };
}
