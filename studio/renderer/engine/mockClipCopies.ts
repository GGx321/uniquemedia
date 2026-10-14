import { type ClipUse, type CommandPayload, type EngineError, type MediaKind, type MediaOrigin, type MediaSummary, type MediaUnsupportedReason } from "../../shared/engine";
import type { MockClips } from "./mockClips";
import type { MockClipImport, MockMediaAccept, MockOwnMedia } from "./mockMedia";

// Stage 5, 5b.2, S5.WA3 (plan s5b2 §5.1, I5.59, I5.60): a ready clip becoming the montage editor's own video, as its own copy, in the mock. It answers what the ENGINE answers (engine/clips/importClip.ts,
// copies.ts, and the frame rule of engine/videos/*), refusal for refusal and number for number. The mock cannot import `engine/` (the renderer bundle must not), so what the engine decides with is written
// out here and HELD to the engine by tests that can import both (mockEngine.clipCopies.test.ts), and by the parity stories (scenarios.clipMontage.ts).
//
//   - the REFUSALS, in the engine's order: LIBRARY_UNAVAILABLE, NOT_FOUND (the avatar, the clip), VALIDATION `not-ready`, [a live copy answers its media id], IN_FLIGHT `job-running`, VALIDATION `file-damaged`,
//     then the importer's: a full disk is MEDIA_UNSUPPORTED `no-space`, every other outcome is one INTERNAL;
//   - ONE COPY PER CLIP: a live copy is answered at once; a copy is removed with its clip (a render that holds it refuses the delete `in-use`) and with its avatar (only when the avatar went);
//   - the CLIP LOCK: the clip is held from the answer until the import job has ended, so a `clips.delete`, an export and a second import meanwhile answer `job-running`, and an avatar delete waits;
//   - the LAST LOOK before the record: an avatar or a clip that is gone cancels the import, and nothing is recorded.

/** The importer's frame: 1080 x 1920, never upscaled (engine/media/videoPlan.ts). */
const FRAME_W = 1080;
const FRAME_H = 1920;

/** A provider clip arrives at 24 fps (the plan: `sourceFps` 24). */
const CLIP_SOURCE_FPS = 24;

/** What the mock says a clip's mp4 weighs, per second of it: the copy job's first stage counts these bytes (the figure is masked by the parity transcript). */
const CLIP_BYTES_PER_SECOND = 900_000;

/** The copy's display name, «Клип <YYYY-MM-DD> <HH-MM>.mp4», from the clip's creation time in the owner's local time (engine/clips/importClip.ts `copyNameOf`). */
export function mockCopyNameOf(createdAt: string): string {
  const at = new Date(createdAt);
  const two = (n: number): string => String(n).padStart(2, "0");
  return `Клип ${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}-${two(at.getMinutes())}.mp4`;
}

/** The size inside 1080 x 1920 without upscale, even sides (the importer's plan). */
function fitted(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, FRAME_W / width, FRAME_H / height);
  const even = (n: number): number => Math.max(2, Math.floor((n * scale) / 2) * 2);
  return scale === 1 ? { width, height } : { width: even(width), height: even(height) };
}

/** A saved draft as the draft uses of a clip need it: its name and, per clip, the media an own video clip names. */
export interface MockDraftView {
  readonly name: string | null;
  readonly clips: readonly { readonly kind: string; readonly mediaId?: string | undefined }[];
}

/** What the copies need of the mock engine. */
export interface MockCopiesHost {
  /** The library gate of a command that reads the library (`libraryGate`). */
  libraryGate(): EngineError | null;
  /** A queued or running render holds this media (the render queue's reserved set). */
  mediaHeld(mediaId: string): boolean;
  /** The finished videos of an avatar, as far as frames go: the clips whose copies each holds, and the photos it uses. */
  videosOf(avatarId: string): readonly { readonly clipIds: readonly string[]; readonly photoIds: readonly string[] }[];
  /** The avatar's saved drafts. */
  draftsOf(avatarId: string): readonly MockDraftView[];
}

type Out<T> = { ok: true; result: T } | { ok: false; error: EngineError };
const good = <T>(result: T): Out<T> => ({ ok: true, result });
const bad = (error: EngineError): Out<never> => ({ ok: false, error });

/** What the next import is made to meet: a refusal at the start (`media.import`'s own), or a failure inside the job (the importer's). */
type Scripted = { at: "start"; reason: MediaUnsupportedReason | "too-many" } | { at: "job"; reason: MediaUnsupportedReason };

export class MockClipCopies {
  readonly #clips: MockClips;
  readonly #media: MockOwnMedia;
  readonly #host: MockCopiesHost;
  #scripted: Scripted | null = null;

  constructor(clips: MockClips, media: MockOwnMedia, host: MockCopiesHost) {
    this.#clips = clips;
    this.#media = media;
    this.#host = host;
  }

  // ---------- test and rig switches ----------

  /** The NEXT `media.importClip` is refused at the start the way `media.import` refuses: `no-space` is MEDIA_UNSUPPORTED, every other reason is one INTERNAL. Used once. */
  refuseNext(reason: MediaUnsupportedReason | "too-many"): void {
    this.#scripted = { at: "start", reason };
  }

  /** The NEXT copy's job fails inside, the way the importer fails: `no-space` keeps its reason, every other is one INTERNAL. Used once. */
  failNext(reason: MediaUnsupportedReason): void {
    this.#scripted = { at: "job", reason };
  }

  // ---------- media.importClip ----------

  importClip(payload: CommandPayload<"media.importClip">): Out<{ mediaId: string } | { jobId: string }> {
    const { avatarId, clipId } = payload;
    const gone = this.#host.libraryGate();
    if (gone !== null) return bad(gone);
    const source = this.#clips.copySource(avatarId, clipId);
    if (!source.ok) return source;
    const { ready } = source.result;
    if (ready === null) return bad({ code: "VALIDATION", clipReason: "not-ready", detail: `clip ${clipId} is not ready, so it has no file to prepare` });
    // One copy per clip: a live copy is answered at once, whoever else works on the clip.
    const live = this.#media.copyOfClip(avatarId, clipId);
    if (live !== undefined) return good({ mediaId: live.mediaId });
    if (this.#clips.busyForImport(clipId)) return bad({ code: "IN_FLIGHT", clipReason: "job-running", detail: `a job is working on clip ${clipId}` });
    // The sha256 check, inside the lock: the file must be the one the record names.
    if (this.#clips.fileDamaged(clipId)) return bad({ code: "VALIDATION", clipReason: "file-damaged", detail: `the file of clip ${clipId} is not the one its record names` });

    const scripted = this.#scripted;
    this.#scripted = null;
    // The importer turns the call away before a job exists: a full disk keeps its reason, every other outcome is one INTERNAL.
    if (scripted?.at === "start") {
      return bad(scripted.reason === "no-space" ? { code: "MEDIA_UNSUPPORTED", mediaReason: "no-space", detail: "the library's disk has no room for the copy" } : { code: "INTERNAL", detail: `the import was refused: ${scripted.reason}` });
    }

    const release = this.#clips.holdForImport(avatarId, clipId);
    const origin: MediaOrigin = { kind: "clip", avatarId, clipId, photoId: source.result.photoId };
    const size = fitted(ready.width, ready.height);
    const accept: MockMediaAccept = {
      kind: "video" satisfies MediaKind,
      bytes: Math.round((ready.durationMs / 1000) * CLIP_BYTES_PER_SECOND),
      facts: { ...size, durationMs: ready.durationMs, sourceFps: CLIP_SOURCE_FPS, hdrToSdr: false },
      prepare: {},
      ...(scripted?.at === "job" ? { failWith: scripted.reason } : {}),
    };
    const clip: MockClipImport = { origin, stillWanted: () => this.#stillReady(avatarId, clipId), onEnd: release };
    const jobId = this.#media.startImport(mockCopyNameOf(source.result.createdAt), accept, clip);
    if (jobId === null) {
      release();
      return bad({ code: "INTERNAL", detail: "too many imports are waiting" });
    }
    return good({ jobId });
  }

  #stillReady(avatarId: string, clipId: string): boolean {
    const source = this.#clips.copySource(avatarId, clipId);
    return source.ok && source.result.ready !== null;
  }

  // ---------- the copy's lifetime ----------

  /**
   * A `clips.delete`'s first step: every copy of the clip goes, or, when a render holds one, none does (`in-use`). "none" when the clip has no copy.
   */
  removeOfClip(avatarId: string, clipId: string): "none" | "removed" | "in-use" {
    const copies = this.#media.copiesOfClip(avatarId, clipId);
    if (copies.length === 0) return "none";
    if (copies.some((copy) => this.#host.mediaHeld(copy.mediaId))) return "in-use";
    for (const copy of copies) this.#media.delete(copy.mediaId);
    return "removed";
  }

  /** The avatar went to the Trash: every copy of its clips is removed (a copy a render holds cannot be: the avatar's delete waits for the render, so none is). */
  removeOfAvatar(avatarId: string): void {
    for (const copy of this.#media.copiesOfAvatar(avatarId)) if (!this.#host.mediaHeld(copy.mediaId)) this.#media.delete(copy.mediaId);
  }

  /** The avatar's delete waits while a clip import of it runs, or a render holds a copy of one of its clips. */
  holdsAvatar(avatarId: string): boolean {
    return this.#clips.importingFor(avatarId) || this.#media.copiesOfAvatar(avatarId).some((copy) => this.#host.mediaHeld(copy.mediaId));
  }

  // ---------- what uses a clip (Q-F = 1) ----------

  /** `ClipSummary.use` of a ready clip: how a finished video uses its frame, and the saved drafts that hold its copy. Undefined when nothing does. */
  use(avatarId: string, clipId: string, photoId: string): ClipUse | undefined {
    const videos = this.#host.videosOf(avatarId);
    const inVideo = videos.some((video) => video.clipIds.includes(clipId)) ? ("clip" as const) : videos.some((video) => video.photoIds.includes(photoId)) ? ("photo" as const) : undefined;
    const inDrafts = this.#draftUse(avatarId, clipId);
    if (inVideo === undefined && inDrafts === undefined) return undefined;
    return { ...(inVideo === undefined ? {} : { inVideo }), ...(inDrafts === undefined ? {} : { inDrafts }) };
  }

  /** How many saved drafts hold the clip's copy (a draft once, however often), and for exactly one: its name and the clip's 1-based place in it. */
  #draftUse(avatarId: string, clipId: string): ClipUse["inDrafts"] {
    const copyIds = new Set(this.#media.copiesOfClip(avatarId, clipId).map((copy: MediaSummary) => copy.mediaId));
    if (copyIds.size === 0) return undefined;
    const holders: { name: string | null; frame: number }[] = [];
    for (const draft of this.#host.draftsOf(avatarId)) {
      const at = draft.clips.findIndex((clip) => clip.kind === "video" && clip.mediaId !== undefined && copyIds.has(clip.mediaId));
      if (at >= 0) holders.push({ name: draft.name, frame: at + 1 });
    }
    const only = holders[0];
    if (only === undefined) return undefined;
    return holders.length === 1 ? { count: 1, first: only } : { count: holders.length };
  }
}
