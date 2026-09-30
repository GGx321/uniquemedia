import { z } from "zod";
import { Id } from "../../shared/engine";

// SP5's lenient reading of the flashapi trending list. The API is a third party's and changes without notice, so:
// - only `track.id` is required, as a string or a number, normalised to a string that fits `Id`;
// - every other field is optional, and a field of the wrong type reads as absent (it never fails the list);
// - unknown keys are ignored (and reported by name, so a new one shows up at the first refresh);
// - URLs must be https strings; `song_monetization_info` and `licensed_music_subtype` are open strings, never enums;
// - a track with no usable `progressive_download_url` or `duration_in_ms` is dropped, and so is one whose id no
//   montage could name, with the reason kept for the log.
// The preview URL, the dash manifest and the trending flag are not carried: the full track is always downloaded (SP5),
// the manifest is never stored, and `is_trending_in_clips` is false everywhere and never a filter.

/** A montage names one track; the list keeps at most this many (`music.list` is bounded the same way, K23). */
export const MAX_LISTED_TRACKS = 100;
const MAX_HIGHLIGHTS = 64;
const MAX_TITLE_CHARS = 120;
const MAX_URL_CHARS = 4096;
const MAX_TRACK_MS = 24 * 3600 * 1000;
/** Bounds what is reported about the response, so a hostile one cannot fill a log. */
const MAX_OBSERVED = 64;
const MAX_OBSERVED_CHARS = 64;

export interface MusicTrack {
  /** The API's id as a string that fits `Id`. */
  readonly trackId: string;
  readonly title: string | null;
  /** The `display_artist`, never the uploader's `ig_username`. */
  readonly artist: string | null;
  readonly durationMs: number;
  /** True only for a JSON `true`. */
  readonly explicit: boolean;
  /** As the server sent them, unsorted: sorting them, and flagging the likely default, is the store's job (3c.4). */
  readonly highlightsMs: readonly number[];
  /** The FULL track's signed https URL. Lives in memory until its download ends, then is dropped (invariant 31). */
  readonly downloadUrl: string;
  readonly coverUrl: string | null;
  /** Open strings: never an enum. */
  readonly monetization: string | null;
  readonly licensedSubtype: string | null;
}

export type DropReason = "no-track" | "no-id" | "id-unusable" | "no-download-url" | "insecure-download-url" | "no-duration" | "duplicate-id" | "over-limit";

export interface ListObservations {
  readonly bodyStatus: string | null;
  readonly itemCount: number;
  readonly explicitCount: number;
  /** Keys the SP5 sample (both lists) never had, by name. */
  readonly unknownTopLevelKeys: readonly string[];
  readonly unknownTrackKeys: readonly string[];
  readonly unknownMetadataKeys: readonly string[];
  readonly monetizationValues: readonly string[];
  readonly subtypeValues: readonly string[];
  /** `scheme://host` of every URL the items carry, never a path or a query (they are signed). */
  readonly urlOrigins: readonly string[];
  readonly pageInfo: { readonly nextMaxId?: string; readonly moreAvailable?: boolean } | null;
}

export type ListParse =
  | { readonly ok: true; readonly tracks: MusicTrack[]; readonly dropped: { readonly index: number; readonly reason: DropReason }[]; readonly observed: ListObservations }
  | { readonly ok: false; readonly reason: "not-an-object" | "no-items" };

const KNOWN_TOP_LEVEL = new Set(["alacorn_session_id", "items", "music_reels", "page_info", "status"]);
const KNOWN_ITEM = new Set(["metadata", "track"]);
const KNOWN_TRACK = new Set([
  "allows_saving", "artist_id", "audio_asset_id", "audio_cluster_id", "cover_artwork_thumbnail_uri", "cover_artwork_uri", "dash_manifest", "display_artist",
  "duration_in_ms", "fast_start_progressive_download_url", "has_lyrics", "highlight_start_times_in_ms", "id", "ig_username", "is_eligible_for_audio_effects",
  "is_eligible_for_vinyl_sticker", "is_explicit", "licensed_music_subtype", "progressive_download_url", "related_audios", "song_monetization_info", "subtitle",
  "title", "web_30s_preview_download_url",
]);
const KNOWN_METADATA = new Set(["allow_media_creation_with_music", "is_bookmarked", "is_trending_in_clips"]);
const URL_FIELDS = ["progressive_download_url", "cover_artwork_uri", "cover_artwork_thumbnail_uri", "web_30s_preview_download_url", "fast_start_progressive_download_url"] as const;

/** A wrongly typed field is as good as an absent one. */
const lenient = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);

// `z.object` strips keys it does not name (never `z.looseObject`, which would copy a hostile `__proto__` key across).
const TrackFields = z.object({
  id: z.unknown().optional(),
  title: lenient(z.string()),
  display_artist: lenient(z.string()),
  cover_artwork_uri: lenient(z.string()),
  progressive_download_url: lenient(z.string()),
  highlight_start_times_in_ms: lenient(z.array(z.unknown())),
  duration_in_ms: lenient(z.number()),
  is_explicit: lenient(z.boolean()),
  song_monetization_info: lenient(z.string()),
  licensed_music_subtype: lenient(z.string()),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normaliseId(raw: unknown): string | null {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed === "" ? null : trimmed;
  }
  // A number past 2^53 was already rounded by JSON.parse, so it names some other track: not an id.
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) return String(raw);
  return null;
}

/** `https`, no credentials, a bounded length. Anything else (http, `//host`, javascript:, data:, a relative path) is not one. */
function httpsUrl(raw: string | undefined): string | null {
  if (raw === undefined || raw.length === 0 || raw.length > MAX_URL_CHARS) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.username === "" && url.password === "" ? raw : null;
  } catch {
    return null;
  }
}

/** Control characters and bidi overrides out, trimmed, at most 120 code points (never half a surrogate pair). */
function cleanText(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const cleaned = raw.replace(/[\p{Cc}‪-‮⁦-⁩]/gu, "").trim();
  if (cleaned === "") return null;
  return Array.from(cleaned).slice(0, MAX_TITLE_CHARS).join("");
}

function highlights(raw: readonly unknown[] | undefined): number[] {
  if (raw === undefined) return [];
  const kept: number[] = [];
  for (const value of raw) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) kept.push(value);
    if (kept.length === MAX_HIGHLIGHTS) break;
  }
  return kept;
}

function duration(raw: number | undefined): number | null {
  if (raw === undefined || !Number.isFinite(raw)) return null;
  const ms = Math.round(raw);
  return ms >= 1 && ms <= MAX_TRACK_MS ? ms : null;
}

function origin(raw: string): string | null {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

/** A bounded, sorted set of short strings for the report. */
class Observed {
  readonly #values = new Set<string>();
  add(value: string): void {
    if (this.#values.size < MAX_OBSERVED) this.#values.add(value.slice(0, MAX_OBSERVED_CHARS));
  }
  get sorted(): string[] {
    return [...this.#values].sort();
  }
}

function noteUnknown(target: Observed, raw: Record<string, unknown>, known: ReadonlySet<string>): void {
  for (const key of Object.keys(raw)) if (!known.has(key)) target.add(key);
}

/** Reads a flashapi list response; see the header for what is lenient. A body that is not an object with an `items` array is not a list. */
export function parseFlashapiList(body: unknown): ListParse {
  if (!isRecord(body)) return { ok: false, reason: "not-an-object" };
  const items = body["items"];
  if (!Array.isArray(items)) return { ok: false, reason: "no-items" };

  const unknownTop = new Observed();
  const unknownTrack = new Observed();
  const unknownMetadata = new Observed();
  const monetization = new Observed();
  const subtypes = new Observed();
  const origins = new Observed();
  noteUnknown(unknownTop, body, KNOWN_TOP_LEVEL);

  const tracks: MusicTrack[] = [];
  const dropped: { index: number; reason: DropReason }[] = [];
  const seen = new Set<string>();
  let explicitCount = 0;

  for (const [index, item] of items.entries()) {
    const drop = (reason: DropReason): void => void dropped.push({ index, reason });
    if (!isRecord(item)) {
      drop("no-track");
      continue;
    }
    const metadata = item["metadata"];
    if (isRecord(metadata)) noteUnknown(unknownMetadata, metadata, KNOWN_METADATA);
    // A key beside `track` and `metadata` is reported with the metadata's, marked as the item's.
    for (const key of Object.keys(item)) if (!KNOWN_ITEM.has(key)) unknownMetadata.add(`item.${key}`);
    const rawTrack = item["track"];
    if (!isRecord(rawTrack)) {
      drop("no-track");
      continue;
    }
    noteUnknown(unknownTrack, rawTrack, KNOWN_TRACK);
    for (const field of URL_FIELDS) {
      const value = rawTrack[field];
      const found = typeof value === "string" ? origin(value) : null;
      if (found !== null) origins.add(found);
    }
    const read = TrackFields.safeParse(rawTrack);
    if (!read.success) {
      // Every field is lenient, so this does not happen; a list must never throw, so it is a dropped item if it does.
      drop("no-track");
      continue;
    }
    const fields = read.data;
    if (fields.song_monetization_info !== undefined) monetization.add(fields.song_monetization_info);
    if (fields.licensed_music_subtype !== undefined) subtypes.add(fields.licensed_music_subtype);
    if (fields.is_explicit === true) explicitCount++;

    const rawId = normaliseId(fields.id);
    if (rawId === null) {
      drop("no-id");
      continue;
    }
    if (!Id.safeParse(rawId).success) {
      drop("id-unusable");
      continue;
    }
    if (fields.progressive_download_url === undefined || fields.progressive_download_url === "") {
      drop("no-download-url");
      continue;
    }
    const downloadUrl = httpsUrl(fields.progressive_download_url);
    if (downloadUrl === null) {
      drop("insecure-download-url");
      continue;
    }
    const durationMs = duration(fields.duration_in_ms);
    if (durationMs === null) {
      drop("no-duration");
      continue;
    }
    if (seen.has(rawId)) {
      drop("duplicate-id");
      continue;
    }
    if (tracks.length >= MAX_LISTED_TRACKS) {
      drop("over-limit");
      continue;
    }
    seen.add(rawId);
    tracks.push({
      trackId: rawId,
      title: cleanText(fields.title),
      artist: cleanText(fields.display_artist),
      durationMs,
      explicit: fields.is_explicit === true,
      highlightsMs: highlights(fields.highlight_start_times_in_ms),
      downloadUrl,
      coverUrl: httpsUrl(fields.cover_artwork_uri),
      monetization: fields.song_monetization_info ?? null,
      licensedSubtype: fields.licensed_music_subtype ?? null,
    });
  }

  const page = body["page_info"];
  const pageInfo = isRecord(page)
    ? {
        ...(typeof page["next_max_id"] === "string" || typeof page["next_max_id"] === "number" ? { nextMaxId: String(page["next_max_id"]).slice(0, MAX_OBSERVED_CHARS) } : {}),
        ...(typeof page["more_available"] === "boolean" ? { moreAvailable: page["more_available"] } : {}),
      }
    : null;

  return {
    ok: true,
    tracks,
    dropped,
    observed: {
      bodyStatus: typeof body["status"] === "string" ? body["status"].slice(0, MAX_OBSERVED_CHARS) : null,
      itemCount: items.length,
      explicitCount,
      unknownTopLevelKeys: unknownTop.sorted,
      unknownTrackKeys: unknownTrack.sorted,
      unknownMetadataKeys: unknownMetadata.sorted,
      monetizationValues: monetization.sorted,
      subtypeValues: subtypes.sorted,
      urlOrigins: origins.sorted,
      pageInfo,
    },
  };
}
