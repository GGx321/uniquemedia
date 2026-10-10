import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { Count } from "../../shared/engine";
import { appendJsonLine, healJsonlTail, readJsonl } from "../library/durableFs";
import { AUTO_REFRESH_MAX_AUTO_SENDS, AUTO_REFRESH_WINDOW_MS } from "./autoRefresh";
import { CLOCK_MAX_MS, CLOCK_MIN_MS } from "./quotaLedger";

// `userData/music/auto-sends.jsonl` (Stage 4, S4.5d; plan §7): the automatic refreshes, one `{ id, at }` line each. It is SEPARATE from the quota ledger on purpose: the
// ledger's `send` line is a strict object, so a new field would read as damage to an older build and close refreshes for 31 days. The id is the very id the ledger's `send`
// line carries, so the two files tell the same request.
//
// The line is written and fsynced BEFORE the request goes to the ledger's reserve (a crash between the two counts an automatic send that never left: the safe side).
// The count of automatic sends is the lines in the rolling 31 days. A torn tail (a crash inside an append) means the request was never sent: it is moved to `.torn` and the
// whole lines are counted. A file with a whole line that does not read, or that cannot be read at all, counts as the limit (10) and is `damaged` (the rule declines with
// `auto-log-damaged`): no automatic refresh, and the owner's own refreshes are not affected. Reading never throws.

/** The file's name inside `userData/music/`. */
export const AUTO_SENDS_FILE = "auto-sends.jsonl";

const AutoSendLine = z.strictObject({ id: z.string().min(1).max(64), at: Count.min(CLOCK_MIN_MS).max(CLOCK_MAX_MS) });

export interface AutoSendsSummary {
  /** Automatic sends in the rolling window; the limit (10) for a damaged file. */
  readonly count: number;
  /** The latest of them (epoch ms); null with none, and for a damaged file. */
  readonly lastAt: number | null;
  readonly damaged: boolean;
}

/** The log cannot take a line: it is damaged (so the count cannot be trusted), the time is not a real date, or the disk refused. Names no path. */
export class AutoSendsLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutoSendsLogError";
  }
}

export class AutoSendsLog {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  /**
   * What the file says at `now`. Never throws. `heal: false` is a look that writes nothing (the plan card's dry run): a torn tail is left where it is and the whole lines before it are
   * counted, which is what the count is after the heal.
   */
  async summary(now: number, options: { heal?: boolean } = {}): Promise<AutoSendsSummary> {
    try {
      let read = await readJsonl(this.#path, AutoSendLine);
      if (read.torn !== null && options.heal !== false) {
        // The line is fsynced BEFORE the ledger's reserve, so a torn tail means the append never finished and no request was sent: it is moved to `.torn` and the whole lines are
        // counted. A line that is whole and cannot be read is another matter (below).
        await healJsonlTail(this.#path);
        read = await readJsonl(this.#path, AutoSendLine);
        if (read.torn !== null) return damaged();
      }
      const { entries } = read;
      const windowStart = now - AUTO_REFRESH_WINDOW_MS;
      const inWindow = entries.filter((entry) => entry.at > windowStart);
      const lastAt = inWindow.reduce<number | null>((latest, entry) => (latest === null || entry.at > latest ? entry.at : latest), null);
      return { count: inWindow.length, lastAt, damaged: false };
    } catch {
      return damaged();
    }
  }

  /**
   * Appends `{ id, at }` and fsyncs it (the folder is made first: this runs before the ledger has made it). Refuses a file it cannot count, so a torn tail is never
   * healed by an append into a smaller count; refuses a time that is not a real date.
   */
  async record(id: string, at: number): Promise<void> {
    const line = AutoSendLine.safeParse({ id, at });
    if (!line.success) throw new AutoSendsLogError("the automatic send could not be recorded: its id or time is not valid");
    if ((await this.summary(at)).damaged) throw new AutoSendsLogError("the automatic sends file is damaged, so nothing was written");
    try {
      await mkdir(dirname(this.#path), { recursive: true });
      await appendJsonLine(this.#path, line.data);
    } catch {
      throw new AutoSendsLogError("the automatic sends file could not be written");
    }
  }
}

function damaged(): AutoSendsSummary {
  return { count: AUTO_REFRESH_MAX_AUTO_SENDS, lastAt: null, damaged: true };
}
