import type { MediaUnsupportedReason } from "../shared/engine";
import { PNG_1X1 } from "../engine/library/testing/sampleData";

// The pure parts of the packaged smoke's own-media scenario (3f.1b), kept apart so they are tested. The scenario drives `media.pickImport`
// through main's E2E dialog stand-in (`--studio-pick-media`, one path): the file at that path is REWRITTEN between picks, one tiny file per
// case, and picked with `any`, so the kind comes from the bytes (never the name). Only a photo is accepted: the E2E build's stand-in
// importer (engine/media/e2ePhotoImporter.ts) takes a PNG. Every other kind has no importer yet and is refused `not-yet-supported`.

/** What one pick of a file must come to: a job that is started, or the refusal's reason. */
export type MediaSmokeExpectation = { readonly job: true } | { readonly refused: MediaUnsupportedReason };

export interface MediaSmokeFile {
  readonly label: string;
  readonly bytes: Uint8Array;
  readonly expect: MediaSmokeExpectation;
}

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

/** An ISO box file's first box: `ftyp` with a brand, 24 bytes. Enough to be told apart by the engine's sniffing and for nothing else. */
function ftyp(brand: string): Uint8Array {
  return Uint8Array.from([0, 0, 0, 24, ...ascii("ftyp"), ...ascii(brand), 0, 0, 0, 0, ...ascii(brand), ...ascii("mp41")]);
}

/** In the order they are picked: the photo first (the one that is stored), then each refusal. */
export const MEDIA_SMOKE_FILES: readonly MediaSmokeFile[] = [
  { label: "photo", bytes: PNG_1X1, expect: { job: true } },
  { label: "video", bytes: ftyp("isom"), expect: { refused: "not-yet-supported" } },
  { label: "audio", bytes: ftyp("M4A "), expect: { refused: "not-yet-supported" } },
  { label: "sticker", bytes: Uint8Array.from([...ascii("GIF89a"), 1, 0, 1, 0, 0, 0, 0]), expect: { refused: "not-yet-supported" } },
  { label: "text", bytes: Uint8Array.from(ascii("just some notes, not a media file\n")), expect: { refused: "format" } },
  { label: "heic", bytes: ftyp("heic"), expect: { refused: "heic" } },
];

/** The name the dialog stand-in's one path has, and what the stored photo's record must say of it. */
export const MEDIA_SMOKE_STORED = { kind: "photo", name: "smoke-media.png", width: 1, height: 1, bytes: PNG_1X1.length } as const;

/**
 * Problems with the library's `media/` folder (its names, without the `.staging` folder) after one photo was imported: exactly the stored
 * file `<id>.<ext>` and its record `<id>.json` must be there. Anything else is what a failed or crashed import leaves behind (a copy, a
 * part file, a temp file, an orphan) or what a cleanup missed.
 */
export function mediaRecordFileProblems(names: readonly string[], mediaId: string, extension: string): string[] {
  const wanted = [`${mediaId}.json`, `${mediaId}.${extension}`];
  return [...wanted.filter((name) => !names.includes(name)).map((name) => `${name} is missing`), ...names.filter((name) => !wanted.includes(name)).map((name) => `${name} is left in media/`)];
}
