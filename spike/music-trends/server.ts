// Spike: pull trending music — from tikwm's free TikTok feed API, or from
// Instagram's own trending list via Alex's RapidAPI "flashapi" subscription —
// and bake a chosen track into a throwaway 1080x1920 test Reel, so Alex can
// check by hand whether Instagram recognises the track after upload.
//
// Bun-only: Bun.serve for the HTTP server, Bun.spawn for ffmpeg, Bun.file for
// static/range responses. No express, no axios. The only secret read is
// process.env.RAPIDAPI_KEY (exported by Alex at launch, never read from a
// .env file) and it never gets logged, stored, or echoed back to the client.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegPathRaw from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const HOST = "127.0.0.1";
const START_PORT = 5178;
const MAX_PORT_ATTEMPTS = 20;

const FEED_URL = "https://www.tikwm.com/api/feed/list";
const MIN_FEED_CALL_INTERVAL_MS = 1100;
const MAX_FEED_RETRIES = 2;

const CACHE_DIR = path.join(tmpdir(), "music-trends-cache");
const RENDER_TIMEOUT_MS = 60_000;

// Instagram trending music via Alex's RapidAPI "flashapi" subscription. Quota
// is 30 requests/month, so this source only ever calls out on an explicit
// "refresh" action — never automatically, never with retries.
const FLASHAPI_HOST = "flashapi1.p.rapidapi.com";
// Overridable only for local testing (points at a stub instead of the real
// host); the x-rapidapi-host header always names the real host regardless.
const FLASHAPI_BASE_URL = process.env.FLASHAPI_BASE_URL || `https://${FLASHAPI_HOST}`;
const FLASHAPI_TRENDING_PATH = "/ig/music_trending/";
/** Query param name flashapi expects for the next page. The docs sample only
 *  shows the response's `page_info.next_max_id`, not the request param name
 *  that echoes it back — this is a guess, kept as one constant so it's a
 *  one-line fix once the real name is confirmed against a live call. */
const FLASHAPI_MAX_ID_PARAM = "max_id";
const FLASHAPI_CACHE_DIR = path.join(CACHE_DIR, "flashapi");
const FLASHAPI_RESPONSE_PREFIX = "response-";
// Read once at startup. Never logged, stored, or echoed back to the client —
// it only ever goes into the x-rapidapi-key header of the outgoing request.
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const INDEX_PATH = path.join(import.meta.dir, "index.html");

function resolveBinary(p: string | null, pkg: string): string {
  if (!p) throw new Error(`${pkg} resolved no binary for this platform.`);
  return p;
}

const FFMPEG_BIN = resolveBinary(ffmpegPathRaw, "ffmpeg-static");
const FFPROBE_BIN = resolveBinary(ffprobeStatic.path, "ffprobe-static");

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

function jsonResponse(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json; charset=utf-8", ...(init?.headers ?? {}) },
  });
}

function jsonError(status: number, message: string): Response {
  return jsonResponse({ error: message }, { status });
}

/** Runs a route body and turns any thrown error into a JSON response. Takes a
 *  thunk rather than wrapping the handler itself, so route handlers stay
 *  written inline in the `routes` object and keep Bun's inferred
 *  `BunRequest<Path>` (and its typed `.params`) instead of widening to a bare
 *  `Request` that would need a cast to read `.params` back out. */
async function withErrorHandling(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof HttpError) return jsonError(err.status, err.message);
    console.error(err);
    return jsonError(500, err instanceof Error ? err.message : "Unknown error");
  }
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Keeps generated file names filesystem-safe; tikwm ids are numeric in
 *  practice but this guards against anything unexpected slipping through. */
function sanitizeForFilename(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_") || "unknown";
}

// ---------------------------------------------------------------------------
// tikwm feed: schema, fetch with rate limit + retry, aggregation
// ---------------------------------------------------------------------------

const MusicInfoSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  title: z.string().optional(),
  author: z.string().optional(),
  album: z.string().optional(),
  cover: z.string().optional(),
  duration: z.number().optional(),
  original: z.boolean().optional(),
  play: z.string().optional(),
});

const FeedItemSchema = z
  .object({
    video_id: z.union([z.string(), z.number()]).optional(),
    id: z.union([z.string(), z.number()]).optional(),
    music_info: MusicInfoSchema.optional(),
  })
  .passthrough();

const FeedResponseSchema = z
  .object({
    code: z.number(),
    msg: z.string().optional(),
    data: z.array(FeedItemSchema).optional(),
  })
  .passthrough();

type FeedItem = z.infer<typeof FeedItemSchema>;

interface AggregatedSound {
  id: string;
  title: string;
  author: string;
  album: string;
  cover: string;
  duration: number;
  original: boolean;
  play: string;
  count: number;
  exampleVideoId: string;
  isSong: boolean;
}

/** Registry of sound ids that came out of a /api/trending response. Both
 *  /api/audio and /api/render only serve ids present here, so the server
 *  never becomes an open proxy for arbitrary tiktokcdn URLs. */
const knownSounds = new Map<string, AggregatedSound>();

let lastFeedCallAt = 0;

async function throttleFeedCall(): Promise<void> {
  const wait = lastFeedCallAt + MIN_FEED_CALL_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
}

async function fetchFeedPageWithRetry(region: string): Promise<FeedItem[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_FEED_RETRIES; attempt++) {
    await throttleFeedCall();
    lastFeedCallAt = Date.now();
    try {
      const res = await fetch(FEED_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": USER_AGENT,
        },
        body: `region=${encodeURIComponent(region)}&count=10`,
      });
      if (!res.ok) throw new Error(`tikwm HTTP ${res.status}`);
      const parsed = FeedResponseSchema.parse(await res.json());
      if (parsed.code !== 0) throw new Error(`tikwm returned code ${parsed.code}: ${parsed.msg ?? "no message"}`);
      return parsed.data ?? [];
    } catch (err) {
      lastError = err;
      if (attempt < MAX_FEED_RETRIES) await sleep(500 * 2 ** attempt);
    }
  }
  throw new Error(
    `tikwm feed request failed after ${MAX_FEED_RETRIES + 1} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

interface TrendingResult {
  sounds: AggregatedSound[];
  pagesFetched: number;
  videosSeen: number;
  warnings: string[];
}

async function fetchTrending(region: string, pages: number): Promise<TrendingResult> {
  const byId = new Map<string, AggregatedSound>();
  const warnings: string[] = [];
  let videosSeen = 0;
  let pagesFetched = 0;

  for (let i = 0; i < pages; i++) {
    let items: FeedItem[];
    try {
      items = await fetchFeedPageWithRetry(region);
    } catch (err) {
      warnings.push(err instanceof Error ? err.message : String(err));
      continue;
    }
    pagesFetched++;
    for (const item of items) {
      videosSeen++;
      const mi = item.music_info;
      const rawId = mi?.id;
      if (rawId === undefined || rawId === "") continue;
      const id = String(rawId);
      const existing = byId.get(id);
      if (existing) {
        existing.count++;
        continue;
      }
      const title = mi?.title ?? "";
      const original = mi?.original ?? false;
      const isSong = !original && !title.toLowerCase().startsWith("original sound");
      byId.set(id, {
        id,
        title,
        author: mi?.author ?? "",
        album: mi?.album ?? "",
        cover: mi?.cover ?? "",
        duration: mi?.duration ?? 0,
        original,
        play: mi?.play ?? "",
        count: 1,
        exampleVideoId: String(item.video_id ?? item.id ?? ""),
        isSong,
      });
    }
  }

  if (pagesFetched === 0) {
    throw new HttpError(
      502,
      `tikwm feed unavailable for region ${region}: ${warnings[warnings.length - 1] ?? "unknown error"}`
    );
  }

  const sounds = [...byId.values()].sort((a, b) => {
    if (a.isSong !== b.isSong) return a.isSong ? -1 : 1;
    return b.count - a.count;
  });
  for (const sound of sounds) knownSounds.set(sound.id, sound);

  return { sounds, pagesFetched, videosSeen, warnings };
}

function toClientSound(s: AggregatedSound) {
  const { play, ...rest } = s;
  void play; // the raw CDN url stays server-side; the client uses /api/audio/:id
  return rest;
}

// ---------------------------------------------------------------------------
// Instagram flashapi feed: schema, on-disk cache, known-track registry
// ---------------------------------------------------------------------------

const FlashapiTrackSchema = z.looseObject({
  id: z.union([z.string(), z.number()]),
  audio_asset_id: z.union([z.string(), z.number()]).optional(),
  audio_cluster_id: z.union([z.string(), z.number()]).optional(),
  title: z.string().optional(),
  display_artist: z.string().optional(),
  ig_username: z.string().optional(),
  cover_artwork_uri: z.string().optional(),
  cover_artwork_thumbnail_uri: z.string().optional(),
  progressive_download_url: z.string().optional(),
  web_30s_preview_download_url: z.string().optional(),
  highlight_start_times_in_ms: z.array(z.number()).optional(),
  duration_in_ms: z.number().optional(),
  is_explicit: z.boolean().optional(),
  song_monetization_info: z.string().optional(),
  licensed_music_subtype: z.string().optional(),
});

const FlashapiMetadataSchema = z.looseObject({
  is_trending_in_clips: z.boolean().optional(),
  allow_media_creation_with_music: z.boolean().optional(),
});

const FlashapiItemSchema = z.looseObject({
  track: FlashapiTrackSchema,
  metadata: FlashapiMetadataSchema.optional(),
});

const FlashapiPageInfoSchema = z.looseObject({
  next_max_id: z.union([z.string(), z.number()]).optional(),
  more_available: z.boolean().optional(),
});

const FlashapiResponseSchema = z.looseObject({
  status: z.string(),
  items: z.array(FlashapiItemSchema).optional(),
  page_info: FlashapiPageInfoSchema.optional(),
});

type FlashapiResponse = z.infer<typeof FlashapiResponseSchema>;

const FlashapiQuotaSchema = z.object({
  remaining: z.string().nullable(),
  limit: z.string().nullable(),
});

/** What gets written to disk for every successful refresh. Re-validated with
 *  zod on read too, even though this process wrote it, so an older/partial
 *  cache file from a previous version of this spike doesn't crash a reload. */
const FlashapiCacheRecordSchema = z.object({
  fetchedAt: z.string(),
  quota: FlashapiQuotaSchema,
  maxIdRequested: z.string().nullable(),
  response: FlashapiResponseSchema,
});

type FlashapiCacheRecord = z.infer<typeof FlashapiCacheRecordSchema>;

interface IgTrack {
  id: string;
  title: string;
  artist: string;
  igUsername: string;
  cover: string;
  coverThumb: string;
  durationMs: number;
  isExplicit: boolean;
  monetization: string;
  licensedSubtype: string;
  highlightStartsMs: number[];
  isTrendingInClips: boolean;
  allowMediaCreationWithMusic: boolean;
  progressiveDownloadUrl: string;
  webPreviewUrl: string;
}

/** Same role as `knownSounds`: only ids that came out of a cached flashapi
 *  response are servable, so /api/ig/audio and /api/render never become an
 *  open proxy for arbitrary signed CDN urls. */
const knownIgTracks = new Map<string, IgTrack>();

function toIgTrack(item: z.infer<typeof FlashapiItemSchema>): IgTrack | null {
  const t = item.track;
  const id = String(t.id ?? "");
  if (!id) return null;
  return {
    id,
    title: t.title ?? "",
    artist: t.display_artist ?? "",
    igUsername: t.ig_username ?? "",
    cover: t.cover_artwork_uri ?? "",
    coverThumb: t.cover_artwork_thumbnail_uri ?? "",
    durationMs: t.duration_in_ms ?? 0,
    isExplicit: t.is_explicit ?? false,
    monetization: t.song_monetization_info ?? "",
    licensedSubtype: t.licensed_music_subtype ?? "",
    highlightStartsMs: t.highlight_start_times_in_ms ?? [],
    isTrendingInClips: item.metadata?.is_trending_in_clips ?? false,
    allowMediaCreationWithMusic: item.metadata?.allow_media_creation_with_music ?? false,
    progressiveDownloadUrl: t.progressive_download_url ?? "",
    webPreviewUrl: t.web_30s_preview_download_url ?? "",
  };
}

function toClientIgTrack(t: IgTrack) {
  const { progressiveDownloadUrl, ...rest } = t;
  void progressiveDownloadUrl; // stays server-side; the client uses /api/ig/audio/:id
  return rest;
}

/** Parses a cache record's items into IgTracks and (re)registers them in
 *  `knownIgTracks`, so a track from a previous run's cache is servable again
 *  after a restart, not just right after a fresh refresh. */
function ingestFlashapiRecord(record: FlashapiCacheRecord): IgTrack[] {
  const tracks: IgTrack[] = [];
  for (const item of record.response.items ?? []) {
    const track = toIgTrack(item);
    if (!track) continue;
    knownIgTracks.set(track.id, track);
    tracks.push(track);
  }
  return tracks;
}

async function listFlashapiCacheFiles(): Promise<string[]> {
  try {
    const names = await readdir(FLASHAPI_CACHE_DIR);
    // Filenames are `response-<epoch-ms>.json`; fixed-width numeric epoch
    // sorts lexically the same as chronologically.
    return names.filter((n) => n.startsWith(FLASHAPI_RESPONSE_PREFIX) && n.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

async function loadLatestFlashapiCache(): Promise<FlashapiCacheRecord | null> {
  const files = await listFlashapiCacheFiles();
  if (files.length === 0) return null;
  const latest = files[files.length - 1] as string;
  const raw = await Bun.file(path.join(FLASHAPI_CACHE_DIR, latest)).json();
  return FlashapiCacheRecordSchema.parse(raw);
}

async function saveFlashapiCache(record: FlashapiCacheRecord): Promise<void> {
  await mkdir(FLASHAPI_CACHE_DIR, { recursive: true });
  const fileName = `${FLASHAPI_RESPONSE_PREFIX}${Date.now()}.json`;
  await Bun.write(path.join(FLASHAPI_CACHE_DIR, fileName), JSON.stringify(record, null, 2));
}

/** The one network call to flashapi. No retry, no automatic invocation — this
 *  is only ever reached from the explicit "Обновить" action, because the
 *  subscription has a 30-request/month quota. */
async function fetchFlashapiTrending(
  maxId: string | undefined
): Promise<{ response: FlashapiResponse; quota: { remaining: string | null; limit: string | null } }> {
  if (!RAPIDAPI_KEY) {
    throw new HttpError(400, "Нет ключа: запусти с RAPIDAPI_KEY=…");
  }

  const url = new URL(FLASHAPI_TRENDING_PATH, FLASHAPI_BASE_URL);
  if (maxId) url.searchParams.set(FLASHAPI_MAX_ID_PARAM, maxId);

  const res = await fetch(url, {
    headers: {
      "x-rapidapi-host": FLASHAPI_HOST,
      "x-rapidapi-key": RAPIDAPI_KEY,
    },
  });
  const quota = {
    remaining: res.headers.get("x-ratelimit-requests-remaining"),
    limit: res.headers.get("x-ratelimit-requests-limit"),
  };
  if (!res.ok) throw new HttpError(502, `flashapi HTTP ${res.status}`);
  const response = FlashapiResponseSchema.parse(await res.json());
  return { response, quota };
}

// ---------------------------------------------------------------------------
// ffmpeg / ffprobe helpers
// ---------------------------------------------------------------------------

async function runFfmpeg(args: string[], timeoutMs: number): Promise<void> {
  const proc = Bun.spawn([FFMPEG_BIN, "-y", "-hide_banner", "-loglevel", "error", ...args], {
    stdout: "ignore",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  try {
    const [exitCode, stderrText] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (timedOut) throw new Error(`ffmpeg timed out after ${timeoutMs}ms`);
    if (exitCode !== 0) throw new Error(`ffmpeg exited ${exitCode}: ${stderrText.slice(-800)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function runFfprobeText(args: string[], timeoutMs = 10_000): Promise<string> {
  const proc = Bun.spawn([FFPROBE_BIN, ...args], { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (timedOut) throw new Error(`ffprobe timed out after ${timeoutMs}ms`);
    if (exitCode !== 0) throw new Error(`ffprobe exited ${exitCode}: ${stderr.slice(-500)}`);
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}

async function probeDurationSec(filePath: string): Promise<number> {
  const out = await runFfprobeText([
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  const seconds = Number.parseFloat(out.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`Could not determine audio duration for ${filePath}`);
  }
  return seconds;
}

/** Cyrillic drawtext needs a font with Cyrillic glyphs; fontconfig is not
 *  guaranteed to be configured for a static ffmpeg build, so a fontfile is
 *  probed directly. Falls back to no text overlay if nothing renders. */
async function detectDrawtextFont(): Promise<string | null> {
  const candidates = [
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/Library/Fonts/Arial Unicode.ttf",
  ];
  for (const font of candidates) {
    if (!existsSync(font)) continue;
    try {
      await runFfmpeg(
        [
          "-f", "lavfi", "-i", "testsrc2=size=64x64:duration=0.1",
          "-vf", `drawtext=fontfile='${font}':text='test':fontsize=10:fontcolor=white`,
          "-frames:v", "1",
          "-f", "null", "-",
        ],
        10_000
      );
      return font;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Audio caching
// ---------------------------------------------------------------------------

async function ensureAudioCached(sound: AggregatedSound): Promise<string> {
  const filePath = path.join(CACHE_DIR, `audio-${sanitizeForFilename(sound.id)}.mp3`);
  if (await fileExists(filePath)) return filePath;
  if (!sound.play) throw new HttpError(502, `Sound ${sound.id} has no playable audio URL.`);

  const res = await fetch(sound.play, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new HttpError(502, `Failed to download audio for ${sound.id}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());

  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await Bun.write(tmpPath, bytes);
  await rename(tmpPath, filePath);
  return filePath;
}

/** Downloads a flashapi track's `progressive_download_url` (AAC audio in an
 *  mp4 container) into the cache once, so the signed CDN url — which expires
 *  in a few days — is never needed again after that. */
async function ensureIgAudioCached(track: IgTrack): Promise<string> {
  const filePath = path.join(FLASHAPI_CACHE_DIR, `audio-${sanitizeForFilename(track.id)}.mp4`);
  if (await fileExists(filePath)) return filePath;
  if (!track.progressiveDownloadUrl) {
    throw new HttpError(502, `Track ${track.id} has no downloadable audio URL.`);
  }

  const res = await fetch(track.progressiveDownloadUrl);
  if (!res.ok) throw new HttpError(502, `Failed to download audio for ${track.id}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());

  await mkdir(FLASHAPI_CACHE_DIR, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await Bun.write(tmpPath, bytes);
  await rename(tmpPath, filePath);
  return filePath;
}

// ---------------------------------------------------------------------------
// Range-aware file serving
// ---------------------------------------------------------------------------

async function serveFileWithRange(filePath: string, contentType: string, req: Request): Promise<Response> {
  const fileStat = await stat(filePath);
  const size = fileStat.size;
  const range = req.headers.get("range");

  if (!range) {
    return new Response(Bun.file(filePath), {
      headers: { "Content-Type": contentType, "Content-Length": String(size), "Accept-Ranges": "bytes" },
    });
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (match[1] === "" && match[2] === "")) {
    return new Response("Malformed Range header", { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  }

  let start: number;
  let end: number;
  if (match[1] === "") {
    // suffix range: last N bytes
    const suffixLength = Number(match[2]);
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return new Response("Range not satisfiable", { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  }

  const chunk = Bun.file(filePath).slice(start, end + 1);
  return new Response(chunk, {
    status: 206,
    headers: {
      "Content-Type": contentType,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes",
    },
  });
}

// ---------------------------------------------------------------------------
// Route: GET /api/trending
// ---------------------------------------------------------------------------

async function handleTrending(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const region = (url.searchParams.get("region") || "US").trim().toUpperCase().slice(0, 8);
  const pages = Math.round(clamp(Number(url.searchParams.get("pages") ?? "3"), 1, 10));

  const result = await fetchTrending(region, pages);
  return jsonResponse({
    region,
    pagesRequested: pages,
    pagesFetched: result.pagesFetched,
    videosSeen: result.videosSeen,
    warnings: result.warnings,
    sounds: result.sounds.map(toClientSound),
  });
}

// ---------------------------------------------------------------------------
// Route: GET /api/audio/:id
// ---------------------------------------------------------------------------

async function handleAudio(req: Request, id: string): Promise<Response> {
  const sound = knownSounds.get(id);
  if (!sound) throw new HttpError(404, `Unknown sound id: ${id}. Load trending sounds first.`);
  const filePath = await ensureAudioCached(sound);
  return serveFileWithRange(filePath, "audio/mpeg", req);
}

// ---------------------------------------------------------------------------
// Routes: Instagram (flashapi) — GET /api/ig/trending, POST /api/ig/refresh,
// GET /api/ig/audio/:id
// ---------------------------------------------------------------------------

function flashapiClientPayload(hasKey: boolean, record: FlashapiCacheRecord | null, tracks: IgTrack[]) {
  return {
    hasKey,
    cache: record ? { fetchedAt: record.fetchedAt, quota: record.quota } : null,
    tracks: tracks.map(toClientIgTrack),
  };
}

/** Always reads from disk, never calls flashapi — this is the "free" path the
 *  page uses by default so browsing never spends quota. */
async function handleIgTrending(): Promise<Response> {
  const record = await loadLatestFlashapiCache();
  if (!record) return jsonResponse(flashapiClientPayload(Boolean(RAPIDAPI_KEY), null, []));
  const tracks = ingestFlashapiRecord(record);
  return jsonResponse(flashapiClientPayload(Boolean(RAPIDAPI_KEY), record, tracks));
}

const IgRefreshJsonSchema = z.object({ maxId: z.string().optional() });

/** The only path that spends a request out of the 30/month quota. Called
 *  exclusively from the explicit "Обновить" button — never automatically and
 *  never retried on failure. */
async function handleIgRefresh(req: Request): Promise<Response> {
  let maxId: string | undefined;
  const bodyText = await req.text();
  if (bodyText) {
    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch {
      throw new HttpError(400, "Invalid JSON body.");
    }
    const parsed = IgRefreshJsonSchema.safeParse(body);
    if (!parsed.success) throw new HttpError(400, "Invalid refresh request.");
    maxId = parsed.data.maxId;
  }

  const { response, quota } = await fetchFlashapiTrending(maxId);
  const record: FlashapiCacheRecord = {
    fetchedAt: new Date().toISOString(),
    quota,
    maxIdRequested: maxId ?? null,
    response,
  };
  await saveFlashapiCache(record);
  const tracks = ingestFlashapiRecord(record);
  return jsonResponse(flashapiClientPayload(true, record, tracks));
}

async function handleIgAudio(req: Request, id: string): Promise<Response> {
  const track = knownIgTracks.get(id);
  if (!track) throw new HttpError(404, `Unknown Instagram track id: ${id}. Load trending tracks first.`);
  const filePath = await ensureIgAudioCached(track);
  return serveFileWithRange(filePath, "audio/mp4", req);
}

// ---------------------------------------------------------------------------
// Route: POST /api/render
// ---------------------------------------------------------------------------

const RenderJsonSchema = z.object({
  id: z.string().min(1),
  startSec: z.number().optional(),
  lengthSec: z.number().optional(),
  videoKind: z.literal("generated"),
  trackSource: z.enum(["tiktok", "instagram"]).optional(),
});

type RenderKind = "generated" | "image" | "video";
type TrackSource = "tiktok" | "instagram";

interface RenderInput {
  id: string;
  startSec?: number;
  lengthSec?: number;
  kind: RenderKind;
  trackSource: TrackSource;
  uploadBytes?: Uint8Array;
  uploadMime?: string;
}

function parseTrackSource(v: FormDataEntryValue | null): TrackSource {
  return v === "instagram" ? "instagram" : "tiktok";
}

function numberOrUndefined(v: FormDataEntryValue | null): number | undefined {
  if (typeof v !== "string" || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function extForMime(mime: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
    "video/x-matroska": "mkv",
  };
  if (map[mime]) return map[mime];
  return mime.startsWith("image/") ? "img" : "bin";
}

async function parseRenderInput(req: Request): Promise<RenderInput> {
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();

  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    const id = form.get("id");
    if (typeof id !== "string" || !id) throw new HttpError(400, "Missing 'id' field.");
    const file = form.get("file");
    if (!(file instanceof File)) throw new HttpError(400, "Multipart request must include a 'file' upload.");
    const kind: RenderKind | null = file.type.startsWith("image/")
      ? "image"
      : file.type.startsWith("video/")
        ? "video"
        : null;
    if (!kind) throw new HttpError(400, `Unsupported upload type: ${file.type || "unknown"}.`);
    const uploadBytes = new Uint8Array(await file.arrayBuffer());
    if (uploadBytes.length === 0) throw new HttpError(400, "Uploaded file is empty.");
    return {
      id,
      startSec: numberOrUndefined(form.get("startSec")),
      lengthSec: numberOrUndefined(form.get("lengthSec")),
      kind,
      trackSource: parseTrackSource(form.get("trackSource")),
      uploadBytes,
      uploadMime: file.type,
    };
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "Invalid JSON body.");
  }
  const parsed = RenderJsonSchema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError(400, `Invalid render request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  return {
    id: parsed.data.id,
    startSec: parsed.data.startSec,
    lengthSec: parsed.data.lengthSec,
    kind: "generated",
    trackSource: parsed.data.trackSource ?? "tiktok",
  };
}

let drawtextFont: string | null = null;

function buildFfmpegArgs(opts: {
  kind: RenderKind;
  audioPath: string;
  uploadPath?: string;
  startSec: number;
  finalLength: number;
  fadeOutStart: number;
  outputPath: string;
}): string[] {
  const { kind, audioPath, uploadPath, startSec, finalLength, fadeOutStart, outputPath } = opts;

  const fadeFilter = `afade=t=in:st=0:d=0.5,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=1`;
  const audioInputArgs = ["-ss", startSec.toFixed(3), "-t", finalLength.toFixed(3), "-i", audioPath];
  const outputArgs = [
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-profile:v", "high",
    "-r", "30",
    "-c:a", "aac",
    "-ar", "44100",
    "-b:a", "192k",
    "-movflags", "+faststart",
    "-t", finalLength.toFixed(3),
  ];

  if (kind === "generated") {
    const videoInputArgs = ["-f", "lavfi", "-i", `testsrc2=size=1080x1920:rate=30:duration=${finalLength.toFixed(3)}`];
    const vf = drawtextFont
      ? `drawtext=fontfile='${drawtextFont}':text='тест музыки':fontsize=72:fontcolor=white:borderw=3:bordercolor=black@0.6:x=(w-text_w)/2:y=(h-text_h)/2,format=yuv420p`
      : "format=yuv420p";
    return [
      ...videoInputArgs, ...audioInputArgs,
      "-vf", vf, "-af", fadeFilter,
      "-map", "0:v:0", "-map", "1:a:0",
      ...outputArgs, outputPath,
    ];
  }

  if (kind === "image") {
    if (!uploadPath) throw new HttpError(400, "Image render requires an uploaded file.");
    const totalFrames = Math.max(1, Math.round(finalLength * 30));
    const videoInputArgs = ["-loop", "1", "-framerate", "30", "-t", finalLength.toFixed(3), "-i", uploadPath];
    // Ken Burns: slow, continuous zoom into the frame while cropping to 9:16.
    const vf =
      `scale=8000:-1,zoompan=z='min(zoom+0.0015,1.4)':d=${totalFrames}:` +
      `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920:fps=30,format=yuv420p`;
    return [
      ...videoInputArgs, ...audioInputArgs,
      "-vf", vf, "-af", fadeFilter,
      "-map", "0:v:0", "-map", "1:a:0",
      ...outputArgs, outputPath,
    ];
  }

  // video
  if (!uploadPath) throw new HttpError(400, "Video render requires an uploaded file.");
  const videoInputArgs = ["-i", uploadPath];
  const vf = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=yuv420p";
  return [
    ...videoInputArgs, ...audioInputArgs,
    "-vf", vf, "-af", fadeFilter,
    "-map", "0:v:0", "-map", "1:a:0",
    ...outputArgs, "-shortest", outputPath,
  ];
}

/** Resolves the cached audio file for a render request regardless of which
 *  source the track came from — the rest of the render pipeline (ffprobe for
 *  duration, ffmpeg args) is source-agnostic since it just reads whatever
 *  audio container is on disk. */
async function resolveRenderAudioPath(input: RenderInput): Promise<string> {
  if (input.trackSource === "instagram") {
    const track = knownIgTracks.get(input.id);
    if (!track) throw new HttpError(404, `Unknown Instagram track id: ${input.id}. Load trending tracks first.`);
    return ensureIgAudioCached(track);
  }
  const sound = knownSounds.get(input.id);
  if (!sound) throw new HttpError(404, `Unknown sound id: ${input.id}. Load trending sounds first.`);
  return ensureAudioCached(sound);
}

async function handleRender(req: Request): Promise<Response> {
  const input = await parseRenderInput(req);
  const audioPath = await resolveRenderAudioPath(input);
  const audioDuration = await probeDurationSec(audioPath);

  const requestedLength = clamp(input.lengthSec ?? 15, 5, 60);
  const maxStart = Math.max(0, audioDuration - 1);
  const startSec = clamp(input.startSec ?? 0, 0, maxStart);
  const finalLength = Math.min(requestedLength, Math.max(0.5, audioDuration - startSec));
  const fadeOutStart = Math.max(0, finalLength - 1);

  let uploadPath: string | undefined;
  if (input.uploadBytes) {
    const ext = extForMime(input.uploadMime ?? "");
    uploadPath = path.join(CACHE_DIR, `upload-${randomUUID()}.${ext}`);
    await Bun.write(uploadPath, input.uploadBytes);
  }

  const outputName = `render-${sanitizeForFilename(input.id)}-${Date.now()}.mp4`;
  const outputPath = path.join(CACHE_DIR, outputName);

  const args = buildFfmpegArgs({
    kind: input.kind,
    audioPath,
    uploadPath,
    startSec,
    finalLength,
    fadeOutStart,
    outputPath,
  });
  await runFfmpeg(args, RENDER_TIMEOUT_MS);

  return jsonResponse({
    ok: true,
    url: `/api/file/${outputName}`,
    startSec: Math.round(startSec * 100) / 100,
    lengthSec: Math.round(finalLength * 100) / 100,
  });
}

// ---------------------------------------------------------------------------
// Route: GET /api/file/:name
// ---------------------------------------------------------------------------

const RENDER_FILE_NAME_RE = /^render-[A-Za-z0-9_-]+-\d+\.mp4$/;

async function handleFile(name: string, req: Request): Promise<Response> {
  if (!RENDER_FILE_NAME_RE.test(name) || name !== path.basename(name)) {
    throw new HttpError(400, "Invalid file name.");
  }
  const filePath = path.join(CACHE_DIR, name);
  if (!(await fileExists(filePath))) throw new HttpError(404, "File not found.");
  return serveFileWithRange(filePath, "video/mp4", req);
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

await mkdir(CACHE_DIR, { recursive: true });
await mkdir(FLASHAPI_CACHE_DIR, { recursive: true });
drawtextFont = await detectDrawtextFont();
console.log(
  drawtextFont
    ? `drawtext overlay enabled (font: ${drawtextFont})`
    : "drawtext overlay disabled (no usable font/filter found on this machine)"
);

function startServer() {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    const port = START_PORT + attempt;
    try {
      return Bun.serve({
        hostname: HOST,
        port,
        idleTimeout: 120, // ffmpeg renders can take a while; don't let the connection idle out
        routes: {
          "/": Bun.file(INDEX_PATH),
          "/api/trending": { GET: (req) => withErrorHandling(() => handleTrending(req)) },
          "/api/audio/:id": { GET: (req) => withErrorHandling(() => handleAudio(req, req.params.id)) },
          "/api/ig/trending": { GET: () => withErrorHandling(() => handleIgTrending()) },
          "/api/ig/refresh": { POST: (req) => withErrorHandling(() => handleIgRefresh(req)) },
          "/api/ig/audio/:id": { GET: (req) => withErrorHandling(() => handleIgAudio(req, req.params.id)) },
          "/api/render": { POST: (req) => withErrorHandling(() => handleRender(req)) },
          "/api/file/:name": { GET: (req) => withErrorHandling(() => handleFile(req.params.name, req)) },
        },
      });
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Could not find a free port.");
}

const server = startServer();
console.log(`Music trends spike running at http://${server.hostname}:${server.port}`);
