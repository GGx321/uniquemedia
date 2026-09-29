import { createExclusiveNoFollow } from "../library/openRegular";

// The render's output file is created by the JOB, right before pass 2 writes it by path (`-y`, for the whole render), so
// ffmpeg only ever truncates a file this job made a moment ago. The create is exclusive and does not follow a link, on
// every platform, by the library's shared helper (`createExclusiveNoFollow`):
//   - POSIX: an `lstat` first (anything at the name, a dangling link too, is EEXIST), then `wx`, then the handle's identity
//     is compared with what the name leads to;
//   - WINDOWS has no `O_NOFOLLOW`, and `CREATE_NEW` without `FILE_FLAG_OPEN_REPARSE_POINT` FOLLOWS a DANGLING symlink and
//     creates its target. The `lstat` before the open is what keeps that out (a link that wins the race between the two has
//     already made its target: a residual window that needs write access to the avatar's export folder, and the file is empty).

/** Creates the empty file at `path`; rejects with EEXIST for anything already there or taken meanwhile. */
export async function createTempExclusive(path: string): Promise<void> {
  await createExclusiveNoFollow(path);
}
