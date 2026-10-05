import type { MediaSummary, MontageDraft } from "../../../shared/engine";
import { ownVideoIssues } from "../../../shared/montage";
import type { EngineClient } from "../../engine/client";
import type { EngineStore } from "../../engine/store";
import { sameJson } from "./json";
import { type MediaRecords, useMediaRecords } from "./ownMedia";
import type { EngineVerdict } from "./renderBlock";

// 3f.3b: what the editor knows of the own videos its draft's clips play, from their records (K28): the name and facts the properties show (R19), the stored
// size the preview crops (`videoClipCrop`) and the length the trim is held to. Asked for BY ID (`media.list {kind: "video", mediaIds}`, ownMedia.ts) and
// followed by `media.changed`. A video is known, gone (the library answered and does not hold it as a video: `media-unavailable`), or unknown (not answered
// yet, or the list could not be read): nothing is said about an unknown one.
//
// A clip's problem (the timeline's tag, the properties' text) is the engine's verdict on the spec ON SCREEN, as is, both ways (as the music's is, 3d.3b);
// only for an edit it has not judged yet does the window guess, from the records, through the SHARED `ownVideoIssues` the engine judges with.

/** An own video as the editor uses it. */
export interface OwnVideo {
  readonly mediaId: string;
  /** The picked file's base name, for display only. */
  readonly name: string;
  /** The stored mezzanine's size (within 1080 x 1920, rotation applied). */
  readonly width: number;
  readonly height: number;
  /** The stored mezzanine's length: `round(frames × 1000 / 30)`. */
  readonly durationMs: number;
  /** The owner's file's own rate, before the constant 30 fps. */
  readonly sourceFps: number;
  /** It was HDR and was tone-mapped to SDR. */
  readonly hdrToSdr: boolean;
}

export type OwnVideos = MediaRecords<OwnVideo>;

export type VideoLookup = { readonly state: "known"; readonly video: OwnVideo } | { readonly state: "gone" } | { readonly state: "unknown" };

/** What the render refuses an own video clip for (the engine's codes, worded by `MONTAGE_ISSUE_MESSAGES_RU`). */
export type VideoProblem = "media-unavailable" | "video-too-short";

/** The editor's view of a media record: null for anything that is not a video with a size, a length and a source rate. */
export function ownVideoOf(summary: MediaSummary): OwnVideo | null {
  if (summary.kind !== "video" || summary.width === null || summary.height === null || summary.durationMs === null || summary.sourceFps === null) return null;
  return { mediaId: summary.mediaId, name: summary.name, width: summary.width, height: summary.height, durationMs: summary.durationMs, sourceFps: summary.sourceFps, hdrToSdr: summary.hdrToSdr };
}

/** What the window knows of the video `mediaId`. */
export function videoLookup(videos: OwnVideos, mediaId: string): VideoLookup {
  const video = videos.held.get(mediaId);
  if (video !== undefined) return { state: "known", video };
  return videos.answered.has(mediaId) ? { state: "gone" } : { state: "unknown" };
}

/** The own videos the draft's clips play, by media id: asked by id, followed by `media.changed`. */
export function useOwnVideos(client: Pick<EngineClient, "request">, mediaIds: readonly string[], store: Pick<EngineStore, "subscribeMedia">): OwnVideos {
  return useMediaRecords(client, "video", mediaIds, ownVideoOf, store);
}

const VIDEO_PROBLEMS: ReadonlySet<string> = new Set<VideoProblem>(["media-unavailable", "video-too-short"]);
const isVideoProblem = (code: string): code is VideoProblem => VIDEO_PROBLEMS.has(code);

/**
 * Each own video clip's problem, by clip id: the engine's verdict when it judged the spec on screen (its first issue at the clip itself, `["clips", i]`);
 * otherwise the window's guess from what it knows of the videos (an unknown video is guessed nothing about).
 */
export function videoProblems(spec: MontageDraft, verdict: EngineVerdict | null, videos: OwnVideos): ReadonlyMap<string, VideoProblem> {
  const found = new Map<string, VideoProblem>();
  const judged = verdict !== null && sameJson(verdict.spec, spec);
  const issues = judged
    ? verdict.issues
    : ownVideoIssues(spec, (mediaId) => {
        const known = videoLookup(videos, mediaId);
        // An unknown video is judged as one that is there and long enough: nothing is said about it.
        return known.state === "known" ? known.video : known.state === "gone" ? null : { durationMs: Number.POSITIVE_INFINITY };
      });
  for (const issue of issues) {
    const [root, i, ...rest] = issue.path;
    const clip = typeof i === "number" ? spec.clips[i] : undefined;
    if (root !== "clips" || rest.length > 0 || clip?.kind !== "video" || !isVideoProblem(issue.code) || found.has(clip.clipId)) continue;
    found.set(clip.clipId, issue.code);
  }
  return found;
}
