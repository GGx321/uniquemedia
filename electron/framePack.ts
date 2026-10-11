import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Copies the frame-mode pack from where the build put it to a real folder.
 *
 * In the packaged app the pack sits inside `app.asar` (the renderer build
 * copies `public/` into `out/renderer/`), and ffmpeg is a separate process that
 * cannot open a path inside an archive. Electron's patched `fs` can read the
 * archive, so the images are read here and written to a plain folder under the
 * user's data directory. A file already there with the shipped size is kept, so
 * only the first frame-mode run pays for the copy.
 */
export async function extractFramePack(sourceDir: string, destDir: string): Promise<string> {
  let names: string[];
  try {
    names = (await readdir(sourceDir)).filter((n) => /\.(jpg|json)$/i.test(n));
  } catch {
    throw new Error(`Frame mode needs its background pack, and ${sourceDir} cannot be read.`);
  }
  await mkdir(destDir, { recursive: true });
  for (const name of names) {
    const to = join(destDir, name);
    const wanted = (await stat(join(sourceDir, name))).size;
    const have = await stat(to).then((s) => s.size, () => -1);
    if (have === wanted) continue;
    await writeFile(to, await readFile(join(sourceDir, name)));
  }
  return destDir;
}
