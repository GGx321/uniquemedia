import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { QUOTA_LIMIT, QUOTA_WINDOW_MS, QuotaLedger, QuotaLogError, quotaMarkerPath, type QuotaLine } from "./quotaLedger";
useNativeGlobals();

// Review round 1 (MEDIUM, money): the quota log lives in `userData/music/` beside ~100 MB of tracks, and deleting that folder
// to free space reset the count, and the server's floor with it (the floor comes only from an answer that says
// `remaining: 0`; a 429 without that header sets none). A marker OUTSIDE `music/` remembers that the log existed: a log that
// is gone (or holds no line) while the marker is there reads `missing`, closed like a corrupt one and recovered the same way.
// Only a real first start (no marker) reads as a fresh, empty log.

const NOW = Date.UTC(2026, 9, 3, 10, 15, 0);
const HOUR = 3600 * 1000;
const LAST4 = "0000";

let dir = "";
let path = "";
let now = NOW;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "studio-quota-marker-"));
  path = join(dir, "music", "quota.jsonl");
  now = NOW;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ledger = () => new QuotaLedger(path, { clock: () => now });
const marker = () => join(dir, ".music-quota-started");
const exists = (target: string) => stat(target).then(
  () => true,
  () => false,
);

async function seed(lines: readonly QuotaLine[]): Promise<void> {
  await mkdir(join(dir, "music"), { recursive: true });
  await writeFile(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
}

const send = (at: number): QuotaLine => ({ v: 1, kind: "send", id: `send-${at}`, at, key: LAST4 });
const zero = (at: number): QuotaLine => ({ v: 1, kind: "result", id: `send-${at}`, at, key: LAST4, outcome: "http-error", status: 429, remaining: 0 });

const missing = async (work: Promise<unknown>): Promise<void> => {
  const error = await work.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(QuotaLogError);
  expect(error instanceof QuotaLogError ? error.code : null).toBe("missing");
};

describe("the marker", () => {
  test("sits beside the music folder, never in it", () => {
    expect(quotaMarkerPath(path)).toBe(marker());
  });

  test("a fresh install has neither: the log reads empty, a request may leave, and the first line leaves the marker", async () => {
    expect(await ledger().summary()).toMatchObject({ sentInWindow: 0, refusal: null });
    expect(await exists(marker())).toBe(false);
    expect((await ledger().reserve({ id: "refresh-0001", key: LAST4 })).ok).toBe(true);
    expect(await exists(marker())).toBe(true);
  });

  test("a log from before the marker (an older Studio) gets one when it is read", async () => {
    await seed([send(NOW - HOUR)]);
    await ledger().summary();
    expect(await exists(marker())).toBe(true);
  });

  // Round-2 verify (MEDIUM): only a line that counts a request may leave the marker. A log of key lines alone (a key saved,
  // no request ever sent) cannot undercount anything, so deleting it must not cost a 31-day lockout.
  test("key lines alone leave no marker, written or read: deleting music/ then reads ok, a request may leave, and still no marker", async () => {
    await ledger().recordKeyChange(LAST4);
    await ledger().recordKeyChange(null);
    expect(await exists(marker())).toBe(false);
    await ledger().summary();
    expect(await exists(marker())).toBe(false);
    await rm(join(dir, "music"), { recursive: true });
    expect(await ledger().summary()).toMatchObject({ sentInWindow: 0, refusal: null });
    expect(await exists(marker())).toBe(false);
  });

  test("a send written through the ledger leaves it, and the log deleted after it reads missing", async () => {
    await ledger().recordKeyChange(LAST4);
    expect((await ledger().reserve({ id: "refresh-0001", key: LAST4 })).ok).toBe(true);
    expect(await exists(marker())).toBe(true);
    await rm(join(dir, "music"), { recursive: true });
    await missing(ledger().summary());
  });

  test("a result read from an older log leaves it too: an answer means a request left", async () => {
    await seed([{ v: 1, kind: "key", at: NOW - 2 * HOUR, key: LAST4 }, zero(NOW - HOUR)]);
    await ledger().summary();
    expect(await exists(marker())).toBe(true);
  });

  test("a recovered log leaves it", async () => {
    await seed([{ v: 1, kind: "key", at: NOW - HOUR, key: LAST4 }]);
    await writeFile(path, `${await readFile(path, "utf8")}not json at all\n`);
    expect((await ledger().recover({ rejectedKey: null })).ok).toBe(true);
    expect(await exists(marker())).toBe(true);
  });
});

describe("a log that is gone while the marker says it existed: missing", () => {
  async function started(lines: readonly QuotaLine[] = [send(NOW - HOUR)]): Promise<void> {
    await seed(lines);
    await ledger().summary();
  }

  test("the log deleted: the summary fails as missing, so the count is never read as 0", async () => {
    await started();
    await rm(path);
    await missing(ledger().summary());
  });

  test("the whole music folder deleted: missing, and reading does not make the folder again", async () => {
    await started();
    await rm(join(dir, "music"), { recursive: true });
    await missing(ledger().summary());
    expect(await exists(join(dir, "music"))).toBe(false);
  });

  test("the log emptied: missing too", async () => {
    await started();
    await writeFile(path, "");
    await missing(ledger().summary());
  });

  test("the server's 0 is not lost with the file: a deleted log whose last answer said 0 left is closed, never free", async () => {
    await started([send(NOW - HOUR), zero(NOW - HOUR)]);
    await rm(join(dir, "music"), { recursive: true });
    await missing(ledger().summary());
  });

  test.each([
    ["reserve", () => ledger().reserve({ id: "refresh-0001", key: LAST4 })],
    ["recordResult", () => ledger().recordResult({ id: "refresh-0001", key: LAST4, outcome: "ok", status: 200, remaining: 12 })],
    ["recordKeyChange", () => ledger().recordKeyChange(LAST4)],
  ] as const)("%s does not start a new log behind the owner's back: it fails as missing and writes nothing", async (_name, write) => {
    await started();
    await rm(join(dir, "music"), { recursive: true });
    await missing(write());
    expect(await exists(join(dir, "music"))).toBe(false);
  });

  test("recover: a new log of 30 sends made now, the folder made again, nothing to put aside", async () => {
    await started();
    await rm(join(dir, "music"), { recursive: true });
    const answer = await ledger().recover({ rejectedKey: null });
    if (!answer.ok) throw new Error(`expected a recovery, got ${answer.refusal}`);
    expect(answer.quarantined).toBeNull();
    expect(await readdir(join(dir, "music"))).toEqual(["quota.jsonl"]);
    expect(await ledger().summary()).toMatchObject({ sentInWindow: QUOTA_LIMIT, refusal: "quota", nextFreeAt: NOW + QUOTA_WINDOW_MS });
    expect(JSON.parse((await readFile(path, "utf8")).trim())).toMatchObject({ kind: "recovered", at: NOW, sends: QUOTA_LIMIT, quarantined: null });
  });

  test("recover: an emptied log is put aside first", async () => {
    await started();
    await writeFile(path, "");
    const answer = await ledger().recover({ rejectedKey: null });
    expect(answer.ok ? answer.quarantined : null).toBe("quota.jsonl.corrupt-20261003T101500Z");
  });

  test("a fresh install is not missing: recover refuses it as not corrupt and writes nothing", async () => {
    expect(await ledger().recover({ rejectedKey: null })).toEqual({ ok: false, refusal: "not-corrupt" });
    expect(await exists(join(dir, "music"))).toBe(false);
  });
});
