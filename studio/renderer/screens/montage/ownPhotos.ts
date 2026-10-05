import type { MediaSummary } from "../../../shared/engine";
import type { Size } from "../../../shared/montage";
import type { EngineClient } from "../../engine/client";
import { type MediaRecords, useMediaRecords } from "./ownMedia";

// 3-H1: what the editor knows of the own photos its draft's cells hold, from their records: the STORED size (the importer's upright JPEG), which is what
// the render crops a cell from (`ownPhotoSourceOf` → `cellChain`). The preview cuts the same window from the same size (`cellSourceWindow`), so the
// picture on screen is the part the video will show. Asked for BY ID (`media.list {kind: "photo", mediaIds}`, ownMedia.ts) and followed by `media.changed`.

/** An own photo as the preview uses it. */
export interface OwnPhoto {
  readonly mediaId: string;
  /** The stored photo's size, in its own (upright) pixels. */
  readonly width: number;
  readonly height: number;
}

export type OwnPhotos = MediaRecords<OwnPhoto>;

/** The preview's view of a media record: null for anything that is not a photo with a size (the contract gives every stored photo one). */
export function ownPhotoOf(summary: MediaSummary): OwnPhoto | null {
  if (summary.kind !== "photo" || summary.width === null || summary.height === null) return null;
  return { mediaId: summary.mediaId, width: summary.width, height: summary.height };
}

/** The stored size of the own photo `mediaId`, once its record is held; null before that, and for one the library no longer holds. */
export function ownPhotoSize(photos: OwnPhotos, mediaId: string): Size | null {
  const photo = photos.held.get(mediaId);
  return photo === undefined ? null : { w: photo.width, h: photo.height };
}

/** The own photos the draft's cells hold, by media id: asked by id, followed by `media.changed`. */
export function useOwnPhotos(client: Pick<EngineClient, "request" | "subscribe">, mediaIds: readonly string[]): OwnPhotos {
  return useMediaRecords(client, "photo", mediaIds, ownPhotoOf);
}
