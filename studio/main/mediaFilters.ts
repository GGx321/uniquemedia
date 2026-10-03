import type { MediaPickKind } from "../shared/engine";

// The per-kind filters of main's own file dialog (3f.1). They are a convenience for the owner and never a check: the extension of a picked
// file is not read again, the engine judges its bytes. Names are what the native dialog shows. One place, so each per-kind task (3f.2 to
// 3f.5) changes the list of its own kind here and nowhere else.

export interface DialogFilter {
  name: string;
  /** Lower case, no dot, never `*`. */
  extensions: string[];
}

const PHOTO: DialogFilter = { name: "Photos", extensions: ["jpg", "jpeg", "png", "webp", "heic", "heif"] };
const VIDEO: DialogFilter = { name: "Videos", extensions: ["mp4", "mov", "m4v"] };
const AUDIO: DialogFilter = { name: "Music", extensions: ["mp3", "m4a", "aac", "wav", "flac", "ogg", "opus"] };
const STICKER: DialogFilter = { name: "Stickers", extensions: ["gif", "png"] };

export const MEDIA_DIALOG_FILTERS: Readonly<Record<MediaPickKind, readonly DialogFilter[]>> = {
  photo: [PHOTO],
  video: [VIDEO],
  audio: [AUDIO],
  sticker: [STICKER],
  any: [{ name: "Photos, videos, music and stickers", extensions: [...new Set([PHOTO, VIDEO, AUDIO, STICKER].flatMap((f) => f.extensions))] }],
};
