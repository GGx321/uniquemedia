import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectNoKeyFragment } from "../../testing/keyLeaks";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { CLOCK_MIN_MS, QUOTA_LIMIT, QUOTA_WINDOW_MS, QuotaLedger, QuotaLogError, summarize, type QuotaLine } from "./quotaLedger";
useNativeGlobals();

// Stage 3, task 3c.6 (from the 3c.3 review): a quota log with a complete line that cannot be read fails CLOSED, so the
// status reads 30 of 30 and nothing leaves, forever. The way out: the damaged file is put aside, and a new log starts
// that counts as 30 sends made NOW, so the quota is closed for exactly 31 days. Fail-closed at every step: a crash in the
// middle leaves either the damaged log (still closed) or the new one (closed for 31 days), never an empty one.

const NOW = Date.UTC(2026, 9, 3, 10, 15, 0);
const HOUR = 3600 * 1000;
const KEY = "Zq7-vKt9-Wm2x-Lp4s-0000";
const LAST4 = "0000";
const DAMAGED = `${JSON.stringify({ v: 1, kind: "send", id: "send-1", at: NOW - HOUR, key: LAST4 })}\nnot json at all\n`;

let dir = "";
let path = "";
let now = NOW;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "studio-quota-recover-"));
  path = join(dir, "music", "quota.jsonl");
  now = NOW;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ledger = (beforeReplace?: () => Promise<void>) => new QuotaLedger(path, { clock: () => now, ...(beforeReplace === undefined ? {} : { beforeReplace }) });

async function seedText(text: string): Promise<void> {
  await mkdir(join(dir, "music"), { recursive: true });
  await writeFile(path, text);
}

const send = (at: number, id = `send-${at}`): QuotaLine => ({ v: 1, kind: "send", id, at, key: LAST4 });
const recovered = (at: number, sends: number, rejectedKey: string | null = null): QuotaLine => ({ v: 1, kind: "recovered", at, sends, quarantined: "quota.jsonl.corrupt-20261003T101500Z", rejectedKey });

/** The names in the music folder other than the log itself. */
async function asides(): Promise<string[]> {
  return (await readdir(join(dir, "music"))).filter((name) => name !== "quota.jsonl").sort();
}

describe("a recovered line in the log", () => {
  test("counts as its sends, all made at its time", () => {
    expect(summarize([recovered(NOW, 30)], NOW)).toMatchObject({ sentInWindow: 30, refusal: "quota", nextFreeAt: NOW + QUOTA_WINDOW_MS });
  });

  test.each([
    [29, null],
    [30, "quota"],
    [31, "quota"],
  ] as const)("with %i sends a request is refused: %s", (sends, refusal) => {
    expect(summarize([recovered(NOW, sends)], NOW).refusal).toBe(refusal);
  });

  test("closes the quota for exactly 31 days: refused a ms before, free at the ms they end", () => {
    const lines = [recovered(NOW, 30)];
    expect(summarize(lines, NOW + QUOTA_WINDOW_MS - 1)).toMatchObject({ sentInWindow: 30, refusal: "quota" });
    expect(summarize(lines, NOW + QUOTA_WINDOW_MS)).toMatchObject({ sentInWindow: 0, refusal: null, nextFreeAt: null });
  });

  test("carries the rejected key it was given, and a later key change clears it", () => {
    expect(summarize([recovered(NOW, 30, LAST4)], NOW).rejectedKey).toBe(LAST4);
    expect(summarize([recovered(NOW, 30, LAST4), { v: 1, kind: "key", at: NOW + 1, key: "9999" }], NOW + 1).rejectedKey).toBeNull();
  });

  test("is a fresh start: no server figure and no good answer from before it are known", () => {
    expect(summarize([recovered(NOW, 30)], NOW)).toMatchObject({ serverRemaining: null, hadOkResult: false });
  });

  test("sends after it count on top", () => {
    expect(summarize([recovered(NOW - 2 * HOUR, 29), send(NOW - HOUR)], NOW)).toMatchObject({ sentInWindow: 30, refusal: "quota" });
  });
});

describe("recover", () => {
  test("puts the damaged file aside byte for byte and starts a new log of 30 sends made now", async () => {
    await seedText(DAMAGED);
    const answer = await ledger().recover({ rejectedKey: null });
    if (!answer.ok) throw new Error(`expected a recovery, got ${answer.refusal}`);
    expect(answer.quarantined).toBe("quota.jsonl.corrupt-20261003T101500Z");
    expect(await readFile(join(dir, "music", answer.quarantined ?? "(none)"), "utf8")).toBe(DAMAGED);
    const lines = (await readFile(path, "utf8")).split("\n").filter((line) => line !== "");
    expect(lines.map((line) => JSON.parse(line))).toEqual([{ v: 1, kind: "recovered", at: NOW, sends: QUOTA_LIMIT, quarantined: answer.quarantined, rejectedKey: null }]);
    expect(answer.summary).toMatchObject({ sentInWindow: 30, refusal: "quota", nextFreeAt: NOW + QUOTA_WINDOW_MS });
  });

  test("the new log is read like any other: 30 of 30 until exactly 31 days have passed", async () => {
    await seedText(DAMAGED);
    await ledger().recover({ rejectedKey: null });
    expect(await ledger().summary()).toMatchObject({ sentInWindow: 30, refusal: "quota", nextFreeAt: NOW + QUOTA_WINDOW_MS });
    now = NOW + QUOTA_WINDOW_MS - 1;
    expect(await ledger().reserve({ id: "refresh-0001", key: LAST4 })).toMatchObject({ ok: false, refusal: "quota" });
    now = NOW + QUOTA_WINDOW_MS;
    expect((await ledger().reserve({ id: "refresh-0002", key: LAST4 })).ok).toBe(true);
    expect((await ledger().summary()).sentInWindow).toBe(1);
  });

  test("keeps the rejected key it is given, so a revoked key stays revoked after a restart", async () => {
    await seedText(DAMAGED);
    await ledger().recover({ rejectedKey: LAST4 });
    expect((await ledger().summary()).rejectedKey).toBe(LAST4);
  });

  test("a sound log is not touched: refused as not corrupt, no file put aside", async () => {
    const sound = `${JSON.stringify(send(NOW - HOUR))}\n`;
    await seedText(sound);
    expect(await ledger().recover({ rejectedKey: null })).toEqual({ ok: false, refusal: "not-corrupt" });
    expect(await readFile(path, "utf8")).toBe(sound);
    expect(await asides()).toEqual([]);
  });

  test("a log with only a torn last line is sound (a crash, not corruption): not touched", async () => {
    const torn = `${JSON.stringify(send(NOW - HOUR))}\n{"v":1,"kind":"se`;
    await seedText(torn);
    expect(await ledger().recover({ rejectedKey: null })).toEqual({ ok: false, refusal: "not-corrupt" });
    expect(await readFile(path, "utf8")).toBe(torn);
  });

  test("no log at all is not corrupt either, and no file is made", async () => {
    expect(await ledger().recover({ rejectedKey: null })).toEqual({ ok: false, refusal: "not-corrupt" });
    expect(await readdir(dir)).toEqual([]);
  });

  test("a log that cannot be read at all is refused as unreadable and left as it is", async () => {
    await mkdir(path, { recursive: true });
    expect(await ledger().recover({ rejectedKey: null })).toEqual({ ok: false, refusal: "unreadable" });
    expect(await asides()).toEqual([]);
  });

  test.each([
    ["1970 (a dead clock battery)", 0],
    ["one ms before 2000", CLOCK_MIN_MS - 1],
    ["no number at all", Number.NaN],
  ])("a clock that reads %s cannot date the new log: refused, nothing changed", async (_label, clock) => {
    await seedText(DAMAGED);
    now = clock;
    expect(await ledger().recover({ rejectedKey: null })).toEqual({ ok: false, refusal: "clock" });
    expect(await readFile(path, "utf8")).toBe(DAMAGED);
    expect(await asides()).toEqual([]);
  });

  test("a crash before the new log replaces the old one leaves the damaged log in place, still closed, and a second try works", async () => {
    await seedText(DAMAGED);
    const crash = Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
    const failed = await ledger(async () => Promise.reject(crash)).recover({ rejectedKey: null }).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(QuotaLogError);
    expect(failed instanceof QuotaLogError ? failed.code : null).toBe("unwritable");
    expect(await readFile(path, "utf8")).toBe(DAMAGED);
    await expect(ledger().summary()).rejects.toMatchObject({ code: "corrupt" });

    now = NOW + 500;
    const again = await ledger().recover({ rejectedKey: null });
    if (!again.ok) throw new Error(`expected a recovery, got ${again.refusal}`);
    // The first try's copy stays; the second gets a name of its own within the same second.
    expect(await asides()).toEqual(["quota.jsonl.corrupt-20261003T101500Z", "quota.jsonl.corrupt-20261003T101500Z-2"]);
    expect(again.quarantined).toBe("quota.jsonl.corrupt-20261003T101500Z-2");
    expect((await ledger().summary()).sentInWindow).toBe(30);
  });

  test("its error never carries a path", async () => {
    await seedText(DAMAGED);
    const crash = Object.assign(new Error(`EIO: i/o error, rename '${path}'`), { code: "EIO" });
    const failed = await ledger(async () => Promise.reject(crash)).recover({ rejectedKey: null }).catch((error: unknown) => error);
    expect(failed instanceof Error ? failed.message : "").not.toContain(dir);
    expect(failed instanceof Error ? failed.message : "").toContain("EIO");
  });

  test("a recovery and a reserve asked at once never let a request out", async () => {
    await seedText(DAMAGED);
    const [recovery, reserve] = await Promise.allSettled([ledger().recover({ rejectedKey: null }), ledger().reserve({ id: "refresh-0001", key: LAST4 })]);
    expect(recovery.status).toBe("fulfilled");
    const admitted = reserve.status === "fulfilled" && reserve.value.ok;
    expect(admitted).toBe(false);
  });

  test("a whole key passed as the rejected key throws before anything is written", async () => {
    await seedText(DAMAGED);
    await expect(ledger().recover({ rejectedKey: KEY })).rejects.toThrow(TypeError);
    expect(await readFile(path, "utf8")).toBe(DAMAGED);
  });

  test("the new log holds no fragment of the key", async () => {
    await seedText(DAMAGED);
    await ledger().recover({ rejectedKey: LAST4 });
    expectNoKeyFragment(await readFile(path, "utf8"), KEY);
  });
});

// Review round 1 (LOW): what the damaged log still says, the sync after the swap, and the temps a crash leaves.
describe("recover keeps what the damaged log can still tell", () => {
  const lineOf = (line: QuotaLine): string => `${JSON.stringify(line)}\n`;
  const rejected: QuotaLine = { v: 1, kind: "result", id: "send-1", at: NOW - HOUR, key: "9z9z", outcome: "rejected", status: 401 };

  test("the last 401 its readable lines name is kept (an engine started on a damaged log knew of none): it only adds a refusal", async () => {
    await seedText(`${lineOf({ v: 1, kind: "send", id: "send-1", at: NOW - 2 * HOUR, key: "9z9z" })}${lineOf(rejected)}not json at all\n`);
    await ledger().recover({ rejectedKey: null });
    expect((await ledger().summary()).rejectedKey).toBe("9z9z");
  });

  test("the engine's own rejected key wins over the damaged log's", async () => {
    await seedText(`${lineOf(rejected)}not json at all\n`);
    await ledger().recover({ rejectedKey: LAST4 });
    expect((await ledger().summary()).rejectedKey).toBe(LAST4);
  });

  test("a key change after the 401 in the damaged log clears it there too", async () => {
    await seedText(`${lineOf(rejected)}${lineOf({ v: 1, kind: "key", at: NOW - HOUR + 1, key: "9z9z" })}not json at all\n`);
    await ledger().recover({ rejectedKey: null });
    expect((await ledger().summary()).rejectedKey).toBeNull();
  });

  test("a damaged log with a send dated after now (the clock stepped back) closes the quota from that send, not from now", async () => {
    const later = NOW + 10 * 24 * HOUR;
    await seedText(`${lineOf({ v: 1, kind: "send", id: "send-1", at: later, key: LAST4 })}not json at all\n`);
    const answer = await ledger().recover({ rejectedKey: null });
    expect(answer.ok ? answer.summary.nextFreeAt : null).toBe(later + QUOTA_WINDOW_MS);
    now = later + QUOTA_WINDOW_MS - 1;
    expect((await ledger().summary()).refusal).toBe("quota");
  });
});

describe("the swap itself", () => {
  test("a folder sync that fails after the new log is in place does not report the recovery failed: the new log IS the log", async () => {
    await seedText(DAMAGED);
    const seen: string[] = [];
    const flaky = new QuotaLedger(path, {
      clock: () => now,
      syncDir: async () => {
        seen.push(await readFile(path, "utf8").catch(() => ""));
        throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
      },
    });
    const answer = await flaky.recover({ rejectedKey: null });
    expect(answer.ok).toBe(true);
    // The sync after the rename went through the best-effort seam: the log it saw was already the new one.
    expect(seen.some((text) => text.includes('"kind":"recovered"'))).toBe(true);
    expect((await ledger().summary()).sentInWindow).toBe(QUOTA_LIMIT);
  });

  test("a temp file a crash left beside the log is swept when the log is first read; nothing else is touched", async () => {
    await seedText(`${JSON.stringify({ v: 1, kind: "send", id: "send-1", at: NOW - HOUR, key: LAST4 })}\n`);
    await writeFile(join(dir, "music", ".quota.jsonl.a1b2c3d4e5f6.tmp"), "half a log");
    await writeFile(join(dir, "music", ".other.json.a1b2c3d4e5f6.tmp"), "not ours");
    await writeFile(join(dir, "music", "quota.jsonl.corrupt-20261003T101500Z"), "kept");
    await ledger().summary();
    expect(await asides()).toEqual([".other.json.a1b2c3d4e5f6.tmp", "quota.jsonl.corrupt-20261003T101500Z"]);
  });
});
