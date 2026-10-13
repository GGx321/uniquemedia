import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isAttemptId } from "../money/budget";
import { clipAttemptId, clipJournalPath, openClipJournal, parseClipAttemptId, summarizeJournal } from "./journal";
import { parseClipJournalLine, type ClipJournalLine } from "./schemas";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5b.1, S5.V3b (plan s5b1 §5.8, I5.45): `<clipId>.journal.jsonl`, append-only, one fsynced line per event. `requested` is written once per clip and comes before the first reserve;
// `submitted` comes after the 2xx and before the first poll. A line of a kind this build does not know is skipped, never fatal.

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "studio-clip-journal-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const AT = "2026-10-13T12:00:00.000Z";
const REQUESTED = {
  clipId: "clip-00001",
  photoId: "photo-00001",
  request: { model: "kling", quality: "std", seconds: 5, fallback: "auto" },
  motion: { source: "code", label: "Улыбка", text: "she smiles slowly" },
  acceptedWorstMicros: 850_000,
  at: AT,
} as const;

async function fileLines(path: string): Promise<string[]> {
  return (await readFile(path, "utf8")).split("\n").filter((l) => l !== "");
}

describe("attempt ids", () => {
  test("names the first attempt `<clipId>:video#1` and the second `<clipId>:video#2`", () => {
    expect(clipAttemptId("clip-00001", 1)).toBe("clip-00001:video#1");
    expect(clipAttemptId("clip-00001", 2)).toBe("clip-00001:video#2");
  });

  test("is an id the ledger accepts", () => {
    expect(isAttemptId(clipAttemptId("clip-00001", 2))).toBe(true);
  });

  test("reads a clip attempt id back, and nothing else", () => {
    expect(parseClipAttemptId("clip-00001:video#2")).toEqual({ clipId: "clip-00001", n: 2 });
    expect(parseClipAttemptId("run-1:img#1")).toBeNull();
    expect(parseClipAttemptId("clip-00001:video#3")).toBeNull();
    expect(parseClipAttemptId("clip-00001:video#")).toBeNull();
  });
});

describe("the journal file", () => {
  test("lives next to the record, named after the clip", () => {
    expect(clipJournalPath("/lib/avatars/a/clips", "clip-00001")).toBe(join("/lib/avatars/a/clips", "clip-00001.journal.jsonl"));
  });

  test("writes `requested` as the first line, valid to the schema", async () => {
    const path = join(dir, "clip-00001.journal.jsonl");
    await openClipJournal(path).requested(REQUESTED);
    const lines = await fileLines(path);
    expect(lines).toHaveLength(1);
    expect(parseClipJournalLine(JSON.parse(lines[0] ?? ""))).toEqual({ type: "requested", ...REQUESTED });
  });

  test("writes `requested` once, however often it is asked", async () => {
    const path = join(dir, "clip-00001.journal.jsonl");
    const journal = openClipJournal(path);
    await journal.requested(REQUESTED);
    await journal.requested(REQUESTED);
    expect(await fileLines(path)).toHaveLength(1);
  });

  test("writes `requested` once across two journals on one file (a recovery job reopens it)", async () => {
    const path = join(dir, "clip-00001.journal.jsonl");
    await openClipJournal(path).requested(REQUESTED);
    await openClipJournal(path).requested(REQUESTED);
    expect(await fileLines(path)).toHaveLength(1);
  });

  test("keeps the order of lines it was given", async () => {
    const path = join(dir, "clip-00001.journal.jsonl");
    const journal = openClipJournal(path);
    await journal.requested(REQUESTED);
    await journal.submitted({ attemptId: "clip-00001:video#1", model: "kling", providerJobId: "gen-1", at: AT });
    await journal.ended({ attemptId: "clip-00001:video#1", status: "completed", providerCostMicros: 420_000, costSource: "usage", at: AT });
    await journal.downloaded({ sha256: "a".repeat(64), bytes: 1234, at: AT });
    const types = (await journal.read()).map((l) => l.type);
    expect(types).toEqual(["requested", "submitted", "ended", "downloaded"]);
  });

  test("keeps the order of lines appended without waiting for each other", async () => {
    const path = join(dir, "clip-00001.journal.jsonl");
    const journal = openClipJournal(path);
    await journal.requested(REQUESTED);
    await Promise.all([
      journal.submitted({ attemptId: "clip-00001:video#1", model: "kling", providerJobId: "gen-1", at: AT }),
      journal.ended({ attemptId: "clip-00001:video#1", status: "failed", costSource: "none", at: AT }),
    ]);
    expect((await journal.read()).map((l) => l.type)).toEqual(["requested", "submitted", "ended"]);
  });

  test("refuses a provider job id that is not an opaque token, and writes nothing", async () => {
    const path = join(dir, "clip-00001.journal.jsonl");
    const journal = openClipJournal(path);
    await expect(journal.submitted({ attemptId: "clip-00001:video#1", model: "kling", providerJobId: "https://evil.example/x?sig=1", at: AT })).rejects.toThrow();
    expect(await journal.read()).toEqual([]);
  });

  test("refuses an `ended` line with no time", async () => {
    const journal = openClipJournal(join(dir, "clip-00001.journal.jsonl"));
    // @ts-expect-error V1's `ended` line requires `at`: the hold of a late `completed` is read from it after a restart.
    await expect(journal.ended({ attemptId: "clip-00001:video#1", status: "completed", costSource: "usage" })).rejects.toThrow();
  });

  test("reads a file that does not exist as an empty journal", async () => {
    expect(await openClipJournal(join(dir, "none.journal.jsonl")).read()).toEqual([]);
  });

  test("skips a line of a kind it does not know and a line that does not fit, and reads the rest", async () => {
    const path = join(dir, "clip-00001.journal.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({ type: "requested", ...REQUESTED }),
        JSON.stringify({ type: "from-the-future", at: AT }),
        "not json at all",
        JSON.stringify({ type: "submitted", attemptId: "clip-00001:video#1", model: "kling" }),
        JSON.stringify({ type: "ended", attemptId: "clip-00001:video#1", status: "completed", costSource: "usage", at: AT }),
        "",
      ].join("\n"),
    );
    expect((await openClipJournal(path).read()).map((l) => l.type)).toEqual(["requested", "ended"]);
  });

  test("ignores a torn last line (a crash cut the append short)", async () => {
    const path = join(dir, "clip-00001.journal.jsonl");
    await writeFile(path, `${JSON.stringify({ type: "requested", ...REQUESTED })}\n{"type":"submitted","attemptId":"clip-00001:vid`);
    expect((await openClipJournal(path).read()).map((l) => l.type)).toEqual(["requested"]);
  });

  test("appends after a torn last line without gluing onto it", async () => {
    const path = join(dir, "clip-00001.journal.jsonl");
    await writeFile(path, `${JSON.stringify({ type: "requested", ...REQUESTED })}\n{"type":"submitted","attemptId":"clip-00001:vid`);
    const journal = openClipJournal(path);
    await journal.submitted({ attemptId: "clip-00001:video#1", model: "kling", providerJobId: "gen-1", at: AT });
    expect((await journal.read()).map((l) => l.type)).toEqual(["requested", "submitted"]);
  });
});

describe("summarizeJournal", () => {
  const lines: ClipJournalLine[] = [
    { type: "requested", ...REQUESTED },
    { type: "submitted", attemptId: "clip-00001:video#1", model: "kling", providerJobId: "gen-1", at: AT },
    { type: "ended", attemptId: "clip-00001:video#1", status: "refused", costSource: "proof", at: "2026-10-13T12:03:00.000Z" },
    { type: "submitted", attemptId: "clip-00001:video#2", model: "grok", providerJobId: "gen-2", at: "2026-10-13T12:03:30.000Z" },
  ];

  test("finds the `requested` line", () => {
    expect(summarizeJournal(lines).requested?.clipId).toBe("clip-00001");
  });

  test("lists the attempts in the order they were submitted, each with what the journal knows of it", () => {
    const summary = summarizeJournal(lines);
    expect(summary.attempts.map((a) => a.attemptId)).toEqual(["clip-00001:video#1", "clip-00001:video#2"]);
    expect(summary.attempts[0]?.ended?.status).toBe("refused");
    expect(summary.attempts[0]?.providerJobId).toBe("gen-1");
    expect(summary.attempts[1]?.ended).toBeUndefined();
    expect(summary.attempts[1]?.model).toBe("grok");
  });

  test("knows an attempt that only has an `ended` line (a refusal at the submit: no job existed)", () => {
    const summary = summarizeJournal([{ type: "ended", attemptId: "clip-00001:video#1", status: "refused", costSource: "none", at: AT }]);
    expect(summary.attempts).toHaveLength(1);
    expect(summary.attempts[0]?.submittedAt).toBeUndefined();
  });

  test("finds the `downloaded` line, or null", () => {
    expect(summarizeJournal(lines).downloaded).toBeNull();
    expect(summarizeJournal([...lines, { type: "downloaded", sha256: "b".repeat(64), bytes: 10 }]).downloaded?.bytes).toBe(10);
  });

  test("is empty for an empty journal", () => {
    expect(summarizeJournal([])).toEqual({ requested: null, attempts: [], downloaded: null });
  });
});
