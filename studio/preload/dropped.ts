// 3f.6 round 2 (M13, the owner's decision of 2026-10-04): files dropped from Finder or Explorer onto «Мои». The trust design:
// - the page hands the preload `File` objects ONLY (never a path, never a string);
// - the preload asks Electron for each one's path (`webUtils.getPathForFile`). Only a file the OS put into the drop has one: a `File` the
//   page built itself (`new File([...], "x")`) answers an empty path and is dropped, so a page cannot forge a path; with `contextIsolation`
//   it cannot reach `ipcRenderer` to send one either;
// - main gets the paths over its own channel and treats them exactly as its own dialog's picks (`importDroppedMedia`, mediaImportFlow.ts):
//   the sender's frame, the 20-file rule, the no-follow open of a regular file, the size cap, the identity, then the engine.
// This module is the preload's mapping, kept apart from Electron so a test can hand it a fake `webUtils`.

/**
 * At most this many dropped files are looked at: the most a pick's answer lists (the contract's `MAX_REFUSED_FILES`, pinned by a test). The
 * rest are counted (`more`) and reported by main as `skipped`, never dropped silently. Not imported from the contract: the preload stays free of zod.
 */
export const MAX_DROPPED_FILES = 100;

/** What the preload sends main for a drop: the dropped files' paths, and how many more files were dropped than were looked at. */
export interface DroppedFiles {
  readonly paths: string[];
  readonly more: number;
}

/** Electron's `webUtils`, as far as this mapping uses it: the path the OS gave a dropped `File`, or an empty string. */
export interface PathSource {
  getPathForFile(file: File): unknown;
}

/** The paths of the dropped `files` that have one, in order; anything that is not a `File`, or has no path, is dropped. */
export function droppedFiles(files: unknown, source: PathSource): DroppedFiles {
  if (!Array.isArray(files)) return { paths: [], more: 0 };
  const looked = files.slice(0, MAX_DROPPED_FILES);
  const paths: string[] = [];
  for (const file of looked) {
    if (!(file instanceof File)) continue;
    const path = source.getPathForFile(file);
    if (typeof path === "string" && path.length > 0) paths.push(path);
  }
  return { paths, more: files.length - looked.length };
}
