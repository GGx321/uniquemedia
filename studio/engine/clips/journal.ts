import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { appendJsonLine, hasErrorCode } from "../library/durableFs";
import { ClipJournalLine, parseClipJournalLine } from "./schemas";

// Stage 5, 5b.1, S5.V3b (plan s5b1 §5.8, I5.45): the clip's journal, `<clipId>.journal.jsonl`. Append-only, one fsynced line per event (`appendJsonLine` fsyncs the file and heals a torn tail
// first). `requested` is written once per clip and comes before the clip's first reserve; `submitted` comes after the 2xx and before the first poll or any other line. Every line is checked by V1's
// strict schema BEFORE it is written, so a malformed line (an `ended` with no `at`, a provider id that is a URL) is a throw, not a line a restart cannot read. A line of a kind this build does
// not know, or that does not fit, is skipped when reading, never fatal.

type Requested = Extract<ClipJournalLine, { type: "requested" }>;
type Submitted = Extract<ClipJournalLine, { type: "submitted" }>;
type Ended = Extract<ClipJournalLine, { type: "ended" }>;
type Downloaded = Extract<ClipJournalLine, { type: "downloaded" }>;

export interface ClipJournal {
  /** Once per clip: a second call, on this journal or another one on the same file, writes nothing. */
  requested(data: Omit<Requested, "type">): Promise<void>;
  submitted(data: Omit<Submitted, "type">): Promise<void>;
  ended(data: Omit<Ended, "type">): Promise<void>;
  downloaded(data: Omit<Downloaded, "type">): Promise<void>;
  /** The lines this build knows, in file order; a missing file is an empty journal. A torn last line is ignored. */
  read(): Promise<ClipJournalLine[]>;
}

/** The ledger id of a clip's n-th attempt (§5.7): 1 is the model the owner chose, 2 is the automatic Grok behind Kling. */
export function clipAttemptId(clipId: string, n: 1 | 2): string {
  return `${clipId}:video#${n}`;
}

/** The clip and attempt number an id names, or null for any other ledger id. */
export function parseClipAttemptId(attemptId: string): { clipId: string; n: 1 | 2 } | null {
  const match = /^(.+):video#([12])$/.exec(attemptId);
  if (match === null) return null;
  return { clipId: match[1] ?? "", n: match[2] === "2" ? 2 : 1 };
}

export function clipJournalPath(clipsDir: string, clipId: string): string {
  return join(clipsDir, `${clipId}.journal.jsonl`);
}

async function readLines(path: string): Promise<ClipJournalLine[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return [];
    throw error;
  }
  const lines = text.split("\n");
  lines.pop(); // the text after the last newline: complete lines end in one, so this is a torn append (or nothing)
  const known: ClipJournalLine[] = [];
  for (const raw of lines) {
    if (raw.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const line = parseClipJournalLine(parsed);
    if (line !== null) known.push(line);
  }
  return known;
}

export function openClipJournal(path: string): ClipJournal {
  let requestedWritten = false;
  // `async`: a line that fails the schema is a rejected promise, like every other failure of a write.
  const append = async (line: ClipJournalLine): Promise<void> => appendJsonLine(path, ClipJournalLine.parse(line));
  return {
    async requested(data) {
      if (requestedWritten) return;
      // Claimed before the first await, so two concurrent calls write one line; undone if the write fails, so a retry can still write it.
      requestedWritten = true;
      try {
        if ((await readLines(path)).some((l) => l.type === "requested")) return;
        // I5.67: an own motion's label is the owner's own words, and the journal never holds them; a restart takes it from the photo's motion store.
        const motion = data.motion.source === "own" ? { source: data.motion.source, text: data.motion.text } : data.motion;
        await append({ type: "requested", ...data, motion });
      } catch (error) {
        requestedWritten = false;
        throw error;
      }
    },
    submitted: (data) => append({ type: "submitted", ...data }),
    ended: (data) => append({ type: "ended", ...data }),
    downloaded: (data) => append({ type: "downloaded", ...data }),
    read: () => readLines(path),
  };
}

export interface JournalAttempt {
  attemptId: string;
  model?: Submitted["model"];
  providerJobId?: string;
  submittedAt?: string;
  ended?: Ended;
}

export interface JournalSummary {
  requested: Requested | null;
  /** In the order the journal first names them. */
  attempts: JournalAttempt[];
  downloaded: Downloaded | null;
}

/** What a journal says, attempt by attempt: the recovery's input (§5.12) and the restart holds'. */
export function summarizeJournal(lines: readonly ClipJournalLine[]): JournalSummary {
  const summary: JournalSummary = { requested: null, attempts: [], downloaded: null };
  const attemptOf = (attemptId: string): JournalAttempt => {
    let attempt = summary.attempts.find((a) => a.attemptId === attemptId);
    if (attempt === undefined) {
      attempt = { attemptId };
      summary.attempts.push(attempt);
    }
    return attempt;
  };
  for (const line of lines) {
    switch (line.type) {
      case "requested":
        summary.requested ??= line;
        break;
      case "submitted": {
        const attempt = attemptOf(line.attemptId);
        attempt.model = line.model;
        attempt.providerJobId = line.providerJobId;
        attempt.submittedAt = line.at;
        break;
      }
      case "ended":
        attemptOf(line.attemptId).ended = line;
        break;
      case "downloaded":
        summary.downloaded = line;
        break;
    }
  }
  return summary;
}
