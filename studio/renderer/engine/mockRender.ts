import { isSafeName } from "../../shared/engine";
import type { MontageDraft } from "../../shared/engine/montage";

// The pure parts of the mock's render pipeline (Stage 3, 3d.1b): how a video is named in the export folder, its kind token, and
// the scene-photo cells of a spec. Each follows the real engine's rule (videos/service.ts, exportName.ts) without its disk, so a
// mock video has a `relPath` the contract accepts and the same shape as a real one. The engine's own copies live in engine code
// that needs Node; the parity suite (studio/engine/parity) holds the two together.

/** The most renders that may be queued or running together: the real queue's `MAX_UNFINISHED_RENDERS`. */
export const MOCK_MAX_UNFINISHED_RENDERS = 20;

/** A scene-photo cell of a spec and where it is (the issue's path). */
export interface SceneCell {
  readonly photoId: string;
  readonly path: (string | number)[];
}

/** Every scene-photo cell of a spec, in order, with where it is. */
export function sceneCells(spec: Pick<MontageDraft, "clips">): SceneCell[] {
  const cells: SceneCell[] = [];
  spec.clips.forEach((clip, i) => {
    if (clip.kind === "photo") {
      if (clip.cell.photo?.source === "scene") cells.push({ photoId: clip.cell.photo.photoId, path: ["clips", i, "cell"] });
    } else if (clip.kind === "collage") {
      clip.cells.forEach((cell, j) => {
        if (cell.photo?.source === "scene") cells.push({ photoId: cell.photo.photoId, path: ["clips", i, "cells", j] });
      });
    }
  });
  return cells;
}

/** The kind token of the file name: `photo` for photo clips only, a collage's layout when every clip is a collage of it, else `mix`. */
export function videoKindOf(clips: readonly { readonly kind: string; readonly layout?: string }[]): string {
  if (clips.every((clip) => clip.kind === "photo")) return "photo";
  const layouts = new Set(clips.map((clip) => (clip.kind === "collage" ? clip.layout : undefined)));
  const [only] = [...layouts];
  return layouts.size === 1 && only !== undefined ? only : "mix";
}

function reduceToSafe(raw: string): string {
  const trim = (text: string): string => text.replace(/^[_-]+|[_-]+$/g, "");
  return trim(trim(raw.normalize("NFC").replace(/[^A-Za-z0-9_-]+/g, "_")).slice(0, 64));
}

/**
 * The avatar's folder in the export folder: ASCII `[A-Za-z0-9_-]`, the name when it keeps at least two letters, else the avatar's
 * id. The engine's `safeName` also transliterates Cyrillic («Мия» is `Miya` there and an id here): the mock does not, and a dev
 * avatar with a Cyrillic name gets its id as the folder.
 */
export function mockFolderName(avatarName: string, avatarId: string): string {
  const own = reduceToSafe(avatarName);
  if ((own.match(/[A-Za-z]/g) ?? []).length >= 2 && isSafeName(own)) return own;
  const byId = reduceToSafe(avatarId);
  return isSafeName(byId) ? byId : "avatar";
}

/** `<folder>/<date>_<kind>_<NNN>.mp4`, the first counter no file holds, like the engine's name claim. */
export function mockRelPath(folder: string, date: string, kind: string, taken: ReadonlySet<string>): string {
  for (let n = 1; ; n++) {
    const path = `${folder}/${date}_${kind}_${String(n).padStart(3, "0")}.mp4`;
    if (!taken.has(path)) return path;
  }
}
