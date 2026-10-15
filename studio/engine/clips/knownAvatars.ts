import { lstat } from "node:fs/promises";
import { dirname } from "node:path";
import type { Library } from "../library";
import { hasErrorCode } from "../library/durableFs";
import type { KnownAvatars } from "./copies";

/** What the look at an entry needs of the disk: `lstat` by default; a test plays another platform's answers. */
export type LookAtEntry = (path: string) => Promise<{ isDirectory(): boolean }>;

/**
 * The engine's view of a library for the library-open sweep of orphan clip copies (5b.2, S5.WA2, I5.59). A copy may go only when its avatar is not in the index AND `avatars/<id>/` is really gone
 * from the disk: `folderState` looks at the disk (`lstat`), whatever the index says. Anything that cannot be trusted keeps the copies:
 * - a sweep started for a library that is no longer the live one (`current` false) knows every avatar and every folder «unknown» (the copies it would list are another library's);
 * - a library whose own folder or `library.json` is not there now (an unmounted disk) says «unknown»;
 * - «gone» needs the PARENT `avatars/` to be a readable directory first: Windows answers ENOENT, not ENOTDIR, for a stat through a file or a missing parent, which must not read as «gone»;
 * - an id that is no library id, or any answer but «no such entry» under a readable parent, says «unknown».
 */
export function knownAvatarsOf(
  library: Pick<Library, "root" | "getAvatar" | "avatarDirPath">,
  current: () => boolean,
  isThere: (root: string) => Promise<boolean>,
  look: LookAtEntry = (path) => lstat(path),
): KnownAvatars {
  return {
    root: library.root,
    has: (avatarId) => !current() || library.getAvatar(avatarId) !== undefined,
    folderState: async (avatarId) => {
      if (!current() || !(await isThere(library.root))) return "unknown";
      try {
        const folder = library.avatarDirPath(avatarId);
        const parent = await look(dirname(folder));
        if (!parent.isDirectory()) return "unknown";
        try {
          await look(folder);
          return "there";
        } catch (error) {
          return hasErrorCode(error, "ENOENT") ? "gone" : "unknown";
        }
      } catch {
        return "unknown";
      }
    },
  };
}
