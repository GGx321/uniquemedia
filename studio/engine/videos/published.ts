import { join } from "node:path";
import { z } from "zod";
import { Id } from "../../shared/engine";
import { appendJsonLine, hasErrorCode, readJsonl } from "../library/durableFs";
import { runExclusive } from "../library/keyedMutex";
import { AVATARS_DIR } from "../library/layout";

// The owner's «Опубликовано» marks (Stage 4 plan §8.4). A video record is write-once (the commit is `link(intent, record)`), so a mark never touches it: it lives in an
// append-only log beside `rejected.jsonl`, `avatars/<avatarId>/published.jsonl`, one line `{ videoId, published, at }` per change, the LAST line of a video winning.
// Studio never deletes anything because of a mark, and nothing depends on it (decision 4): a log that cannot be read leaves every mark UNKNOWN and the videos
// are shown unmarked, with a notice (`videos.list`'s `published: "unknown"`).
//
// Unknown is one of two things, told apart because they end differently:
// - `torn`: the last line has no newline, an append a crash cut short. A read changes nothing; the next mark heals it the way every log of the library is healed (the tail
//   is moved to `<file>.torn`, never discarded), so the earlier marks read again.
// - `corrupt`: a COMPLETE line that is not a mark. A crash cannot make one, so the log is not guessed at and not appended to: a new mark is refused until the file is looked at.

export const PUBLISHED_FILE = "published.jsonl";

/** One line of the log. Loose, so a field a later build adds does not make the marks unreadable. */
const PublishedLine = z.looseObject({ videoId: Id, published: z.boolean(), at: z.iso.datetime() });

/** `absent`: there is no log (nothing was ever marked). `ok`: `at` holds the time of the mark of every video whose last line sets it. */
export type PublishedRead = { state: "absent" } | { state: "ok"; at: ReadonlyMap<string, string> } | { state: "unknown"; reason: "torn" | "corrupt" };

/** A mark was asked while the log cannot be read as it stands (a complete line that is not a mark): nothing was written. */
export class PublishedUnreadableError extends Error {
  constructor() {
    super("the published marks cannot be read");
    this.name = "PublishedUnreadableError";
  }
}

/** `avatars/<avatarId>/published.jsonl`. The avatar id is a library id (no separators), so nothing here can leave the folder. */
export function publishedPath(libraryRoot: string, avatarId: string): string {
  if (!Id.safeParse(avatarId).success) throw new TypeError("publishedPath: not an avatar id");
  return join(libraryRoot, AVATARS_DIR, avatarId, PUBLISHED_FILE);
}

/** What the log holds: the marks its complete lines leave (last line of a video wins), and whether a torn tail follows them. `bad`: a complete line is not a mark, or the disk would not answer. */
type Scan = { kind: "absent" } | { kind: "bad" } | { kind: "lines"; marks: Map<string, string>; torn: boolean };

async function scan(path: string): Promise<Scan> {
  let read;
  try {
    read = await readJsonl(path, PublishedLine);
  } catch (error) {
    // `readJsonl` reports a complete line that is not a mark as `corrupt-log`; a disk that fails is no verdict on the marks either, and is told the same way.
    return hasErrorCode(error, "ENOENT") ? { kind: "absent" } : { kind: "bad" };
  }
  if (read.entries.length === 0 && read.torn === null) return { kind: "absent" };
  const marks = new Map<string, string>();
  for (const line of read.entries) {
    if (line.published) marks.set(line.videoId, line.at);
    else marks.delete(line.videoId);
  }
  return { kind: "lines", marks, torn: read.torn !== null };
}

/** The marks of one avatar, as the log says now. Reads only: a torn tail is left where it is. */
export async function readPublished(libraryRoot: string, avatarId: string): Promise<PublishedRead> {
  const found = await scan(publishedPath(libraryRoot, avatarId));
  if (found.kind === "absent") return { state: "absent" };
  if (found.kind === "bad") return { state: "unknown", reason: "corrupt" };
  return found.torn ? { state: "unknown", reason: "torn" } : { state: "ok", at: found.marks };
}

/**
 * Sets or clears the mark of one video. Idempotent: a mark that already is what is asked appends nothing (over a torn tail it appends one line to heal it) and keeps its first time,
 * so the log grows only when the owner changes his mind. `changed` says whether the mark changed; `at` is the video's time afterwards (null when it is not marked). A log with a complete bad line refuses
 * (`PublishedUnreadableError`) and is not touched; a torn tail is healed by the append, and the marks compared against are the complete lines before it. Marks of one avatar are
 * done one at a time.
 */
export async function markPublished(libraryRoot: string, avatarId: string, videoId: string, published: boolean, at: string): Promise<{ changed: boolean; at: string | null }> {
  const path = publishedPath(libraryRoot, avatarId);
  return runExclusive(`published:${path}`, async () => {
    const found = await scan(path);
    if (found.kind === "bad") throw new PublishedUnreadableError();
    const current = found.kind === "lines" ? (found.marks.get(videoId) ?? null) : null;
    const unchanged = published ? current !== null : current === null;
    const torn = found.kind === "lines" && found.torn;
    // A mark that already is what is asked appends nothing, EXCEPT over a torn tail: the append is what heals it (the tail goes to `.torn`), so the owner's toggle is never stuck
    // behind an `unknown` list. The line keeps the first time of a mark that was already set.
    if (unchanged && !torn) return { changed: false, at: current };
    const lineAt = published ? (current ?? at) : at;
    await appendJsonLine(path, PublishedLine.parse({ videoId, published, at: lineAt }));
    return { changed: !unchanged, at: published ? lineAt : null };
  });
}
