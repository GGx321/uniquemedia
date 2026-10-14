import { afterEach, describe, expect, test } from "bun:test";
import type { VideoSubmitResult } from "../openrouter/types";
import { awaitLateClip } from "./attempt";
import { clipAttemptId } from "./journal";
import { completed, expectNoGrok, failed, GROK_BILLED, GROK_RESERVE, journalOf, KLING_BILLED, KLING_RESERVE, late } from "./testing/attemptAsserts";
import {
  CLIP_ID,
  createRig,
  gen404,
  genFound,
  genFromAfter,
  genUnreadable,
  GROK,
  KLING,
  MINUTE,
  PROVIDER_FAILED,
  REFUSED_BY_RISK_CONTROL,
  SECOND,
  T0,
  type JobScript,
  type Rig,
  type RigOptions,
} from "./testing/attemptRig";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5b.1, S5.V3b (plan s5b1 §5.7, I5.44-I5.48): THE SETTLE TABLE, «mode × outcome → settle source → next», ONE TEST PER CELL. Each cell asserts the ledger lines, the journal lines and the next step, and that no
// Grok hold, reserve or POST exists where the cell says none. Time is the rig's: the 2-minute proof runs in no real time. Row numbers below are the table's rows, top to bottom.

let rig: Rig;
afterEach(async () => rig?.dispose());
async function make(options: RigOptions = {}): Promise<Rig> {
  rig = await createRig(options);
  return rig;
}

const MODES = [["auto"], ["offer"]] as const;
const moderation4xx: VideoSubmitResult = { kind: "refused", httpStatus: 400, errorKind: "HTTP_ERROR", moderation: true, detail: "POST /videos: HTTP 400: moderation" };
const refusedHttp = (httpStatus: number, errorKind: "AUTH_INVALID" | "INSUFFICIENT_CREDITS" | "RATE_LIMITED" | "HTTP_ERROR"): VideoSubmitResult => ({
  kind: "refused",
  httpStatus,
  errorKind,
  moderation: false,
  detail: `POST /videos: HTTP ${httpStatus}`,
});
const UNCERTAIN_CAUSES = [["timeout"], ["aborted"], ["network"], ["server-error"], ["unreadable-accept"]] as const;
const uncertain = (cause: (typeof UNCERTAIN_CAUSES)[number][0]): VideoSubmitResult => ({ kind: "uncertain", cause, httpStatus: cause === "server-error" ? 502 : null, detail: `POST /videos: ${cause}` });

describe.each(MODES)("row 1 · completed with usage.cost · mode %s", (mode) => {
  test("settles usage.cost, journals it, and hands the file to the download", async () => {
    await make({ mode });
    const result = completed(await rig.run());
    expect(result).toMatchObject({ providerJobId: "job-kling", model: "kling", providerCostMicros: KLING_BILLED, costSource: "usage", fallbackUsed: false, aboveWorst: null });
    expect(rig.clipLedger()).toEqual([
      ["reserve", KLING, KLING_RESERVE],
      ["settle", KLING, KLING_BILLED],
    ]);
    expect(journalOf(rig)).toEqual(["requested", `submitted:${KLING}`, `ended:${KLING}:completed:usage`]);
    expect(rig.generationReads()).toHaveLength(0);
    expectNoGrok(rig, GROK);
  });
});

describe.each(MODES)("row 2 · completed without usage · mode %s", (mode) => {
  test("settles /generation's total_cost, read from 15 s after the status on", async () => {
    await make({ mode, kling: { terminal: { status: "completed", usageCostMicros: null }, generation: genFromAfter(15 * SECOND, KLING_BILLED) } });
    const result = completed(await rig.run());
    expect(result).toMatchObject({ providerCostMicros: KLING_BILLED, costSource: "generation" });
    expect(rig.clipLedger()).toEqual([
      ["reserve", KLING, KLING_RESERVE],
      ["settle", KLING, KLING_BILLED],
    ]);
    expect(Math.min(...rig.generationReads().map((r) => r.sinceTerminal))).toBeGreaterThanOrEqual(15 * SECOND);
    expect(journalOf(rig).at(-1)).toBe(`ended:${KLING}:completed:generation`);
  });

  test("settles the worst, estimated, when /generation stays unreadable (never a guessed cost)", async () => {
    await make({ mode, kling: { terminal: { status: "completed", usageCostMicros: null }, generation: genUnreadable } });
    const result = completed(await rig.run());
    expect(result).toMatchObject({ providerCostMicros: null, costSource: "worst" });
    expect(rig.clipLedger()).toEqual([
      ["reserve", KLING, KLING_RESERVE],
      ["settle-estimated", KLING, KLING_RESERVE],
    ]);
    expect(rig.generationReads()).toHaveLength(3);
  });

  test("settles the worst, estimated, when /generation answers 404 (a completed job was billed: a 404 is not zero)", async () => {
    await make({ mode, kling: { terminal: { status: "completed", usageCostMicros: null }, generation: gen404 } });
    const result = completed(await rig.run());
    expect(result.costSource).toBe("worst");
    expect(rig.clipLedger()).toEqual([
      ["reserve", KLING, KLING_RESERVE],
      ["settle-estimated", KLING, KLING_RESERVE],
    ]);
  });

  test("reads again after a 404 and settles the record that appears seconds later", async () => {
    await make({ mode, kling: { terminal: { status: "completed", usageCostMicros: null }, generation: genFromAfter(19 * SECOND, KLING_BILLED) } });
    const result = completed(await rig.run());
    expect(result).toMatchObject({ providerCostMicros: KLING_BILLED, costSource: "generation" });
    expect(rig.generationReads().length).toBeGreaterThan(1);
  });
});

describe.each(MODES)("row 3 · 4xx moderation at the submit · mode %s", (mode) => {
  test("settles 0 (no job exists), frees the hold and ends the Kling attempt as a content refusal", async () => {
    await make({ mode, kling: { submit: moderation4xx }, grok: { terminal: { status: "completed", usageCostMicros: GROK_BILLED } } });
    await rig.run();
    expect(rig.settles(KLING)).toMatchObject([{ costMicros: 0, estimated: false }]);
    expect(journalOf(rig)).toContain(`ended:${KLING}:refused:none`);
    expect(rig.holds.untilOf(KLING)).toBeUndefined();
    expect(rig.generationReads("kling")).toHaveLength(0);
    expect(rig.posts("kling")).toHaveLength(1);
  });
});

describe("row 3 → next · a content refusal settled 0", () => {
  test("(auto) Grok runs by itself, reserved only after Kling settled 0, and completes", async () => {
    await make({ mode: "auto", kling: { submit: moderation4xx }, grok: { terminal: { status: "completed", usageCostMicros: GROK_BILLED } } });
    const result = completed(await rig.run());
    expect(result).toMatchObject({ model: "grok", attemptId: GROK, fallbackUsed: true, providerCostMicros: GROK_BILLED });
    expect(result.attempts.map((a) => [a.attemptId, a.outcome, a.costSource])).toEqual([
      [KLING, "refused", "none"],
      [GROK, "completed", "usage"],
    ]);
    expect(rig.clipLedger()).toEqual([
      ["reserve", KLING, KLING_RESERVE],
      ["settle", KLING, 0],
      ["reserve", GROK, GROK_RESERVE],
      ["settle", GROK, GROK_BILLED],
    ]);
    expect(journalOf(rig)).toEqual(["requested", `ended:${KLING}:refused:none`, `submitted:${GROK}`, `ended:${GROK}:completed:usage`]);
    expect(rig.posts("kling")).toHaveLength(1);
    expect(rig.posts("grok")).toHaveLength(1);
  });

  test("(offer) no Grok: the attempt ends free and the tile offers «Снять на Grok»", async () => {
    await make({ mode: "offer", kling: { submit: moderation4xx } });
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-free", cost: "free", grokOffer: true, model: "kling" });
    expectNoGrok(rig, GROK);
  });

  test("(auto × fallback none) ends refused-free with no offer and no Grok", async () => {
    await make({ mode: "auto", kling: { submit: moderation4xx } });
    expect(failed(await rig.run({ request: { model: "kling", quality: "std", seconds: 5, fallback: "none" } }))).toMatchObject({ reason: "refused-free", grokOffer: false });
    expectNoGrok(rig, GROK);
    expect(rig.clipLedger()).toEqual([
      ["reserve", KLING, KLING_RESERVE],
      ["settle", KLING, 0],
    ]);
  });

  test("(offer × fallback none) ends refused-free with no offer", async () => {
    await make({ mode: "offer", kling: { submit: moderation4xx } });
    expect(failed(await rig.run({ request: { model: "kling", quality: "std", seconds: 5, fallback: "none" } }))).toMatchObject({ reason: "refused-free", grokOffer: false });
    expectNoGrok(rig, GROK);
  });

  test("(auto × «Смелая» kling-only) ends refused-free: never Grok", async () => {
    await make({ mode: "auto", boldClips: "kling-only", kling: { submit: moderation4xx } });
    expect(failed(await rig.run({ bold: true }))).toMatchObject({ reason: "refused-free", grokOffer: false });
    expectNoGrok(rig, GROK);
  });

  test("(offer × «Смелая» kling-only) ends refused-free with no offer: never Grok", async () => {
    await make({ mode: "offer", boldClips: "kling-only", kling: { submit: moderation4xx } });
    expect(failed(await rig.run({ bold: true }))).toMatchObject({ reason: "refused-free", grokOffer: false });
    expectNoGrok(rig, GROK);
  });

  test("(auto × «Смелая» with-fallback) is a frame like any other: Grok runs", async () => {
    await make({ mode: "auto", boldClips: "with-fallback", kling: { submit: moderation4xx }, grok: { terminal: { status: "completed", usageCostMicros: GROK_BILLED } } });
    expect(completed(await rig.run({ bold: true })).model).toBe("grok");
  });

  test("(offer × model grok) the Grok clip ends refused-free: no offer, no second Grok", async () => {
    await make({ mode: "offer", grok: { submit: moderation4xx } });
    const result = failed(await rig.run({ request: { model: "grok", quality: "std", seconds: 5, fallback: "none" } }));
    expect(result).toMatchObject({ reason: "refused-free", model: "grok", grokOffer: false });
    expect(rig.posts("kling")).toHaveLength(0);
    expect(rig.posts("grok")).toHaveLength(1);
    expect(rig.reserves().map((r) => r.attemptId)).toEqual([KLING]); // the clip's only attempt is #1, and it is the Grok one
    expect(rig.reserves()[0]?.worstMicros).toBe(GROK_RESERVE);
  });

  test("(auto) Grok refuses too: refused-both, both settled 0, nothing left open", async () => {
    await make({ mode: "auto", kling: { submit: moderation4xx }, grok: { submit: moderation4xx } });
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-both", cost: "free", grokOffer: false });
    expect(rig.clipLedger()).toEqual([
      ["reserve", KLING, KLING_RESERVE],
      ["settle", KLING, 0],
      ["reserve", GROK, GROK_RESERVE],
      ["settle", GROK, 0],
    ]);
    expect(rig.ledger.openReserves()).toHaveLength(0);
  });
});

describe.each(MODES)("row 4 · 401 / 402 / 429 / another 4xx at the submit · mode %s", (mode) => {
  test.each([
    ["401", refusedHttp(401, "AUTH_INVALID"), "key-invalid"],
    ["402", refusedHttp(402, "INSUFFICIENT_CREDITS"), "no-credits"],
    ["429", refusedHttp(429, "RATE_LIMITED"), "rate-limited"],
    ["400 that is not moderation", refusedHttp(400, "HTTP_ERROR"), "bad-request"],
  ] as const)("%s settles 0 and ends %s: no Grok, no offer", async (_name, submit, reason) => {
    await make({ mode, kling: { submit } });
    expect(failed(await rig.run())).toMatchObject({ reason, cost: "free", grokOffer: false });
    expect(rig.clipLedger()).toEqual([
      ["reserve", KLING, KLING_RESERVE],
      ["settle", KLING, 0],
    ]);
    expect(journalOf(rig)).toEqual(["requested", `ended:${KLING}:failed:none`]);
    expect(rig.holds.untilOf(KLING)).toBeUndefined();
    expect(rig.posts()).toHaveLength(1);
    expectNoGrok(rig, GROK);
  });

  test.each([
    ["401", refusedHttp(401, "AUTH_INVALID"), "key-invalid"],
    ["402", refusedHttp(402, "INSUFFICIENT_CREDITS"), "no-credits"],
    ["429", refusedHttp(429, "RATE_LIMITED"), "rate-limited"],
    ["400 that is not moderation", refusedHttp(400, "HTTP_ERROR"), "bad-request"],
  ] as const)("%s names its reason on the journal's `ended` line, so a restart records the same reason (VR item 2)", async (_name, submit, reason) => {
    await make({ mode, kling: { submit } });
    await rig.run();
    expect(rig.journalLines.filter((l) => l.type === "ended")).toMatchObject([{ attemptId: KLING, status: "failed", costSource: "none", failReason: reason }]);
  });
});

describe.each(MODES)("row 5 · 5xx, timeout or network error at the submit · mode %s", (mode) => {
  test.each(UNCERTAIN_CAUSES)("%s: abandons the reserve (open at worst), holds 20 min, never resends", async (cause) => {
    await make({ mode, kling: { submit: uncertain(cause) } });
    expect(failed(await rig.run())).toMatchObject({ reason: "submit-uncertain", cost: "worst", grokOffer: false });
    expect(rig.clipLedger()).toEqual([["reserve", KLING, KLING_RESERVE]]);
    expect(rig.trace).toContain(`ledger:abandon:${KLING}`);
    expect(rig.ledger.openReserves().map((r) => r.attemptId)).toEqual([KLING]);
    expect(rig.holds.untilOf(KLING)).toBe(T0 + 20 * MINUTE);
    expect(journalOf(rig)).toEqual(["requested"]);
    expect(rig.posts()).toHaveLength(1);
    expect(rig.calls.filter((c) => c.type === "poll" || c.type === "generation")).toHaveLength(0);
    expectNoGrok(rig, GROK);
  });

  test("a client that throws is the same: possibly submitted, never resent", async () => {
    await make({ mode, kling: { submit: "throw" } });
    expect(failed(await rig.run())).toMatchObject({ reason: "submit-uncertain", cost: "worst" });
    expect(rig.clipLedger()).toEqual([["reserve", KLING, KLING_RESERVE]]);
    expect(rig.posts()).toHaveLength(1);
  });
});

describe.each(MODES)("row 6 · a throw between the 2xx and the `submitted` fsync · mode %s", (mode) => {
  test("behaves as an uncertain submit: the reserve stays open, held 20 min from the reserve's `at`, nothing is resent or polled", async () => {
    await make({ mode });
    rig.failJournalOn.add("submitted");
    const result = failed(await rig.run());
    expect(result).toMatchObject({ reason: "submit-uncertain", cost: "worst", grokOffer: false });
    expect(result.detail).toContain("disk full");
    expect(rig.clipLedger()).toEqual([["reserve", KLING, KLING_RESERVE]]);
    expect(rig.trace).toContain(`ledger:abandon:${KLING}`);
    expect(rig.holds.untilOf(KLING)).toBe(T0 + 20 * MINUTE);
    expect(rig.posts()).toHaveLength(1);
    expect(rig.calls.filter((c) => c.type === "poll")).toHaveLength(0);
    expectNoGrok(rig, GROK);
  });
});

describe("row 7 · a poll-time content refusal, 404 on both reads", () => {
  const refused = { terminal: REFUSED_BY_RISK_CONTROL };
  /** A photo run that settles between the two reads of the net-usage check, and the usage it adds to /credits. */
  const photoRunInTheWindow = (r: Rig): void => r.at(T0 + 60 * SECOND + 60 * SECOND, () => r.photoRun("run-0001", 90_000));
  const usageWith = (extraAfter: number) => (t: number) => 5_000_000 + (t >= extraAfter ? 90_000 : 0);

  test("(auto · check clean) settles 0 by the proof, then Grok runs", async () => {
    await make({ mode: "auto", kling: refused, grok: { terminal: { status: "completed", usageCostMicros: GROK_BILLED } } });
    const result = completed(await rig.run());
    expect(result).toMatchObject({ model: "grok", fallbackUsed: true });
    expect(rig.clipLedger()).toEqual([
      ["reserve", KLING, KLING_RESERVE],
      ["settle", KLING, 0],
      ["reserve", GROK, GROK_RESERVE],
      ["settle", GROK, GROK_BILLED],
    ]);
    expect(result.attempts[0]).toMatchObject({ outcome: "refused", costSource: "proof" });
    expect(journalOf(rig)).toContain(`ended:${KLING}:refused:proof`);
  });

  test("(auto · the check could not count: a photo run settled between the reads) is NOT proven free: worst, estimated, no automatic Grok", async () => {
    await make({ mode: "auto", kling: refused, usage: (t) => usageWith(T0 + 100 * SECOND)(t), grok: { terminal: { status: "completed", usageCostMicros: GROK_BILLED } } });
    photoRunInTheWindow(rig);
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-unknown", cost: "worst", unknownWhy: "net-uncounted", grokOffer: false });
    expect(rig.settles(KLING)).toMatchObject([{ costMicros: KLING_RESERVE, estimated: true }]);
    expectNoGrok(rig, GROK);
  });

  test("(auto · /credits unreadable) the check cannot count: worst, estimated, no automatic Grok", async () => {
    await make({ mode: "auto", kling: refused, usage: () => "throw", grok: { terminal: { status: "completed", usageCostMicros: GROK_BILLED } } });
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-unknown", cost: "worst", unknownWhy: "net-uncounted", grokOffer: false });
    expect(rig.settles(KLING)).toMatchObject([{ costMicros: KLING_RESERVE, estimated: true }]);
    expectNoGrok(rig, GROK);
  });

  test("(auto · one /credits blip before the POST) the baseline is read three times, so the clip keeps its Grok", async () => {
    let reads = 0;
    await make({ mode: "auto", kling: refused, usage: () => (++reads === 1 ? "throw" : 5_000_000), grok: { terminal: { status: "completed", usageCostMicros: GROK_BILLED } } });
    expect(completed(await rig.run()).model).toBe("grok");
    expect(rig.settles(KLING)).toMatchObject([{ costMicros: 0, estimated: false }]);
  });

  test("(auto · /credits unreadable three times before the POST) no baseline: worst, no Grok", async () => {
    let reads = 0;
    await make({ mode: "auto", kling: refused, usage: () => (++reads <= 3 ? "throw" : 5_000_000), grok: { terminal: { status: "completed", usageCostMicros: GROK_BILLED } } });
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-unknown", unknownWhy: "net-uncounted" });
    expectNoGrok(rig, GROK);
  });

  test("(auto × fallback none · the check could not count) worst, estimated: not refused-free", async () => {
    await make({ mode: "auto", kling: refused, usage: () => "throw" });
    expect(failed(await rig.run({ request: { model: "kling", quality: "std", seconds: 5, fallback: "none" } }))).toMatchObject({ reason: "refused-unknown", cost: "worst", unknownWhy: "net-uncounted" });
    expect(rig.settles(KLING)).toMatchObject([{ costMicros: KLING_RESERVE, estimated: true }]);
  });

  test("(auto × «Смелая» kling-only · the check could not count) worst, estimated: not refused-free", async () => {
    await make({ mode: "auto", boldClips: "kling-only", kling: refused, usage: () => "throw" });
    expect(failed(await rig.run({ bold: true }))).toMatchObject({ reason: "refused-unknown", cost: "worst", unknownWhy: "net-uncounted" });
  });

  test("(auto · Grok's own attempt) the check could not count on it: worst", async () => {
    await make({ mode: "auto", kling: refused, grok: refused, usage: (t, posts) => (posts.grok !== undefined ? "throw" : 5_000_000) });
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-unknown", model: "grok", cost: "worst", unknownWhy: "net-uncounted" });
    expect(rig.settles()).toMatchObject([{ costMicros: 0 }, { costMicros: GROK_RESERVE, estimated: true }]);
  });

  test("(offer · check clean) settles 0 and offers Grok as a new click", async () => {
    await make({ mode: "offer", kling: refused });
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-free", cost: "free", grokOffer: true });
    expect(rig.clipLedger()).toEqual([
      ["reserve", KLING, KLING_RESERVE],
      ["settle", KLING, 0],
    ]);
    expectNoGrok(rig, GROK);
  });

  test("(offer · the check could not count: a photo run settled between the reads) a 404 is not zero: worst, estimated, no offer", async () => {
    await make({ mode: "offer", kling: refused, usage: (t) => usageWith(T0 + 100 * SECOND)(t) });
    photoRunInTheWindow(rig);
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-unknown", cost: "worst", unknownWhy: "net-uncounted", grokOffer: false });
    expect(rig.settles(KLING)).toMatchObject([{ costMicros: KLING_RESERVE, estimated: true }]);
    expectNoGrok(rig, GROK);
  });

  test("(offer · /credits unreadable) the check cannot count: worst, estimated, no offer", async () => {
    await make({ mode: "offer", kling: refused, usage: () => "throw" });
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-unknown", cost: "worst", unknownWhy: "net-uncounted", grokOffer: false });
    expect(rig.settles(KLING)).toMatchObject([{ costMicros: KLING_RESERVE, estimated: true }]);
  });

  test("(auto × fallback none · clean) ends refused-free: no Grok, no offer", async () => {
    await make({ mode: "auto", kling: refused });
    expect(failed(await rig.run({ request: { model: "kling", quality: "std", seconds: 5, fallback: "none" } }))).toMatchObject({ reason: "refused-free", cost: "free", grokOffer: false });
    expectNoGrok(rig, GROK);
  });

  test("(offer × fallback none · clean) ends refused-free: the strict proof counted, no offer", async () => {
    await make({ mode: "offer", kling: refused });
    expect(failed(await rig.run({ request: { model: "kling", quality: "std", seconds: 5, fallback: "none" } }))).toMatchObject({ reason: "refused-free", cost: "free", grokOffer: false });
    expect(rig.settles(KLING)).toMatchObject([{ costMicros: 0 }]);
  });

  test("(offer × fallback none · could not count) takes the strict proof too: worst, estimated", async () => {
    await make({ mode: "offer", kling: refused, usage: () => "throw" });
    expect(failed(await rig.run({ request: { model: "kling", quality: "std", seconds: 5, fallback: "none" } }))).toMatchObject({ reason: "refused-unknown", cost: "worst" });
  });

  test("(auto × «Смелая» kling-only · clean) ends refused-free: never Grok", async () => {
    await make({ mode: "auto", boldClips: "kling-only", kling: refused });
    expect(failed(await rig.run({ bold: true }))).toMatchObject({ reason: "refused-free", grokOffer: false });
    expectNoGrok(rig, GROK);
  });

  test("(offer × «Смелая» kling-only · clean) ends refused-free: no offer", async () => {
    await make({ mode: "offer", boldClips: "kling-only", kling: refused });
    expect(failed(await rig.run({ bold: true }))).toMatchObject({ reason: "refused-free", cost: "free", grokOffer: false });
  });

  test("(offer × «Смелая» kling-only · could not count) takes the strict proof: worst, estimated", async () => {
    await make({ mode: "offer", boldClips: "kling-only", kling: refused, usage: () => "throw" });
    expect(failed(await rig.run({ bold: true }))).toMatchObject({ reason: "refused-unknown", cost: "worst", unknownWhy: "net-uncounted" });
    expect(rig.settles(KLING)).toMatchObject([{ costMicros: KLING_RESERVE, estimated: true }]);
  });

  test("(offer × model grok · clean) ends refused-free: «Grok отказал бесплатно», no offer", async () => {
    await make({ mode: "offer", grok: refused });
    const result = failed(await rig.run({ request: { model: "grok", quality: "std", seconds: 5, fallback: "none" } }));
    expect(result).toMatchObject({ reason: "refused-free", model: "grok", cost: "free", grokOffer: false });
    expect(rig.posts("grok")).toHaveLength(1);
    expect(rig.posts("kling")).toHaveLength(0);
  });

  test("(offer × model grok · could not count) takes the strict proof: worst, estimated", async () => {
    await make({ mode: "offer", grok: refused, usage: () => "throw" });
    const result = failed(await rig.run({ request: { model: "grok", quality: "std", seconds: 5, fallback: "none" } }));
    expect(result).toMatchObject({ reason: "refused-unknown", cost: "worst", model: "grok" });
    expect(rig.settles(KLING)).toMatchObject([{ costMicros: GROK_RESERVE, estimated: true }]);
  });

  test("(auto) Kling and Grok both refused at the poll: refused-both, each proven free on its own", async () => {
    await make({ mode: "auto", kling: refused, grok: refused });
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-both", cost: "free", grokOffer: false });
    expect(rig.clipLedger()).toEqual([
      ["reserve", KLING, KLING_RESERVE],
      ["settle", KLING, 0],
      ["reserve", GROK, GROK_RESERVE],
      ["settle", GROK, 0],
    ]);
    expect(rig.posts()).toHaveLength(2);
  });

  test("a /generation record with total_cost 0 is zero evidence, like a 404", async () => {
    await make({ mode: "offer", kling: { terminal: REFUSED_BY_RISK_CONTROL, generation: () => genFound(0) } });
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-free", cost: "free", grokOffer: true });
  });

  test("a failed job whose text is unclear, but whose /generation says content_filter, is a content refusal", async () => {
    await make({
      mode: "offer",
      kling: { terminal: { status: "failed", error: null, contentFailure: false }, generation: () => ({ kind: "found", totalCostMicros: 0, finishReason: "content_filter" }) },
    });
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-free", cost: "free", grokOffer: true });
  });
});

describe.each(MODES)("row 8 · … the net-usage check shows an increase · mode %s", (mode) => {
  test("settles the worst, estimated; ends refused-unknown with no Grok and no offer", async () => {
    // The charge appears before the terminal status and is still there at the second read: a refusal that was billed.
    await make({ mode, kling: { terminal: REFUSED_BY_RISK_CONTROL }, usage: (t, posts) => 5_000_000 + (posts.kling !== undefined && t >= posts.kling + 38 * SECOND ? KLING_BILLED : 0) });
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-unknown", cost: "worst", unknownWhy: "net-increase", grokOffer: false });
    expect(rig.clipLedger()).toEqual([
      ["reserve", KLING, KLING_RESERVE],
      ["settle-estimated", KLING, KLING_RESERVE],
    ]);
    expect(journalOf(rig)).toContain(`ended:${KLING}:refused:worst`);
    expectNoGrok(rig, GROK);
  });
});

describe.each(MODES)("row 9 · … any /generation read > 0 · mode %s", (mode) => {
  test("at the first read: settles that total_cost; ends refused-paid with no Grok and no offer", async () => {
    await make({ mode, kling: { terminal: REFUSED_BY_RISK_CONTROL, generation: genFromAfter(15 * SECOND, KLING_BILLED) } });
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-paid", cost: "billed", grokOffer: false });
    expect(rig.clipLedger()).toEqual([
      ["reserve", KLING, KLING_RESERVE],
      ["settle", KLING, KLING_BILLED],
    ]);
    expect(journalOf(rig)).toContain(`ended:${KLING}:refused:generation`);
    expectNoGrok(rig, GROK);
  });

  test("at the second read: the record that appears late is still the bill", async () => {
    await make({ mode, kling: { terminal: REFUSED_BY_RISK_CONTROL, generation: genFromAfter(90 * SECOND, KLING_BILLED) } });
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-paid", cost: "billed" });
    expect(rig.settles(KLING)).toMatchObject([{ costMicros: KLING_BILLED, estimated: false }]);
    expect(rig.generationReads()).toHaveLength(2);
  });
});

describe.each(MODES)("row 10 · … unreadable after 3 reads · mode %s", (mode) => {
  test("the first read unreadable three times: settles the worst, estimated; ends refused-unknown", async () => {
    await make({ mode, kling: { terminal: REFUSED_BY_RISK_CONTROL, generation: genUnreadable } });
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-unknown", cost: "worst", unknownWhy: "unreadable", grokOffer: false });
    expect(rig.generationReads()).toHaveLength(3);
    expect(rig.clipLedger()).toEqual([
      ["reserve", KLING, KLING_RESERVE],
      ["settle-estimated", KLING, KLING_RESERVE],
    ]);
    expectNoGrok(rig, GROK);
  });

  test("the second read unreadable three times: the same", async () => {
    await make({ mode, kling: { terminal: REFUSED_BY_RISK_CONTROL, generation: (since) => (since < 60 * SECOND ? gen404() : genUnreadable()) } });
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-unknown", cost: "worst", unknownWhy: "unreadable" });
    expect(rig.generationReads()).toHaveLength(4);
  });
});

describe("row 11 · a poll-time non-content failure (`provider-error`) takes the same proof", () => {
  const providerFailed = { terminal: PROVIDER_FAILED };

  test("(auto · clean) settles 0 and ends provider-error, free: never Grok, never the offer", async () => {
    await make({ mode: "auto", kling: providerFailed });
    expect(failed(await rig.run())).toMatchObject({ reason: "provider-error", cost: "free", grokOffer: false });
    expect(rig.clipLedger()).toEqual([
      ["reserve", KLING, KLING_RESERVE],
      ["settle", KLING, 0],
    ]);
    expectNoGrok(rig, GROK);
  });

  test("(auto · /generation > 0) settles that value: «оплачено $X»", async () => {
    await make({ mode: "auto", kling: { ...providerFailed, generation: genFromAfter(15 * SECOND, 300_000) } });
    expect(failed(await rig.run())).toMatchObject({ reason: "provider-error", cost: "billed", grokOffer: false });
    expect(rig.settles(KLING)).toMatchObject([{ costMicros: 300_000, estimated: false }]);
  });

  test("(auto · unreadable) settles the worst, estimated", async () => {
    await make({ mode: "auto", kling: { ...providerFailed, generation: genUnreadable } });
    expect(failed(await rig.run())).toMatchObject({ reason: "provider-error", cost: "worst" });
    expect(rig.settles(KLING)).toMatchObject([{ costMicros: KLING_RESERVE, estimated: true }]);
  });

  test("(auto · a net increase) settles the worst, estimated", async () => {
    await make({ mode: "auto", kling: providerFailed, usage: (t, posts) => 5_000_000 + (posts.kling !== undefined && t >= posts.kling + 38 * SECOND ? KLING_BILLED : 0) });
    expect(failed(await rig.run())).toMatchObject({ reason: "provider-error", cost: "worst" });
  });

  test("(auto · the check could not count) worst, estimated: a 404 is not zero in either mode", async () => {
    await make({ mode: "auto", kling: providerFailed, usage: () => "throw" });
    expect(failed(await rig.run())).toMatchObject({ reason: "provider-error", cost: "worst", unknownWhy: "net-uncounted" });
    expect(rig.settles(KLING)).toMatchObject([{ costMicros: KLING_RESERVE, estimated: true }]);
  });

  test("(offer · clean) settles 0, free: the offer never follows a provider error", async () => {
    await make({ mode: "offer", kling: providerFailed });
    expect(failed(await rig.run())).toMatchObject({ reason: "provider-error", cost: "free", grokOffer: false });
    expect(rig.settles(KLING)).toMatchObject([{ costMicros: 0 }]);
  });

  test("(offer · the check could not count) a 404 is not zero: worst, estimated", async () => {
    await make({ mode: "offer", kling: providerFailed, usage: () => "throw" });
    expect(failed(await rig.run())).toMatchObject({ reason: "provider-error", cost: "worst" });
    expect(rig.settles(KLING)).toMatchObject([{ costMicros: KLING_RESERVE, estimated: true }]);
  });

  test("(offer · /generation > 0) settles that value", async () => {
    await make({ mode: "offer", kling: { ...providerFailed, generation: genFromAfter(15 * SECOND, 300_000) } });
    expect(failed(await rig.run())).toMatchObject({ reason: "provider-error", cost: "billed" });
  });

  test.each(["cancelled", "expired"] as const)("a job that ends %s is a provider error too", async (status) => {
    await make({ mode: "auto", kling: { terminal: { status, error: null, contentFailure: false } } });
    expect(failed(await rig.run())).toMatchObject({ reason: "provider-error", cost: "free" });
    expect(journalOf(rig)).toContain(`ended:${KLING}:${status}:proof`);
    expectNoGrok(rig, GROK);
  });

  test("(auto) Grok's own provider error is final too: no third attempt", async () => {
    await make({ mode: "auto", kling: { submit: moderation4xx }, grok: providerFailed });
    expect(failed(await rig.run())).toMatchObject({ reason: "provider-error", model: "grok", cost: "free", grokOffer: false });
    expect(rig.posts()).toHaveLength(2);
  });
});

describe.each(MODES)("row 12 · no terminal status 20 min after the submit · mode %s", (mode) => {
  test("abandons the reserve (open at worst), goes `late`, holds to 60 min, and reads no /generation", async () => {
    await make({ mode, kling: { terminalAfterMs: "never" } });
    const result = late(await rig.run());
    expect(result.late).toMatchObject({ attemptId: KLING, model: "kling", providerJobId: "job-kling", submittedAtMs: T0, giveUpAtMs: T0 + 60 * MINUTE });
    expect(result.attempts[0]).toMatchObject({ attemptId: KLING, outcome: "late" });
    expect(rig.t).toBe(T0 + 20 * MINUTE);
    expect(rig.clipLedger()).toEqual([["reserve", KLING, KLING_RESERVE]]);
    expect(rig.trace).toContain(`ledger:abandon:${KLING}`);
    expect(rig.holds.untilOf(KLING)).toBe(T0 + 60 * MINUTE);
    expect(rig.phases.at(-1)?.phase).toBe("late");
    expect(rig.generationReads()).toHaveLength(0);
    expect(journalOf(rig)).toEqual(["requested", `submitted:${KLING}`]);
    expectNoGrok(rig, GROK);
  });
});

describe("row 12 → a late result writes no ledger line", () => {
  async function lateKling(terminalAfterMs: number | "never", more: JobScript = {}) {
    await make({ mode: "auto", kling: { terminalAfterMs, ...more } });
    const first = late(await rig.run());
    const before = await Bun.file(rig.ledgerPath).text();
    return { first, before };
  }

  test("a late `completed`: the file is fetched, the ledger file is byte-equal, the hold becomes terminal + 2 min", async () => {
    const { first, before } = await lateKling(30 * MINUTE);
    const outcome = await awaitLateClip(rig.deps, first.late, rig.signal);
    expect(outcome).toEqual({ kind: "completed", providerCostMicros: KLING_BILLED });
    expect(await Bun.file(rig.ledgerPath).text()).toBe(before);
    expect(journalOf(rig).at(-1)).toBe(`ended:${KLING}:completed:none`);
    expect(rig.holds.untilOf(KLING)).toBe(rig.t + 2 * MINUTE);
    expect(rig.t).toBeGreaterThanOrEqual(T0 + 30 * MINUTE);
  });

  test("a late attempt that ends in failure: failed `late`, no ledger line", async () => {
    const { first, before } = await lateKling(30 * MINUTE, { terminal: REFUSED_BY_RISK_CONTROL });
    expect(await awaitLateClip(rig.deps, first.late, rig.signal)).toEqual({ kind: "failed", reason: "late" });
    expect(await Bun.file(rig.ledgerPath).text()).toBe(before);
  });

  test("no result by 60 min after the submit: failed `late`, polls every 60 s, then stops", async () => {
    const { first } = await lateKling("never");
    expect(await awaitLateClip(rig.deps, first.late, rig.signal)).toEqual({ kind: "failed", reason: "late" });
    expect(rig.t).toBe(T0 + 60 * MINUTE);
    expect(journalOf(rig).at(-1)).toBe(`ended:${KLING}:late:none`);
    const latePolls = rig.calls.filter((c) => c.type === "poll" && c.t > T0 + 20 * MINUTE);
    expect(latePolls.length).toBe(40);
  });

  test("a result that arrives exactly at the 60 min mark is still read", async () => {
    const { first } = await lateKling(60 * MINUTE);
    expect((await awaitLateClip(rig.deps, first.late, rig.signal)).kind).toBe("completed");
  });
});

describe("the clip id the ledger uses", () => {
  test("names the attempts `<clipId>:video#1` and `#2`", () => {
    expect(KLING).toBe(clipAttemptId(CLIP_ID, 1));
    expect(GROK).toBe(clipAttemptId(CLIP_ID, 2));
  });
});
