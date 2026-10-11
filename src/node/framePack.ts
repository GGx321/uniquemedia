import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Where the repo keeps the frame-mode background pack. Under `public/` so the
 * renderer build copies it into the packaged app's `out/renderer/` without any
 * change to the packager config; a packaged app hands its own extracted copy to
 * the batch instead (see `electron/framePack.ts`).
 */
export const DEFAULT_FRAME_PACK_DIR = resolve(import.meta.dirname, "../../public/frame-backgrounds");

/** Credits name files by plain name only: no folder part, so a credit cannot point outside the pack. */
const PACK_FILE_NAME = /^[A-Za-z0-9._-]+\.jpg$/i;

/**
 * The names of the pack's images, as `CREDITS.json` lists them. The credits are
 * the one source of the rotation: an image that is in the folder but not in the
 * credits is not licensed information and is never used. The texts are Russian
 * because the app shows them as they are.
 */
export async function readFramePackNames(dir: string): Promise<string[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(dir, "CREDITS.json"), "utf8"));
  } catch {
    throw new Error(`Для режима «В рамке» нужен набор фонов с файлом CREDITS.json, а в папке ${dir} его нет.`);
  }
  const bad = `В файле CREDITS.json (папка ${dir}) должен быть список записей с полем file — именем .jpg без пути.`;
  if (!Array.isArray(parsed)) throw new Error(bad);
  const names = parsed.map((entry: unknown) => {
    const file = typeof entry === "object" && entry !== null && "file" in entry ? entry.file : undefined;
    if (typeof file !== "string" || !PACK_FILE_NAME.test(file)) throw new Error(bad);
    return file;
  });
  if (names.length === 0) {
    throw new Error(`Для режима «В рамке» нужен набор фонов, а в CREDITS.json (папка ${dir}) нет ни одного.`);
  }
  return [...new Set(names)].sort();
}

/**
 * The pack's images as absolute paths, in name order so a listing is the same
 * on every machine. Exactly the credited ones, each of which has to be a file.
 */
export async function listFrameBackgrounds(dir: string): Promise<string[]> {
  const names = await readFramePackNames(dir);
  for (const name of names) {
    const isFile = await stat(join(dir, name)).then((s) => s.isFile(), () => false);
    if (!isFile) throw new Error(`Для режима «В рамке» не хватает фона ${name} в папке ${dir}.`);
  }
  return names.map((name) => join(dir, name));
}
