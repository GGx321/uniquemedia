import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readFramePackNames } from "../src/node/framePack";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * Copies the frame-mode pack from where the build put it to a real folder.
 *
 * In the packaged app the pack sits inside `app.asar` (the renderer build
 * copies `public/` into `out/renderer/`), and ffmpeg is a separate process that
 * cannot open a path inside an archive. Electron's patched `fs` can read the
 * archive, so the images are read here and written to a plain folder under the
 * user's data directory.
 *
 * The shipped `CREDITS.json` is the only list of what belongs there. Each
 * listed file is compared by content (sha256), and written through a temporary
 * name and a rename so a crash never leaves a half-written image under a real
 * name; anything in the folder that the credits do not list is deleted, so the
 * rotation can never include a file the build did not ship.
 */
export async function extractFramePack(sourceDir: string, destDir: string): Promise<string> {
  const names = await readFramePackNames(sourceDir);
  const wanted = new Set([...names, "CREDITS.json"]);
  await mkdir(destDir, { recursive: true });

  for (const name of wanted) {
    const bytes = await readFile(join(sourceDir, name)).catch(() => {
      throw new Error(`Для режима «В рамке» не хватает фона ${name} в папке ${sourceDir}.`);
    });
    const to = join(destDir, name);
    const have = await readFile(to).then(sha256, () => null);
    if (have === sha256(bytes)) continue;
    const temp = `${to}.tmp`;
    await writeFile(temp, bytes);
    await rename(temp, to);
  }

  for (const name of await readdir(destDir)) {
    if (!wanted.has(name)) await rm(join(destDir, name), { recursive: true, force: true });
  }
  return destDir;
}
