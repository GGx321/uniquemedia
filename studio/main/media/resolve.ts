import { AVATARS_DIR, PHOTOS_DIR, VIDEOS_DIR } from "../../engine/library/layout";
import { VideoRecordSchema } from "../../engine/videos/record";
import { readRootId } from "../../engine/videos/rootMarker";
import { openDiskSource, type ByteSource, type MediaFsOps } from "./diskSource";
import { KINDS, type KindKey, type MediaKind } from "./kinds";
import type { MediaRoute } from "./route";

// Invariant 28 after K14: what each route serves, from which root, under which name, and of which kinds. A route
// builds its file names from vetted ids and a fixed extension list; nothing else about a request decides a path.
//
//   photo/<avatarId>/<photoId>    <library>/avatars/<avatarId>/photos/<photoId>.{jpg,png,webp}
//   video/<avatarId>/<videoId>    through the RECORD (below): <exportRoot>/<relPath>, an MP4
//   poster/<avatarId>/<videoId>   <library>/avatars/<avatarId>/videos/<videoId>.poster.{jpg,png,webp}   (K14)
//   track/<trackId>               <userData>/music/tracks/<trackId>.m4a
//   cover/<trackId>               <userData>/music/covers/<trackId>.{jpg,png,webp}
//   sticker/<stickerId>           the built-in catalogue (stickers.ts): APNG, from memory
//   text/<previewId>              <userData>/render-tmp/text/<previewId>.png
//   media/<mediaId>               <library>/media/<mediaId>.{jpg,png,webp,gif,apng,mp4,m4a}   (own uploads, 3f)
//
// A missing file, a wrong kind, a link, a file outside its root and a stale or foreign record all end the same
// way, `null`: the caller answers 404 and nothing tells them apart.

export interface MediaDeps {
  /** The library root from the current settings. */
  libraryRoot(): string;
  /** The export folder «Готовые видео» from the current settings, when there is one. */
  exportRoot(): string | undefined;
  /** `<userData>/music`: `tracks/` and `covers/` in it. */
  musicRoot(): string;
  /** `<userData>/render-tmp/text`: the engine's text preview PNGs. */
  textPreviewRoot(): string;
  /** The built-in stickers by id. */
  sticker(stickerId: string): Promise<ByteSource | null>;
  fs?: MediaFsOps;
}

export interface Served {
  readonly source: ByteSource;
  readonly contentType: string;
}

const MIB = 1024 * 1024;
const IMAGES: readonly KindKey[] = ["jpg", "png", "webp"];
const OWN_MEDIA: readonly KindKey[] = ["jpg", "png", "webp", "gif", "apng", "mp4", "m4a"];
/** A poster, a cover and a text preview are small pictures: a bigger file is not one of ours. */
const SMALL_IMAGE_BYTES = 8 * MIB;
/** A record is a few KiB of JSON. */
const MAX_RECORD_BYTES = 1 * MIB;

/** The first of `kinds` (in order) for which `<root>/<...dirs>/<name>.<ext>` is a servable file. */
async function firstOf(root: string, dirs: readonly string[], name: string, kinds: readonly KindKey[], maxBytes: number | undefined, deps: MediaDeps): Promise<Served | null> {
  for (const key of kinds) {
    const kind: MediaKind = KINDS[key];
    const source = await openDiskSource({ root, segments: [...dirs, `${name}.${kind.ext}`], maxBytes: Math.min(kind.maxBytes, maxBytes ?? kind.maxBytes), sniff: kind.sniff }, deps.fs);
    if (source !== null) return { source, contentType: kind.contentType };
  }
  return null;
}

/**
 * The `video` route. The record `<library>/avatars/<avatarId>/videos/<videoId>.json` is read (bounded, no link
 * followed) and must be this video's own, of a schema this build knows. Its file is served only when the export
 * folder now holds the root the record names: the marker's id must equal `file.rootId` (so an empty folder at the
 * same path, or another drive, is `elsewhere` and answers null). `relPath` is the record schema's
 * `<SafeName>/<file>.mp4`: no `..`, no separator but the one, no drive or absolute form. A `changed` file (other
 * size or hash than recorded) plays, as the plan says; a `missing` one is not there to serve.
 */
async function videoOf(route: Extract<MediaRoute, { route: "video" }>, deps: MediaDeps): Promise<Served | null> {
  const exportRoot = deps.exportRoot();
  if (exportRoot === undefined) return null;
  const recordSource = await openDiskSource(
    { root: deps.libraryRoot(), segments: [AVATARS_DIR, route.avatarId, VIDEOS_DIR, `${route.videoId}.json`], maxBytes: MAX_RECORD_BYTES, sniff: (header) => header[0] === 0x7b },
    deps.fs,
  );
  if (recordSource === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(await recordSource.read(0, recordSource.size)).toString("utf8"));
  } catch {
    return null;
  }
  const parsed = VideoRecordSchema.safeParse(json);
  if (!parsed.success) return null;
  const record = parsed.data;
  if (record.id !== route.videoId || record.avatarId !== route.avatarId) return null;

  const marker = await readRootId(exportRoot);
  if (marker.rootId === null || marker.rootId !== record.file.rootId) return null;

  const segments = record.file.relPath.split("/");
  if (segments.length !== 2 || segments.some((name) => name === "" || name === "." || name === "..")) return null;
  const source = await openDiskSource({ root: exportRoot, segments, maxBytes: KINDS.mp4.maxBytes, sniff: KINDS.mp4.sniff }, deps.fs);
  return source === null ? null : { source, contentType: KINDS.mp4.contentType };
}

/** What a route serves, or null. Never throws for a file problem. */
export async function resolveMedia(route: MediaRoute, deps: MediaDeps): Promise<Served | null> {
  switch (route.route) {
    case "photo":
      return firstOf(deps.libraryRoot(), [AVATARS_DIR, route.avatarId, PHOTOS_DIR], route.photoId, IMAGES, undefined, deps);
    case "video":
      return videoOf(route, deps);
    case "poster":
      return firstOf(deps.libraryRoot(), [AVATARS_DIR, route.avatarId, VIDEOS_DIR], `${route.videoId}.poster`, IMAGES, SMALL_IMAGE_BYTES, deps);
    case "track":
      return firstOf(deps.musicRoot(), ["tracks"], route.trackId, ["m4a"], undefined, deps);
    case "cover":
      return firstOf(deps.musicRoot(), ["covers"], route.trackId, IMAGES, SMALL_IMAGE_BYTES, deps);
    case "sticker": {
      const source = await deps.sticker(route.stickerId);
      return source === null ? null : { source, contentType: KINDS.apng.contentType };
    }
    case "text":
      return firstOf(deps.textPreviewRoot(), [], route.previewId, ["png"], SMALL_IMAGE_BYTES, deps);
    case "media":
      return firstOf(deps.libraryRoot(), ["media"], route.mediaId, OWN_MEDIA, undefined, deps);
  }
}
