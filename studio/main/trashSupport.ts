/**
 * Whether the system Trash can be trusted to take `path` (it is what «Удалить аватар» promises: never a permanent delete).
 *
 * macOS and Linux answer a refusal with an error from `shell.trashItem`, so nothing is pre-judged there. On Windows the call can DELETE FOR GOOD on a place
 * with no Recycle Bin (a network share, a mapped network drive), so a place that cannot be shown to have one is refused up front: a UNC path, a path with no
 * drive letter, and a drive whose root has no `$Recycle.Bin` (the folder Windows keeps per volume; a volume that never recycled anything lacks it, and is
 * refused too, with a clear text, rather than risked). `exists` is the folder look, injected so the rule is testable on any platform.
 */
export async function trashableOn(platform: NodeJS.Platform, path: string, exists: (path: string) => Promise<boolean>): Promise<boolean> {
  if (platform !== "win32") return true;
  const drive = /^([A-Za-z]):[\\/]/.exec(path);
  if (drive === null) return false; // a UNC path (`\\server\share`, `\\?\UNC\…`) or no drive at all
  try {
    return await exists(`${drive[1]}:\\$Recycle.Bin`);
  } catch {
    return false;
  }
}
