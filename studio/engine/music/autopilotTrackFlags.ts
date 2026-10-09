import { z } from "zod";
import { Id } from "../../shared/engine";
import { readFile } from "node:fs/promises";
import { appendJsonLine, readJsonl, writeFileAtomic, type AtomicWriteOptions } from "../library/durableFs";
import { runExclusive } from "../library/keyedMutex";

// The «для автопилота» flag of an own track (Stage 4, S4.5d; plan §7). Media records are write-once, so the flag is an append-only log beside them,
// `<library>/media/autopilot-tracks.jsonl`, `{ mediaId, on, at }`: the LAST line per track wins (the pattern of `rejected.jsonl`).
//
// FAIL CLOSED. A log with a torn last line (a crash inside an append), a complete line that does not parse, or a file that cannot be read says «no own
// track is flagged»: the autopilot then has fewer tracks, never an unflagged one. Reading never throws.
//
// A WRITE over a damaged log refuses when a complete line is bad (nothing is appended to a log nobody can read). Over a torn tail it heals the log as every
// append does (`appendJsonLine` moves the tail aside), and first switches off every track the torn log had been hiding, so that the heal does not flag
// again what the owner was shown as unflagged.

/** The log's file name inside the library's `media/` folder. */
export const AUTOPILOT_TRACKS_FILE = "autopilot-tracks.jsonl";

const FlagLine = z.strictObject({ mediaId: Id, on: z.boolean(), at: z.iso.datetime() });
type FlagLine = z.infer<typeof FlagLine>;

/** The log cannot take a write: a line in it cannot be read, or the disk refused. Names no path. */
export class TrackFlagLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrackFlagLogError";
  }
}

/** The tracks the lines leave flagged: the last line per track wins. */
function replay(lines: readonly FlagLine[]): Set<string> {
  const flagged = new Set<string>();
  for (const entry of lines) {
    if (entry.on) flagged.add(entry.mediaId);
    else flagged.delete(entry.mediaId);
  }
  return flagged;
}

export class AutopilotTrackFlags {
  readonly #path: string;
  readonly #clock: () => number;

  readonly #hooks: AtomicWriteOptions;

  /** `hooks` is a test seam for the atomic swap of a torn log (`beforeRename` plays a crash before it). */
  constructor(path: string, clock: () => number, hooks: AtomicWriteOptions = {}) {
    this.#path = path;
    this.#clock = clock;
    this.#hooks = hooks;
  }

  /** The media ids the owner flagged; the empty set for a log that is missing-and-empty, torn, damaged or unreadable. Never throws. */
  async flagged(): Promise<ReadonlySet<string>> {
    try {
      const { entries, torn } = await readJsonl(this.#path, FlagLine);
      return torn === null ? replay(entries) : new Set<string>();
    } catch {
      return new Set<string>();
    }
  }

  /**
   * Sets the flag. The check «does it already stand?» and the write are ONE step under the log's lock, so racing `on` and `off` calls end in the state of the last one; a flag
   * that already stands writes nothing. A sound log gets one appended line (fsynced). A TORN log is replaced in one atomic swap (temp file, fsync, rename): the new log is the
   * whole lines, an «off» line for every flag the torn log was hiding, and the new line, so that at no moment is a hidden flag readable as on (a crash before the rename leaves
   * the torn log, which reads as closed); the torn tail is kept in `<log>.torn`. Rejects with `TrackFlagLogError` for a log with an unreadable line or a disk that refuses; with a
   * `ZodError` for an id that is not one.
   */
  async set(mediaId: string, on: boolean): Promise<void> {
    const line = FlagLine.parse({ mediaId, on, at: new Date(this.#clock()).toISOString() });
    await runExclusive(`autopilot-track-flags:${this.#path}`, async () => {
      let read;
      try {
        read = await readJsonl(this.#path, FlagLine);
      } catch {
        throw new TrackFlagLogError("the autopilot track flags could not be read, so nothing was written");
      }
      const standing = read.torn === null && replay(read.entries).has(mediaId);
      // A torn log reads as «nothing flagged», so an «off» has nothing to do there either.
      if (standing === on || (read.torn !== null && !on)) return;
      try {
        if (read.torn === null) {
          await appendJsonLine(this.#path, line);
          return;
        }
        const text = await readFile(this.#path, "utf8");
        const cut = text.lastIndexOf("\n") + 1;
        const offs = [...replay(read.entries)].filter((id) => id !== mediaId).map((id) => `${JSON.stringify({ mediaId: id, on: false, at: line.at })}\n`);
        const earlier = await readFile(`${this.#path}.torn`, "utf8").catch(() => "");
        await writeFileAtomic(`${this.#path}.torn`, `${earlier}${text.slice(cut)}\n`);
        await writeFileAtomic(this.#path, `${text.slice(0, cut)}${offs.join("")}${JSON.stringify(line)}\n`, this.#hooks);
      } catch {
        throw new TrackFlagLogError("the autopilot track flags could not be written");
      }
    });
  }
}
