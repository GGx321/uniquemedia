import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fragmentForms, expectNoKeyFragment } from "../../testing/keyLeaks";
import { QUOTA_LIMIT, QUOTA_WINDOW_MS, QuotaLedger, QuotaLogError, summarize, type QuotaLine } from "./quotaLedger";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Invariant 30: a `send` line is on disk before the request leaves; a 31-day window; the limit of 30; the server's
// `remaining = 0` floor; a torn last line and a crash between `send` and `result` are survived.

const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);
const DAY = 24 * 3600 * 1000;
const KEY = "Zq7-vKt9-Wm2x-Lp4s-0000";
const LAST4 = "0000";

let dir = "";
let path = "";
let now = NOW;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "studio-quota-"));
  path = join(dir, "music", "quota.jsonl");
  now = NOW;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ledger = () => new QuotaLedger(path, { clock: () => now });

const send = (at: number, id = `send-${at}`, key: string | null = LAST4): QuotaLine => ({ v: 1, kind: "send", id, at, key: key ?? "0000" });
const result = (at: number, extra: Partial<Extract<QuotaLine, { kind: "result" }>> = {}): QuotaLine => ({ v: 1, kind: "result", id: `send-${at}`, at, key: LAST4, outcome: "ok", ...extra });
const keySet = (at: number, key: string | null): QuotaLine => ({ v: 1, kind: "key", at, key });

/** `n` sends, one per hour ending an hour before `end`, oldest first. */
function sends(n: number, end = NOW): QuotaLine[] {
  return Array.from({ length: n }, (_, i) => send(end - (n - i) * 3600 * 1000));
}

async function seed(lines: readonly QuotaLine[], tail = ""): Promise<void> {
  await mkdir(join(dir, "music"), { recursive: true });
  await writeFile(path, lines.map((l) => `${JSON.stringify(l)}\n`).join("") + tail);
}

const fileLines = async (): Promise<string[]> => (await readFile(path, "utf8")).split("\n").filter((l) => l !== "");
const reserve = (id = "refresh-0001") => ledger().reserve({ id, key: LAST4 });

describe("the constants", () => {
  test("are 30 requests in 31 days", () => {
    expect(QUOTA_LIMIT).toBe(30);
    expect(QUOTA_WINDOW_MS).toBe(31 * DAY);
  });
});

describe("the boundary at the limit", () => {
  test.each([0, 1, 29])("with %i sends in the window a request may leave", async (count) => {
    await seed(sends(count));
    const answer = await reserve();
    expect(answer.ok).toBe(true);
    expect((await fileLines()).length).toBe(count + 1);
  });

  test.each([30, 31, 45])("with %i sends in the window a request is refused and nothing is written", async (count) => {
    await seed(sends(count));
    const answer = await reserve();
    expect(answer).toMatchObject({ ok: false, refusal: "quota" });
    expect((await fileLines()).length).toBe(count);
  });

  test("the 30th send goes out and the 31st is refused", async () => {
    await seed(sends(29));
    expect((await reserve("refresh-0030")).ok).toBe(true);
    expect((await reserve("refresh-0031")).ok).toBe(false);
  });

  test("two requests asked at once with 29 sent: exactly one leaves", async () => {
    await seed(sends(29));
    const answers = await Promise.all([reserve("refresh-000a"), reserve("refresh-000b")]);
    expect(answers.map((a) => a.ok).sort()).toEqual([false, true]);
    expect((await fileLines()).length).toBe(30);
  });
});

describe("the 31-day window", () => {
  test("a send exactly 31 days old has left the window: 30 sends with the oldest that old leave 29", async () => {
    const lines = [send(NOW - QUOTA_WINDOW_MS), ...sends(29)];
    await seed(lines);
    expect((await reserve()).ok).toBe(true);
  });

  test("a send one ms short of 31 days old is still in it: 30 sends are refused", async () => {
    await seed([send(NOW - QUOTA_WINDOW_MS + 1), ...sends(29)]);
    expect((await reserve()).ok).toBe(false);
  });

  test("a send one ms past 31 days is out", async () => {
    await seed([send(NOW - QUOTA_WINDOW_MS - 1), ...sends(29)]);
    expect((await reserve()).ok).toBe(true);
  });

  test("nextFreeAt is when the oldest send leaves the window, and a request may leave at that very ms and not a ms before", async () => {
    const oldest = NOW - 30 * DAY;
    await seed([send(oldest), ...sends(29)]);
    const refused = await reserve();
    expect(refused).toMatchObject({ ok: false, refusal: "quota" });
    expect(refused.summary.nextFreeAt).toBe(oldest + QUOTA_WINDOW_MS);
    now = oldest + QUOTA_WINDOW_MS - 1;
    expect((await reserve()).ok).toBe(false);
    now = oldest + QUOTA_WINDOW_MS;
    expect((await reserve()).ok).toBe(true);
  });

  test("with nothing in the window there is no nextFreeAt; with sends it is the oldest one's leaving, even below the limit", async () => {
    expect((await ledger().summary()).nextFreeAt).toBeNull();
    await seed([send(NOW - 40 * DAY)]);
    expect((await ledger().summary()).nextFreeAt).toBeNull();
    await seed([send(NOW - 2 * DAY), send(NOW - DAY)]);
    expect((await ledger().summary()).nextFreeAt).toBe(NOW - 2 * DAY + QUOTA_WINDOW_MS);
  });

  test("a send dated in the future (the clock moved back) still counts", async () => {
    await seed([send(NOW + DAY), ...sends(29)]);
    expect((await reserve()).ok).toBe(false);
  });
});

describe("a crash between send and result", () => {
  test("a send with no result counts: the request may have left", async () => {
    await seed(sends(30));
    expect((await ledger().summary()).sentInWindow).toBe(30);
  });

  test("results are not sends: 15 sends with their results count 15", async () => {
    const lines = sends(15).flatMap((s) => (s.kind === "send" ? [s, result(s.at + 1000, { id: s.id })] : [s]));
    await seed(lines);
    expect((await ledger().summary()).sentInWindow).toBe(15);
  });
});

describe("a torn last line", () => {
  test("a partial last line is not a send: with 29 sends and a torn tail a request still leaves", async () => {
    await seed(sends(29), '{"v":1,"kind":"send","id":"refresh-torn","at":17');
    const answer = await reserve();
    expect(answer.ok).toBe(true);
  });

  test("the torn tail is kept aside in a .torn file and the new line is not glued onto it", async () => {
    await seed(sends(3), '{"v":1,"kind":"send","id":"refresh-torn","at":17');
    await reserve();
    const lines = await fileLines();
    expect(lines.length).toBe(4);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(await readFile(`${path}.torn`, "utf8")).toContain("refresh-torn");
    expect((await ledger().summary()).sentInWindow).toBe(4);
  });

  test("a torn tail alone does not stop the summary", async () => {
    await seed(sends(2), "{");
    expect((await ledger().summary()).sentInWindow).toBe(2);
  });
});

describe("a log that cannot be trusted refuses the request", () => {
  test("a complete line that is not JSON: the summary and the reserve fail, and nothing is written", async () => {
    await mkdir(join(dir, "music"), { recursive: true });
    await writeFile(path, `${JSON.stringify(send(NOW - 1000))}\nnot json\n${JSON.stringify(send(NOW - 500))}\n`);
    const before = await readFile(path, "utf8");
    await expect(ledger().summary()).rejects.toBeInstanceOf(QuotaLogError);
    await expect(reserve()).rejects.toMatchObject({ code: "corrupt" });
    expect(await readFile(path, "utf8")).toBe(before);
  });

  test.each([
    ["an unknown kind", { v: 1, kind: "spend", at: NOW }],
    ["a newer version", { v: 2, kind: "send", id: "refresh-0001", at: NOW, key: LAST4 }],
    ["an extra field", { v: 1, kind: "send", id: "refresh-0001", at: NOW, key: LAST4, note: "x" }],
    ["a negative time", { v: 1, kind: "send", id: "refresh-0001", at: -5, key: LAST4 }],
    ["a key tag that is not four chars", { v: 1, kind: "send", id: "refresh-0001", at: NOW, key: "Zq7-vKt9-Wm2x" }],
  ])("a complete line with %s is corruption", async (_label, line) => {
    await mkdir(join(dir, "music"), { recursive: true });
    await writeFile(path, `${JSON.stringify(line)}\n`);
    await expect(ledger().summary()).rejects.toMatchObject({ code: "corrupt" });
  });

  test("a log that cannot be read at all (a folder in its place) fails as unreadable", async () => {
    await mkdir(path, { recursive: true });
    await expect(ledger().summary()).rejects.toMatchObject({ code: "unreadable" });
    await expect(reserve()).rejects.toBeInstanceOf(QuotaLogError);
  });

  test("a send that cannot be written is an error, so the request never leaves", async () => {
    await mkdir(join(dir, "music"), { recursive: true });
    await mkdir(`${path}.torn`, { recursive: true });
    await writeFile(path, '{"v":1,"kind":"send"');
    await expect(reserve()).rejects.toBeInstanceOf(QuotaLogError);
  });
});

describe("the server's remaining = 0 floor", () => {
  test("a last answer with remaining 0 refuses a request although the local count is low", async () => {
    await seed([send(NOW - DAY), result(NOW - DAY + 1000, { remaining: 0 })]);
    const answer = await reserve();
    expect(answer).toMatchObject({ ok: false, refusal: "floor" });
    expect(answer.summary.nextFreeAt).toBe(NOW - DAY + 1000 + QUOTA_WINDOW_MS);
    expect((await fileLines()).length).toBe(2);
  });

  test.each([
    ["a 429", { outcome: "http-error", status: 429 }],
    ["a 500", { outcome: "http-error", status: 500 }],
    ["a 403", { outcome: "http-error", status: 403 }],
    ["a 401", { outcome: "rejected", status: 401 }],
    ["an answer that was too large", { outcome: "too-large", status: 200 }],
    ["an answer that was not a list", { outcome: "invalid", status: 200 }],
  ] as const)("an ERROR answer (%s) that carries remaining 0 is the floor too: the real exhaustion path is a 429", async (_label, extra) => {
    await seed([send(NOW - 2000), result(NOW - 1000, { ...extra, remaining: 0 })]);
    const answer = await reserve();
    expect(answer).toMatchObject({ ok: false, refusal: "floor" });
    expect(answer.summary.serverRemaining).toBe(0);
    expect(answer.summary.nextFreeAt).toBe(NOW - 1000 + QUOTA_WINDOW_MS);
    expect((await fileLines()).length).toBe(2);
  });

  test("an error answer with a positive remaining lifts an earlier floor, like any answer that carries a figure", async () => {
    await seed([result(NOW - 3 * DAY, { remaining: 0 }), result(NOW - DAY, { outcome: "http-error", status: 500, remaining: 6 })]);
    expect((await reserve()).ok).toBe(true);
  });

  test("the floor lifts 31 days after that answer, to the ms", async () => {
    const at = NOW - 10 * DAY;
    await seed([result(at, { remaining: 0 })]);
    now = at + QUOTA_WINDOW_MS - 1;
    expect((await reserve()).ok).toBe(false);
    now = at + QUOTA_WINDOW_MS;
    expect((await reserve()).ok).toBe(true);
  });

  test("a later answer with remaining above 0 lifts it", async () => {
    await seed([result(NOW - 3 * DAY, { remaining: 0 }), result(NOW - 2 * DAY, { remaining: 4 })]);
    expect((await reserve()).ok).toBe(true);
  });

  test("a later answer without a remaining figure leaves the floor where it was", async () => {
    await seed([result(NOW - 3 * DAY, { remaining: 0 }), result(NOW - 2 * DAY, { outcome: "network-error" })]);
    expect((await reserve()).ok).toBe(false);
  });

  test("when both the count and the floor refuse, nextFreeAt is the later of the two", async () => {
    const oldest = NOW - 30 * DAY;
    await seed([send(oldest), ...sends(29), result(NOW - 1000, { remaining: 0 })]);
    const answer = await reserve();
    expect(answer.ok).toBe(false);
    expect(answer.summary.nextFreeAt).toBe(NOW - 1000 + QUOTA_WINDOW_MS);
  });

  test("serverRemaining is the last known figure inside the window, and null once it is older", async () => {
    await seed([result(NOW - 5 * DAY, { remaining: 12 })]);
    expect((await ledger().summary()).serverRemaining).toBe(12);
    now = NOW - 5 * DAY + QUOTA_WINDOW_MS;
    expect((await ledger().summary()).serverRemaining).toBeNull();
  });
});

describe("the rejected key, kept across restarts without the key", () => {
  test("a 401 result for a key makes that key rejected in a fresh ledger over the same file", async () => {
    await seed([send(NOW - 1000), result(NOW - 900, { outcome: "rejected", status: 401 })]);
    expect((await ledger().summary()).rejectedKey).toBe(LAST4);
  });

  test("storing a key afterwards clears it, even the same key again", async () => {
    await seed([result(NOW - 900, { outcome: "rejected", status: 401 }), keySet(NOW - 800, LAST4)]);
    expect((await ledger().summary()).rejectedKey).toBeNull();
  });

  test("clearing the key clears it too", async () => {
    await seed([result(NOW - 900, { outcome: "rejected", status: 401 }), keySet(NOW - 800, null)]);
    expect((await ledger().summary()).rejectedKey).toBeNull();
  });

  test("a later good answer for the same key clears it", async () => {
    await seed([result(NOW - 900, { outcome: "rejected", status: 401 }), result(NOW - 800)]);
    expect((await ledger().summary()).rejectedKey).toBeNull();
  });

  test("a rejection of an older key is not a rejection of a newer key with other last four chars", async () => {
    await seed([result(NOW - 900, { outcome: "rejected", status: 401, key: "1111" })]);
    const summary = await ledger().summary();
    expect(summary.rejectedKey).toBe("1111");
    expect(summary.rejectedKey === LAST4).toBe(false);
  });

  test("the rejection is remembered however old it is: a revoked key stays revoked until it is replaced", async () => {
    await seed([result(NOW - 200 * DAY, { outcome: "rejected", status: 401 })]);
    expect((await ledger().summary()).rejectedKey).toBe(LAST4);
  });

  test("recordKeyChange writes a line that clears it", async () => {
    await seed([result(NOW - 900, { outcome: "rejected", status: 401 })]);
    await ledger().recordKeyChange(LAST4);
    expect((await ledger().summary()).rejectedKey).toBeNull();
  });
});

describe("hadOkResult (the first real refresh)", () => {
  test("false until an ok result is on record, then true whatever its age", async () => {
    expect((await ledger().summary()).hadOkResult).toBe(false);
    await seed([send(NOW - 1000), result(NOW - 900, { outcome: "http-error", status: 500 })]);
    expect((await ledger().summary()).hadOkResult).toBe(false);
    await seed([result(NOW - 300 * DAY)]);
    expect((await ledger().summary()).hadOkResult).toBe(true);
  });
});

describe("what the file holds", () => {
  test("never the key, nor a fragment of it in any form: only its last four chars", async () => {
    const l = ledger();
    await l.reserve({ id: "refresh-0001", key: LAST4 });
    await l.recordResult({ id: "refresh-0001", key: LAST4, outcome: "rejected", status: 401, remaining: 0, limit: 30 });
    await l.recordKeyChange(LAST4);
    const text = await readFile(path, "utf8");
    expectNoKeyFragment(text, KEY);
    const bytes = await readFile(path);
    for (const form of fragmentForms(KEY)) expect(bytes.includes(form.bytes)).toBe(false);
    expect(text).toContain(LAST4);
  });

  test("a whole key passed as the key tag by mistake throws before anything is written", async () => {
    await expect(ledger().reserve({ id: "refresh-0001", key: KEY })).rejects.toBeInstanceOf(TypeError);
    await expect(ledger().recordKeyChange(KEY)).rejects.toBeInstanceOf(TypeError);
    await expect(ledger().recordResult({ id: "refresh-0001", key: KEY, outcome: "ok" })).rejects.toBeInstanceOf(TypeError);
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each([
    ["a fractional remaining", { remaining: 1.5 }],
    ["a negative status", { status: -1 }],
    ["a fractional limit", { limit: 0.5 }],
    ["a server time that is not a whole number", { serverAt: 1.5 }],
  ])("a result line the ledger itself could not read back is never written (%s): it would close the ledger for good", async (_label, bad) => {
    const l = ledger();
    await l.reserve({ id: "refresh-0001", key: LAST4 });
    const before = await readFile(path, "utf8");
    await expect(l.recordResult({ id: "refresh-0001", key: LAST4, outcome: "ok", ...bad })).rejects.toBeDefined();
    expect(await readFile(path, "utf8")).toBe(before);
    expect((await l.summary()).sentInWindow).toBe(1);
  });

  test("the server's own time (its Date header) is kept on the result line", async () => {
    const l = ledger();
    await l.reserve({ id: "refresh-0001", key: LAST4 });
    await l.recordResult({ id: "refresh-0001", key: LAST4, outcome: "ok", serverAt: NOW + 5000 });
    expect(JSON.parse((await fileLines()).at(-1) ?? "")).toMatchObject({ kind: "result", serverAt: NOW + 5000 });
  });

  test("creating music/ the first time also syncs the folder that holds it, once", async () => {
    const synced: string[] = [];
    const l = new QuotaLedger(path, { clock: () => now, syncDir: async (dir) => void synced.push(dir) });
    await l.reserve({ id: "refresh-0001", key: LAST4 });
    await l.recordKeyChange(LAST4);
    expect(synced).toEqual([dir]);
  });

  test("a folder that cannot be synced does not stop the send: the line is written and counted", async () => {
    const l = new QuotaLedger(path, { clock: () => now, syncDir: () => Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" })) });
    expect((await l.reserve({ id: "refresh-0001", key: LAST4 })).ok).toBe(true);
    expect((await l.summary()).sentInWindow).toBe(1);
  });

  test("the send line is the first thing the file holds after reserve resolves", async () => {
    await reserve("refresh-0001");
    const [line] = await fileLines();
    expect(JSON.parse(line ?? "")).toEqual({ v: 1, kind: "send", id: "refresh-0001", at: NOW, key: LAST4 });
  });

  test("the folder is created when it is not there yet", async () => {
    expect((await reserve()).ok).toBe(true);
    expect((await fileLines()).length).toBe(1);
  });
});

describe("summarize", () => {
  test("clamps nothing itself: it reports 31 sends as 31", () => {
    expect(summarize(sends(31), NOW).sentInWindow).toBe(31);
  });
});
