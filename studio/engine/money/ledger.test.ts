import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MoneyError } from "./errors";
import { Ledger, type LedgerLine, type OpenFile, type ReserveLine } from "./ledger";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "studio-ledger-"));
  path = join(dir, "ledger.jsonl");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function reserve(attemptId: string, overrides: Partial<ReserveLine> = {}): ReserveLine {
  return {
    type: "reserve",
    attemptId,
    jobId: "job-1",
    scope: { runId: "run-1" },
    model: "x-ai/grok-imagine-image-2.0",
    worstMicros: 50_000,
    at: "2026-09-24T12:00:00.000Z",
    ...overrides,
  };
}

function jsonl(...lines: LedgerLine[]): string {
  return lines.map((l) => `${JSON.stringify(l)}\n`).join("");
}

async function expectMoneyError(promise: Promise<unknown>, code: MoneyError["code"]): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(MoneyError);
  expect(caught instanceof MoneyError ? caught.code : null).toBe(code);
}

test("append writes exactly one JSON line terminated by a newline", async () => {
  const ledger = await Ledger.open(path);
  const line = reserve("slot-1#1");

  await ledger.append(line);

  expect(await readFile(path, "utf8")).toBe(`${JSON.stringify(line)}\n`);
});

test("append writes, then fsyncs, then closes the file handle before resolving", async () => {
  const events: string[] = [];
  const openFile: OpenFile = async (p, flags) => {
    const handle: FileHandle = await open(p, flags);
    events.push(`open:${flags}`);
    const sync = handle.sync.bind(handle);
    const close = handle.close.bind(handle);
    const writeSpy = spyOn(handle, "write");
    spyOn(handle, "sync").mockImplementation(() => {
      events.push(`sync after ${writeSpy.mock.calls.length} write(s)`);
      return sync();
    });
    spyOn(handle, "close").mockImplementation(() => {
      events.push("close");
      return close();
    });
    return handle;
  };
  await writeFile(path, ""); // an existing ledger: the directory fsync on creation has its own test
  const ledger = await Ledger.open(path, { openFile });

  await ledger.append(reserve("slot-1#1"));
  events.push("resolved");

  expect(events).toEqual(["open:a", "sync after 1 write(s)", "close", "resolved"]);
});

/** Records `open <name> <flags>` and `sync <name>` for every handle, names relative to the temp dir ("." = the dir). */
function recordingOpen(events: string[]): OpenFile {
  return async (p, flags) => {
    const handle = await open(p, flags);
    const name = p === dir ? "." : p.slice(dir.length + 1);
    events.push(`open ${name} ${flags}`);
    const sync = handle.sync.bind(handle);
    spyOn(handle, "sync").mockImplementation(() => {
      events.push(`sync ${name}`);
      return sync();
    });
    return handle;
  };
}

test("the append that creates the ledger fsyncs its directory after the file", async () => {
  const events: string[] = [];
  const ledger = await Ledger.open(path, { openFile: recordingOpen(events), platform: "darwin" });

  await ledger.append(reserve("slot-1#1"));

  expect(events).toEqual(["open ledger.jsonl a", "sync ledger.jsonl", "open . r", "sync ."]);
});

test("appending to an existing ledger does not fsync the directory", async () => {
  await writeFile(path, jsonl(reserve("slot-1#1")));
  const events: string[] = [];
  const ledger = await Ledger.open(path, { openFile: recordingOpen(events), platform: "linux" });

  await ledger.append(reserve("slot-2#1"));
  await ledger.append(reserve("slot-3#1"));

  expect(events.filter((e) => e.includes(" ."))).toEqual([]);
});

test("the directory fsync is skipped on win32", async () => {
  const events: string[] = [];
  const ledger = await Ledger.open(path, { openFile: recordingOpen(events), platform: "win32" });

  await ledger.append(reserve("slot-1#1"));

  expect(events).toEqual(["open ledger.jsonl a", "sync ledger.jsonl"]);
});

test("creating <ledger>.torn fsyncs the directory; appending to it again does not", async () => {
  await writeFile(path, `${jsonl(reserve("slot-1#1"))}{"ty`);
  const events: string[] = [];
  const ledger = await Ledger.open(path, { openFile: recordingOpen(events), platform: "darwin" });

  await ledger.moveTornTail();
  const first = [...events];
  await ledger.append(reserve("slot-2#1"));
  await writeFile(path, `${await readFile(path, "utf8")}{"ty`);
  events.length = 0;
  await (await Ledger.open(path, { openFile: recordingOpen(events), platform: "darwin" })).moveTornTail();

  expect(first).toEqual(["open ledger.jsonl.torn a", "sync ledger.jsonl.torn", "open . r", "sync .", "open ledger.jsonl r+", "sync ledger.jsonl"]);
  expect(events.filter((e) => e.includes(" ."))).toEqual([]);
});

test("appended lines reload in order", async () => {
  const ledger = await Ledger.open(path);
  const a = reserve("slot-1#1");
  const b: LedgerLine = { type: "settle", attemptId: "slot-1#1", costMicros: 50_000, estimated: false, at: "2026-09-24T12:00:05.000Z" };
  await ledger.append(a);
  await ledger.append(b);

  const reloaded = await Ledger.open(path);

  expect(reloaded.lines).toEqual([a, b]);
  expect(reloaded.torn).toBeNull();
});

test("a missing ledger file opens empty and untorn", async () => {
  const ledger = await Ledger.open(join(dir, "nested", "ledger.jsonl"));

  expect(ledger.lines).toEqual([]);
  expect(ledger.torn).toBeNull();
  expect(ledger.lastWriteAt()).toBeNull();
});

test("the first append creates missing parent directories", async () => {
  const nested = join(dir, "nested", "deeper", "ledger.jsonl");
  const ledger = await Ledger.open(nested);

  await ledger.append(reserve("slot-1#1"));

  expect(await readFile(nested, "utf8")).toBe(jsonl(reserve("slot-1#1")));
});

test("a last line cut off mid-JSON is torn and the valid lines before it load", async () => {
  const valid = jsonl(reserve("slot-1#1"));
  const torn = `{"type":"settle","attemptId":"slo`;
  await writeFile(path, `${valid}${torn}`);

  const ledger = await Ledger.open(path);

  expect(ledger.lines).toEqual([reserve("slot-1#1")]);
  expect(ledger.torn).toEqual({ offset: Buffer.byteLength(valid), byteLength: Buffer.byteLength(torn) });
});

test("a complete last line that lacks only its newline is still torn", async () => {
  const valid = jsonl(reserve("slot-1#1"));
  const settle = JSON.stringify({ type: "settle", attemptId: "slot-1#1", costMicros: 1, estimated: false, at: "2026-09-24T12:00:05.000Z" });
  await writeFile(path, `${valid}${settle}`);

  const ledger = await Ledger.open(path);

  expect(ledger.lines).toEqual([reserve("slot-1#1")]);
  expect(ledger.torn?.offset).toBe(Buffer.byteLength(valid));
});

test("a newline-terminated last line with invalid JSON is torn", async () => {
  const valid = jsonl(reserve("slot-1#1"));
  const torn = `{"type":"sett\n`;
  await writeFile(path, `${valid}${torn}`);

  const ledger = await Ledger.open(path);

  expect(ledger.lines).toEqual([reserve("slot-1#1")]);
  expect(ledger.torn).toEqual({ offset: Buffer.byteLength(valid), byteLength: Buffer.byteLength(torn) });
});

test("the torn offset counts bytes, not characters, after multi-byte text", async () => {
  const release: LedgerLine = { type: "release", attemptId: "slot-1#1", reason: "сеть недоступна — ✗", at: "2026-09-24T12:00:01.000Z" };
  const valid = jsonl(reserve("slot-1#1"), release);
  await writeFile(path, `${valid}{"ty`);

  const ledger = await Ledger.open(path);

  expect(ledger.torn?.offset).toBe(Buffer.byteLength(valid));
  expect(ledger.torn?.offset).not.toBe(valid.length);
});

test("invalid JSON before the last line is corruption, not a torn tail", async () => {
  await writeFile(path, `{"type":"res\n${jsonl(reserve("slot-1#1"))}`);

  await expectMoneyError(Ledger.open(path), "LEDGER_CORRUPT");
});

test("a fractional amount in the file is corruption: amounts are integer micro-dollars", async () => {
  await writeFile(path, jsonl(reserve("slot-1#1", { worstMicros: 50_000.5 })));

  await expectMoneyError(Ledger.open(path), "LEDGER_CORRUPT");
});

test("a settle for an attempt with no reserve is corruption", async () => {
  await writeFile(path, jsonl({ type: "settle", attemptId: "ghost", costMicros: 0, estimated: false, at: "2026-09-24T12:00:00.000Z" }));

  await expectMoneyError(Ledger.open(path), "LEDGER_CORRUPT");
});

test("two closes of one attempt in the file are corruption", async () => {
  const settle: LedgerLine = { type: "settle", attemptId: "slot-1#1", costMicros: 0, estimated: false, at: "2026-09-24T12:00:01.000Z" };
  await writeFile(path, jsonl(reserve("slot-1#1"), settle, settle));

  await expectMoneyError(Ledger.open(path), "LEDGER_CORRUPT");
});

test("two reserves with one attempt id in the file are corruption", async () => {
  await writeFile(path, jsonl(reserve("slot-1#1"), reserve("slot-1#1")));

  await expectMoneyError(Ledger.open(path), "LEDGER_CORRUPT");
});

test("append refuses a fractional amount and writes nothing", async () => {
  const ledger = await Ledger.open(path);

  await expect(ledger.append(reserve("slot-1#1", { worstMicros: 0.5 }))).rejects.toThrow();

  expect(ledger.lines).toEqual([]);
  await expect(readFile(path, "utf8")).rejects.toThrow();
});

test("append refuses a second reserve for the same attempt id and writes nothing", async () => {
  const ledger = await Ledger.open(path);
  await ledger.append(reserve("slot-1#1"));

  await expectMoneyError(ledger.append(reserve("slot-1#1")), "ATTEMPT_ID_REUSED");

  expect(await readFile(path, "utf8")).toBe(jsonl(reserve("slot-1#1")));
});

test("append refuses a second close of the same attempt and writes nothing", async () => {
  const ledger = await Ledger.open(path);
  const settle: LedgerLine = { type: "settle", attemptId: "slot-1#1", costMicros: 0, estimated: false, at: "2026-09-24T12:00:01.000Z" };
  await ledger.append(reserve("slot-1#1"));
  await ledger.append(settle);

  await expectMoneyError(ledger.append({ ...settle, costMicros: 5 }), "ATTEMPT_CLOSED");

  expect(await readFile(path, "utf8")).toBe(jsonl(reserve("slot-1#1"), settle));
});

test("append refuses a close for an attempt with no reserve", async () => {
  const ledger = await Ledger.open(path);

  await expectMoneyError(
    ledger.append({ type: "release", attemptId: "ghost", reason: "x", at: "2026-09-24T12:00:00.000Z" }),
    "UNKNOWN_ATTEMPT"
  );
});

test("append refuses to write behind a torn tail and leaves the file unchanged", async () => {
  const content = `${jsonl(reserve("slot-1#1"))}{"ty`;
  await writeFile(path, content);
  const ledger = await Ledger.open(path);

  await expectMoneyError(ledger.append(reserve("slot-2#1")), "LEDGER_TORN");

  expect(await readFile(path, "utf8")).toBe(content);
});

test("after a failed write every later append rejects without opening the file", async () => {
  let opens = 0;
  const openFile: OpenFile = async (p, flags) => {
    opens++;
    const handle = await open(p, flags);
    spyOn(handle, "write").mockImplementation(() => Promise.reject(new Error("ENOSPC: no space left on device")));
    return handle;
  };
  const ledger = await Ledger.open(path, { openFile });

  await expect(ledger.append(reserve("slot-1#1"))).rejects.toThrow("ENOSPC");
  await expectMoneyError(ledger.append(reserve("slot-2#1")), "LEDGER_WRITE_FAILED");

  expect(opens).toBe(1);
  expect(ledger.lines).toEqual([]);
});

test("concurrent appends land as whole lines in call order", async () => {
  const ledger = await Ledger.open(path);
  const lines = Array.from({ length: 20 }, (_, i) => reserve(`slot-${i}#1`));

  await Promise.all(lines.map((l) => ledger.append(l)));

  expect(await readFile(path, "utf8")).toBe(jsonl(...lines));
});

test("lastWriteAt is the latest `at` of any line", async () => {
  await writeFile(
    path,
    jsonl(
      reserve("slot-1#1", { at: "2026-09-24T12:00:00.000Z" }),
      reserve("slot-2#1", { at: "2026-09-24T12:03:00.000Z" }),
      { type: "settle", attemptId: "slot-1#1", costMicros: 0, estimated: false, at: "2026-09-24T12:01:00.000Z" }
    )
  );

  const ledger = await Ledger.open(path);

  expect(ledger.lastWriteAt()).toBe(Date.parse("2026-09-24T12:03:00.000Z"));
});

test("moveTornTail appends the torn bytes to <ledger>.torn and truncates the ledger to its valid lines", async () => {
  const valid = jsonl(reserve("slot-1#1"));
  await writeFile(path, `${valid}{"type":"settle","att`);
  await writeFile(`${path}.torn`, "earlier\n");
  const ledger = await Ledger.open(path);

  expect(await ledger.moveTornTail()).toBe(true);

  expect(await readFile(path, "utf8")).toBe(valid);
  expect(await readFile(`${path}.torn`, "utf8")).toBe(`earlier\n{"type":"settle","att\n`);
  expect(ledger.torn).toBeNull();
  await ledger.append(reserve("slot-2#1"));
  expect((await Ledger.open(path)).lines).toEqual([reserve("slot-1#1"), reserve("slot-2#1")]);
});

test("moveTornTail on an untorn ledger changes nothing", async () => {
  await writeFile(path, jsonl(reserve("slot-1#1")));
  const ledger = await Ledger.open(path);

  expect(await ledger.moveTornTail()).toBe(false);

  expect(await readFile(path, "utf8")).toBe(jsonl(reserve("slot-1#1")));
  await expect(readFile(`${path}.torn`, "utf8")).rejects.toThrow();
});
