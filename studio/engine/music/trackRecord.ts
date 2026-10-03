import { z } from "zod";
import { Count, Id, MAX_TRACK_HIGHLIGHTS, type TrackSummary } from "../../shared/engine";
import { CLOCK_MAX_MS, CLOCK_MIN_MS } from "./quotaLedger";
import { signedUrlExpiresAtMs } from "./signedUrl";

// What the track store keeps on disk, and the pure rules around it (3c.4).
//
// `userData/music/lists/current.json` is the list record: one entry per track of the current list, then the tracks of
// earlier lists whose audio is still stored (a montage may name one; Stage 3 prunes nothing). An entry's `audio` and
// `cover` are one of:
//   stored   the file is on disk, with its size and sha256 (and, for audio, what the walker and the decode read);
//   pending  not downloaded yet: the SIGNED URL and when it stops working. This is the only place a URL is ever kept, and
//            only until the download ends (a stored or failed entry keeps none) or `expiresAt` passes;
//   failed   given up, with a short reason code (never a URL, a path or ffmpeg's text).
// No `dash_manifest`, no preview URL and no other signed URL is ever kept.

const EpochMs = Count.min(CLOCK_MIN_MS).max(CLOCK_MAX_MS);
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
/** A machine-readable reason: `refused-host`, `probe:no-ftyp`, `decode:duration-mismatch`. Short, lowercase, no text from the network. */
const Reason = z.string().regex(/^[a-z0-9:_-]{1,64}$/);
const Url = z.string().min(1).max(4096);

const AudioStored = z.strictObject({
  state: z.literal("stored"),
  bytes: Count,
  sha256: Sha256,
  /** 2 AAC-LC, 5 HE-AAC, 29 HE-AACv2: what the walker read from `esds`. */
  audioObjectType: Count,
  sampleRate: Count,
  channels: Count,
  /** The length the decode proved, from its sample count. */
  decodedMs: Count,
});
const Pending = z.strictObject({ state: z.literal("pending"), url: Url, expiresAt: EpochMs });
const Failed = z.strictObject({ state: z.literal("failed"), reason: Reason });

export const COVER_EXTENSIONS = ["jpg", "png", "webp"] as const;
export type CoverExtension = (typeof COVER_EXTENSIONS)[number];
const CoverStored = z.strictObject({ state: z.literal("stored"), ext: z.enum(COVER_EXTENSIONS), bytes: Count, sha256: Sha256 });

const Highlight = z.strictObject({ ms: Count, likelyDefault: z.boolean() });

export const TrackEntrySchema = z.strictObject({
  trackId: Id,
  title: z.string().max(120).nullable(),
  artist: z.string().max(120).nullable(),
  durationMs: Count,
  explicit: z.boolean(),
  highlights: z.array(Highlight).max(MAX_TRACK_HIGHLIGHTS),
  monetization: z.string().max(64).nullable(),
  licensedSubtype: z.string().max(64).nullable(),
  /** In the current list (offered by `music.list`), as against kept from an earlier one. */
  inList: z.boolean(),
  audio: z.discriminatedUnion("state", [AudioStored, Pending, Failed]),
  cover: z.discriminatedUnion("state", [CoverStored, Pending, Failed, z.strictObject({ state: z.literal("none") })]),
});
export type TrackEntry = z.infer<typeof TrackEntrySchema>;

/** A generous bound: the 100 of the current list and every stored track of the lists before it. */
export const MAX_RECORDED_TRACKS = 5000;

export const ListRecordSchema = z.strictObject({
  v: z.literal(1),
  /** Epoch ms of the response this list came from. */
  fetchedAt: EpochMs,
  /** False while a download is still to run (a crash or a stop left it), true once every entry is stored or failed. */
  complete: z.boolean(),
  /**
   * The circuit breaker's mark (3c.4 review): the sampled downloads of a run were all refused alike, so the run stopped with
   * every entry still pending. If the next run samples the same tracks and they are refused again, those are given up on and
   * the rest goes on; a mark that does not match is replaced. Gone once a run completes.
   */
  breaker: z.strictObject({ ids: z.array(Id).min(1).max(3), signature: Reason }).optional(),
  tracks: z.array(TrackEntrySchema).max(MAX_RECORDED_TRACKS),
});
export type ListRecord = z.infer<typeof ListRecordSchema>;

/** The waveform kept per track: one value per `stepMs`, 0..1000. 20 000 steps is 16 minutes at 50 ms. */
export const MAX_ENVELOPE_STEPS = 20_000;
export const EnvelopeSchema = z.strictObject({ v: z.literal(1), stepMs: z.literal(50), peaks: z.array(z.number().int().min(0).max(1000)).max(MAX_ENVELOPE_STEPS) });
export type Envelope = z.infer<typeof EnvelopeSchema>;

// ---------- pure rules ----------

/** SP5: the signed URLs live 104 to 108 hours after the response; 104 is the ceiling this store trusts. */
export const EXPIRY_CEILING_MS = 104 * 3600 * 1000;
/** A URL with no readable `oe` is assumed to live one day. */
export const EXPIRY_FALLBACK_MS = 24 * 3600 * 1000;

/**
 * When a signed URL stops working, for the pending entry that holds it: its own `oe` capped at 104 hours after the
 * response, or 24 hours after it when `oe` is missing or unreadable. A time already past is returned as it is: the
 * download is then not attempted.
 */
export function expiresAtFor(url: string, fetchedAt: number): number {
  const own = signedUrlExpiresAtMs(url);
  return own === null ? fetchedAt + EXPIRY_FALLBACK_MS : Math.min(own, fetchedAt + EXPIRY_CEILING_MS);
}

const UNTITLED = "Untitled track";

/** A stored track as `music.list` answers it: the summary of K23, with no URL, path or hash. */
export function toSummary(entry: TrackEntry): TrackSummary {
  return {
    trackId: entry.trackId,
    title: entry.title ?? UNTITLED,
    artist: entry.artist,
    durationMs: entry.durationMs,
    explicit: entry.explicit,
    highlights: entry.highlights.map((highlight) => ({ ms: highlight.ms, likelyDefault: highlight.likelyDefault })),
    hasCover: entry.cover.state === "stored",
  };
}
