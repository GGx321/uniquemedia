import { lstat } from "node:fs/promises";
import type { Library } from "../library";
import { hasErrorCode } from "../library/durableFs";
import type { KnownAvatars } from "./copies";

/**
 * The engine's view of a library for the library-open sweep of orphan clip copies (5b.2, S5.WA2, I5.59). A copy may go only when its avatar is not in the index AND `avatars/<id>/` is really gone
 * from the disk: `folderState` looks at the disk (`lstat`), whatever the index says. Anything that cannot be trusted keeps the copies:
 * - a sweep started for a library that is no longer the live one (`current` false) knows every avatar and every folder «unknown» (the copies it would list are another library's);
 * - a library whose own folder or `library.json` is not there now (an unmounted disk) says «unknown»;
 * - an id that is no library id, or any answer but «no such entry», says «unknown».
 */
export function knownAvatarsOf(library: Pick<Library, "root" | "getAvatar" | "avatarDirPath">, current: () => boolean, isThere: (root: string) => Promise<boolean>): KnownAvatars {
  return {
    root: library.root,
    has: (avatarId) => !current() || library.getAvatar(avatarId) !== undefined,
    folderState: async (avatarId) => {
      if (!current() || !(await isThere(library.root))) return "unknown";
      try {
        await lstat(library.avatarDirPath(avatarId));
        return "there";
      } catch (error) {
        return hasErrorCode(error, "ENOENT") ? "gone" : "unknown";
      }
    },
  };
}
