import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CategorySnapshot } from "../../shared/engine";
import { SceneSetStore, type ReviewWriteRecord, type StoredSceneSet } from "../library/sceneSets";
import { ownScene, sampleSet } from "../library/testing/sceneSetSample";
import { useTempDir } from "../library/testing/helpers";
import { until } from "../testing/engineHarness";
import { chatBody, fakeFetch, makeClient, setupMoney, type FetchCall, type Money, type Reply, type Step } from "../openrouter/testing/fakes";
import { NetworkPool } from "../runs/pools";
import type { PlanSlot } from "../scenes";
import { writerMessages } from "../scenes/writer";
import { ideaSystemPrompt } from "../scenes/ideaWriter";
import { beginIdea, beginRewrite, withReviewWriteAccepted, withReviewWriteClosed } from "./reviewMutations";
import { runReviewWrite, type ReviewWriteEnd } from "./reviewWriteJob";
import { reservedIdeaScenes, reviewWriteState } from "./reviewWrites";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// CS.4b: the job of a rewrite or an idea write. ONE writer request (two attempts at most, counted from the ledger across every job), asked about the scenes
// of the write alone: the compose prompt for a planned scene, the idea prompt for an own one and for an idea write. An accepted answer is stored whole before
// the job ends; a write that cannot be answered is resolved, one that got no answer stays resumable under its own ids.

const root = useTempDir("studio-review-write-");
const AVATAR = "avatar-aaaa-0001";
const SET = "set-aaaa-0001";
const id = (k: number, n: number) => `${SET}:write-${k}#${n}`;
const OLD = "An old sentence that must survive a failed write.";
const NEW = "She stands at the open window with a cup in her free hand while the morning light crosses the room behind her.";

let money: Money;
let store: SceneSetStore;
beforeEach(async () => {
  money = await setupMoney();
  store = new SceneSetStore(root());
});
afterEach(async () => {
  await money.cleanup();
});

const CAT = "cat-paris-cafes" as const;
const OLD_SNAPSHOT: CategorySnapshot = { ref: CAT, name: "Paris", label: "Paris cafes (old)", style: "phone" };
const FRESH_SNAPSHOT: CategorySnapshot = { ref: CAT, name: "Paris", label: "Parisian cafes (fresh)", style: "editorial" };

/** Four written planned scenes (one of them in a custom category), an own scene 5 written from an idea, and write 1 behind it. */
async function seed(change: (set: StoredSceneSet) => StoredSceneSet = (s) => s): Promise<void> {
  const base = sampleSet({ count: 4, written: 4 });
  const cafe = { category: CAT, location: "a corner cafe in Paris", activity: "reading a menu", outfit: "a beige trench coat", timeOfDay: "morning" };
  const planned = base.scenes.map((s) => ({ ...s, text: OLD, ...(s.sceneId === 3 ? { slot: { ...s.slot, ...cafe } } : {}) }));
  const custom = [...planned, ownScene(5, { idea: "кофе на балконе утром", text: "Typed by hand, not the idea.", edited: true, shot: "selfie", pose: "front" })];
  const made = await store.create({ ...base, scenes: custom, categories: [OLD_SNAPSHOT], request: { ...base.request, categories: ["home", CAT] }, writes: 1 } as never);
  await store.update(AVATAR, made.sceneSetId, change);
}

const slotOf = (set: StoredSceneSet, sceneId: number): PlanSlot => {
  const scene = set.scenes.find((s) => s.sceneId === sceneId);
  if (scene === undefined || scene.origin !== "planned") throw new Error("not planned");
  return scene.slot;
};

function messagesOf(call: FetchCall): { role: string; content: string }[] {
  const body = call.json();
  return Array.isArray(body.messages) ? (body.messages as { role: string; content: string }[]) : [];
}
function listAsked(call: FetchCall): { slotIndex: number; [key: string]: unknown }[] {
  const text = messagesOf(call).find((m) => m.role === "user")?.content ?? "";
  return JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
}
const slotsAskedFor = (call: FetchCall): number[] => listAsked(call).map((s) => s.slotIndex);

const good: Step = (call) => ({ status: 200, body: chatBody(JSON.stringify({ scenes: slotsAskedFor(call).map((slotIndex) => ({ slotIndex, sentence: `${NEW} (${slotIndex})` })) }), { cost: 0.0042 }) });
const rejected: Step = { status: 200, body: chatBody(JSON.stringify({ scenes: [] }), { cost: 0.002 }) };
const refusal: Step = { status: 400, body: { error: { message: "xAI blocked this request through content moderation." } } };
const rateLimited: Step = { status: 429, headers: { "retry-after": "120" }, body: { error: { message: "rate limited" } } };
const offline: Step = { reject: new TypeError("fetch failed") };

async function setNow(): Promise<StoredSceneSet> {
  const set = await store.get(AVATAR, SET);
  if (set === null) throw new Error("the set is gone");
  return set;
}
const recordOf = async (k: number): Promise<ReviewWriteRecord> => {
  const record = (await setNow()).reviewWrites?.find((r) => r.k === k);
  if (record === undefined) throw new Error(`no write ${k}`);
  return record;
};

/** Records write 2 the way the service does, before the job: a rewrite of `sceneIds`, with the redraw it drew. */
async function recordRewrite(sceneIds: number[], redraw: { slots: PlanSlot[]; snapshots?: CategorySnapshot[] } | null = null): Promise<void> {
  await store.update(AVATAR, SET, (s) => beginRewrite(s, { jobId: "job-aaaa-0002", sceneIds, redraw: redraw !== null, slots: redraw?.slots ?? [], snapshots: redraw?.snapshots ?? [] }));
}
async function recordIdea(idea: string, count: number, shot: "friend" | null = null): Promise<void> {
  await store.update(AVATAR, SET, (s) =>
    beginIdea(s, { jobId: "job-aaaa-0002", idea, count, shot, scenes: Array.from({ length: count }, (_, i) => ({ sceneId: 6 + i, shot: shot ?? "friend", pose: "front" as const })) }),
  );
}

function run(steps: Step[], opts: { k?: number; jobId?: string; signal?: AbortSignal } = {}) {
  const net = fakeFetch(steps);
  const { client } = makeClient(net.fetch);
  const pool = new NetworkPool({ max: 6 });
  const progress: number[] = [];
  const closed: number[] = [];
  const k = opts.k ?? 2;
  const jobId = opts.jobId ?? "job-aaaa-0002";
  const end = runReviewWrite(
    {
      chat: client.chat,
      budget: money.budget,
      priceBook: money.priceBook,
      acquire: (signal) => pool.acquire(signal),
      load: async () => setNow(),
      accept: async (_k, sentences) => {
        await store.update(AVATAR, SET, (s) => withReviewWriteAccepted(s, k, sentences));
      },
      giveUp: async (given) => {
        closed.push(given);
        await store.update(AVATAR, SET, (s) => withReviewWriteClosed(s, given));
      },
      progress: (done) => progress.push(done),
    },
    { k, jobId, scope: { avatarJobId: jobId }, signal: opts.signal ?? new AbortController().signal },
  );
  return { net, end, progress, closed, pool };
}

function reserveIds(): string[] {
  return money.lines().flatMap((l) => (l.type === "reserve" && typeof l.attemptId === "string" ? [l.attemptId] : []));
}

describe("a rewrite of planned scenes", () => {
  test("asks once under write 2's first id, about the target scenes alone, and gives them their new sentences", async () => {
    await seed();
    await recordRewrite([2, 4]);
    const { net, end, progress } = run([good]);

    expect(await end).toEqual({ status: "done", written: 2, unwritten: 0 });
    expect(reserveIds()).toEqual([id(2, 1)]);
    expect(slotsAskedFor(net.calls[0] as FetchCall)).toEqual([2, 4]);
    expect(progress).toEqual([2]);
    const set = await setNow();
    expect(set.scenes.map((s) => s.text)).toEqual([OLD, `${NEW} (2)`, OLD, `${NEW} (4)`, "Typed by hand, not the idea."]);
  });

  test("sends the compose prompt, byte for byte, with the scene's own place", async () => {
    await seed();
    await recordRewrite([2]);
    const { net, end } = run([good]);
    await end;

    const set = await setNow();
    const expected = writerMessages([slotOf(set, 2)]);
    expect(messagesOf(net.calls[0] as FetchCall)).toEqual(expected);
  });

  test("leaves every scene outside the target exactly as it was", async () => {
    await seed();
    const before = await setNow();
    await recordRewrite([2]);
    await run([good]).end;
    const after = await setNow();
    expect(after.scenes.filter((s) => s.sceneId !== 2)).toEqual(before.scenes.filter((s) => s.sceneId !== 2));
    expect(after.chunks).toEqual(before.chunks);
  });

  test("a redraw is asked with the NEW place and the category's fresh label, and the scene takes them only with the accepted sentence", async () => {
    await seed();
    const before = await setNow();
    const slot: PlanSlot = { ...slotOf(before, 3), location: "a rooftop garden", outfit: "a red coat", activity: "watering a plant", timeOfDay: "dusk" };
    await recordRewrite([3], { slots: [slot], snapshots: [FRESH_SNAPSHOT] });
    const { net, end } = run([good]);

    expect(await end).toMatchObject({ status: "done", written: 1 });
    const asked = JSON.stringify(messagesOf(net.calls[0] as FetchCall));
    expect(asked).toContain("a rooftop garden");
    expect(asked).toContain("a red coat");
    expect(asked).toContain("Parisian cafes (fresh)");
    expect(asked).not.toContain("Paris cafes (old)");
    expect(asked).not.toContain(slotOf(before, 3).location);
    const after = await setNow();
    expect(slotOf(after, 3)).toEqual(slot);
    expect(after.categories).toEqual([FRESH_SNAPSHOT]);
  });

  test("a resumed older redraw is asked with the label of the fresher snapshot a later write put in the set", async () => {
    const NEWER: CategorySnapshot = { ref: CAT, name: "Paris", label: "Paris cafes (newest)", style: "phone" };
    await seed((s) => ({ ...s, categories: [NEWER], snapshotWrites: { [CAT]: 3 } }));
    const before = await setNow();
    const slot: PlanSlot = { ...slotOf(before, 3), location: "a rooftop garden" };
    await recordRewrite([3], { slots: [slot], snapshots: [FRESH_SNAPSHOT] });
    const { net, end } = run([good]);
    await end;
    const asked = JSON.stringify(messagesOf(net.calls[0] as FetchCall));
    expect(asked).toContain("Paris cafes (newest)");
    expect(asked).not.toContain("Parisian cafes (fresh)");
  });

  test("a rewrite without a redraw uses the label the set holds for the category", async () => {
    await seed();
    await recordRewrite([3]);
    const { net, end } = run([good]);
    await end;
    expect(JSON.stringify(messagesOf(net.calls[0] as FetchCall))).toContain("Paris cafes (old)");
  });
});

describe("a rewrite of an own scene", () => {
  test("is the idea prompt, written from the STORED idea: the current text, typed by hand, is never sent", async () => {
    await seed();
    await recordRewrite([5]);
    const { net, end } = run([good]);

    expect(await end).toMatchObject({ status: "done", written: 1 });
    const messages = messagesOf(net.calls[0] as FetchCall);
    expect(messages[0]?.content).toBe(ideaSystemPrompt());
    expect(listAsked(net.calls[0] as FetchCall)).toEqual([{ slotIndex: 5, idea: "кофе на балконе утром", shot: "front-camera selfie", pose: "facing the camera" }]);
    expect(JSON.stringify(messages)).not.toContain("Typed by hand");
  });

  test("replaces the text with the accepted sentence and keeps the scene's idea, shot and pose", async () => {
    await seed();
    await recordRewrite([5]);
    await run([good]).end;
    const scene = (await setNow()).scenes.find((s) => s.sceneId === 5);
    expect(scene).toMatchObject({ origin: "own", text: `${NEW} (5)`, edited: false, idea: "кофе на балконе утром", shot: "selfie", pose: "front" });
  });
});

describe("an idea write", () => {
  test("asks about the scene ids it reserved, with the idea verbatim, and adds the scenes with the accepted sentences", async () => {
    await seed();
    await recordIdea("прогулка по набережной на закате", 2);
    const { net, end, progress } = run([good]);

    expect(await end).toEqual({ status: "done", written: 2, unwritten: 0 });
    expect(reserveIds()).toEqual([id(2, 1)]);
    const asked = listAsked(net.calls[0] as FetchCall);
    expect(asked.map((s) => [s.slotIndex, s.idea])).toEqual([[6, "прогулка по набережной на закате"], [7, "прогулка по набережной на закате"]]);
    expect(messagesOf(net.calls[0] as FetchCall)[0]?.content).toBe(ideaSystemPrompt());
    expect(progress).toEqual([2]);
    const set = await setNow();
    expect(set.scenes.slice(5).map((s) => [s.sceneId, s.origin, s.text])).toEqual([[6, "own", `${NEW} (6)`], [7, "own", `${NEW} (7)`]]);
  });

  test("changes no planned scene", async () => {
    await seed();
    const before = await setNow();
    await recordIdea("прогулка", 1);
    await run([good]).end;
    expect((await setNow()).scenes.slice(0, 5)).toEqual(before.scenes);
  });
});

describe("a write that cannot be answered", () => {
  test("two rejected answers resolve it: two calls under its first two ids, nothing changed, nothing left to resume", async () => {
    await seed();
    const before = await setNow();
    await recordRewrite([2]);
    const { net, end, closed } = run([rejected, rejected, good]);

    expect(await end).toMatchObject({ status: "failed", resolved: true, stoppedBy: "failed", error: { code: "INTERNAL" } });
    expect(net.calls).toHaveLength(2);
    expect(reserveIds()).toEqual([id(2, 1), id(2, 2)]);
    expect(closed).toEqual([2]);
    expect((await setNow()).scenes).toEqual(before.scenes);
    expect(JSON.stringify(net.calls[1]?.json())).toContain("An earlier answer was rejected");
  });

  test("a rejected answer is asked again under the next id, and the second answer is accepted", async () => {
    await seed();
    await recordRewrite([2]);
    const { end, closed } = run([rejected, good]);
    expect(await end).toEqual({ status: "done", written: 1, unwritten: 0 });
    expect(reserveIds()).toEqual([id(2, 1), id(2, 2)]);
    expect(closed).toEqual([]);
  });

  test("a provider's refusal is final: one call, resolved with MODERATION_REFUSED, nothing changed", async () => {
    await seed();
    const before = await setNow();
    await recordIdea("something", 1);
    const { net, end, closed } = run([refusal, good]);

    expect(await end).toMatchObject({ status: "failed", resolved: true, error: { code: "MODERATION_REFUSED" } });
    expect(net.calls).toHaveLength(1);
    expect(closed).toEqual([2]);
    expect((await setNow()).scenes).toEqual(before.scenes);
  });

  test("a failed write leaves the scene exactly as it was, not one byte of it changed", async () => {
    await seed();
    const before = await setNow();
    const slot: PlanSlot = { ...slotOf(before, 3), location: "a rooftop garden" };
    await recordRewrite([3], { slots: [slot], snapshots: [FRESH_SNAPSHOT] });
    await run([rejected, rejected]).end;
    const after = await setNow();
    expect(after.scenes).toEqual(before.scenes);
    expect(after.categories).toEqual(before.categories);
  });
});

describe("a write that got no answer stops, resumable", () => {
  test("a final 429 stops it at once, nothing resolved: both attempts are still its own", async () => {
    await seed();
    await recordRewrite([2]);
    const { net, end, closed } = run([rateLimited]);

    expect(await end).toMatchObject({ status: "failed", stoppedBy: "rate-limited", resolved: false, error: { code: "RATE_LIMITED" } });
    expect(net.calls).toHaveLength(1);
    expect(closed).toEqual([]);
    expect(reviewWriteState(await recordOf(2), money.budget.ledger)).toMatchObject({ answered: 0, attemptsLeft: 2 });
  });

  test("a dropped connection leaves its reserve open at the worst case: one attempt is left, the write is not resolved", async () => {
    await seed();
    await recordRewrite([2]);
    const { end, closed } = run([offline]);

    expect(await end).toMatchObject({ status: "failed", stoppedBy: "network", resolved: false });
    expect(closed).toEqual([]);
    expect(money.budget.status()).toMatchObject({ openAttempts: 1, openReserveMicros: 37_500 });
    expect(reviewWriteState(await recordOf(2), money.budget.ledger)).toMatchObject({ answered: 1, attemptsLeft: 1 });
  });

  test("a resume carries the same write on: it sends the next unused id and never the reserved one again", async () => {
    await seed();
    await recordRewrite([2]);
    await run([offline], { jobId: "job-aaaa-0002" }).end;
    const second = run([good], { jobId: "job-aaaa-0003" });

    expect(await second.end).toEqual({ status: "done", written: 1, unwritten: 0 });
    expect(reserveIds()).toEqual([id(2, 1), id(2, 2)]);
    expect((await setNow()).scenes[1]?.text).toBe(`${NEW} (2)`);
  });

  test("a resume of a redraw draws nothing new: it asks about the very place the first attempt was asked about", async () => {
    await seed();
    const before = await setNow();
    const slot: PlanSlot = { ...slotOf(before, 3), location: "a rooftop garden", outfit: "a red coat" };
    await recordRewrite([3], { slots: [slot], snapshots: [FRESH_SNAPSHOT] });
    const first = run([offline], { jobId: "job-aaaa-0002" });
    await first.end;
    const second = run([good], { jobId: "job-aaaa-0003" });
    await second.end;

    expect(messagesOf(first.net.calls[0] as FetchCall)).toEqual(messagesOf(second.net.calls[0] as FetchCall).map((m) => (m.role === "user" ? { ...m } : m)));
  });

  test("never a fresh pair: after one interrupted attempt the write gets ONE more, and if that is rejected it is resolved", async () => {
    await seed();
    await recordRewrite([2]);
    await run([offline], { jobId: "job-aaaa-0002" }).end;
    const second = run([rejected, good], { jobId: "job-aaaa-0003" });

    expect(await second.end).toMatchObject({ status: "failed", resolved: true });
    expect(second.net.calls).toHaveLength(1);
    expect(reserveIds()).toEqual([id(2, 1), id(2, 2)]);
    expect(second.closed).toEqual([2]);
  });

  test("a stop that leaves no attempt (a rejected answer, then a dropped connection) resolves the write: nothing could be resumed", async () => {
    await seed();
    await recordRewrite([2]);
    const { end, closed } = run([rejected, offline]);

    expect(await end).toMatchObject({ status: "failed", stoppedBy: "network", resolved: true });
    expect(closed).toEqual([2]);
  });

  test("a reconcile's estimated settle of the interrupted request counts as answered too", async () => {
    await seed();
    await recordRewrite([2]);
    await run([offline], { jobId: "job-aaaa-0002" }).end;
    await money.ledger.append({ type: "settle", attemptId: id(2, 1), costMicros: 37_500, estimated: true, at: "2026-10-07T12:00:00.000Z" });
    const second = run([rejected, good], { jobId: "job-aaaa-0003" });
    expect(await second.end).toMatchObject({ status: "failed", resolved: true });
    expect(second.net.calls).toHaveLength(1);
  });
});

describe("cancel and the network slot", () => {
  test("a job cancelled before its call sends nothing and changes nothing", async () => {
    await seed();
    const before = await setNow();
    await recordRewrite([2]);
    const controller = new AbortController();
    controller.abort();
    const { net, end } = run([good], { signal: controller.signal });
    expect(await end).toEqual({ status: "cancelled" });
    expect(net.calls).toHaveLength(0);
    expect((await setNow()).scenes).toEqual(before.scenes);
  });

  test("a cancel while the request is out ends the job cancelled and leaves the reserve open", async () => {
    await seed();
    await recordRewrite([2]);
    const controller = new AbortController();
    const { end } = run([{ hang: true }], { signal: controller.signal });
    await until(() => money.budget.status().openAttempts === 1, "the request's reserve");
    controller.abort();
    expect(await end).toEqual({ status: "cancelled" });
    expect(money.budget.status().openAttempts).toBe(1);
  });

  test("a cancel on the last attempt resolves the write: nothing could be resumed, so no invisible record keeps its room", async () => {
    await seed();
    await recordRewrite([2]);
    await run([offline], { jobId: "job-aaaa-0002" }).end;
    const controller = new AbortController();
    const second = run([{ hang: true }], { jobId: "job-aaaa-0003", signal: controller.signal });
    await until(() => money.budget.status().openAttempts === 2, "the second attempt's reserve");
    controller.abort();

    expect(await second.end).toEqual({ status: "cancelled" });
    expect(second.closed).toEqual([2]);
    expect((await recordOf(2)).closed).toBe(true);
  });

  test("a cancel that leaves an attempt keeps the write resumable", async () => {
    await seed();
    await recordRewrite([2]);
    const controller = new AbortController();
    const { end, closed } = run([{ hang: true }], { signal: controller.signal });
    await until(() => money.budget.status().openAttempts === 1, "the request's reserve");
    controller.abort();

    expect(await end).toEqual({ status: "cancelled" });
    expect(closed).toEqual([]);
    expect((await recordOf(2)).closed).toBe(false);
  });

  test("an idea write cancelled on its last attempt gives its reserved scene room back", async () => {
    await seed();
    await recordIdea("кофе на балконе", 2);
    await run([offline], { jobId: "job-aaaa-0002" }).end;
    const controller = new AbortController();
    const second = run([{ hang: true }], { jobId: "job-aaaa-0003", signal: controller.signal });
    await until(() => money.budget.status().openAttempts === 2, "the second attempt's reserve");
    controller.abort();
    await second.end;

    expect(reservedIdeaScenes(await setNow(), null)).toBe(0);
  });

  test("every call takes a network slot and gives it back", async () => {
    await seed();
    await recordRewrite([2]);
    const { pool, end } = run([good]);
    await end;
    expect(pool.active).toBe(0);
  });
});

describe("money", () => {
  test("the request reserves the writer's ceiling before it is sent and settles after, under the job's own scope", async () => {
    await seed();
    await recordRewrite([2]);
    await run([good], { jobId: "job-aaaa-0007" }).end;
    const lines = money.lines();
    expect(lines.map((l) => l.type)).toEqual(["reserve", "settle"]);
    expect(lines[0]).toMatchObject({ attemptId: id(2, 1), jobId: "job-aaaa-0007", scope: { avatarJobId: "job-aaaa-0007" }, worstMicros: 37_500 });
  });

  test("a bill above the worst case is a failure that halts every later reserve", async () => {
    await seed();
    await recordRewrite([2]);
    const dear: Step = (call) => ({ status: 200, body: chatBody(JSON.stringify({ scenes: slotsAskedFor(call).map((slotIndex) => ({ slotIndex, sentence: NEW })) }), { cost: 5 }) });
    expect(await run([dear]).end).toMatchObject({ status: "failed", error: { code: "SETTLE_ABOVE_WORST" }, resolved: false });
  });

  test("the cap of the job's scope bounds it: a second attempt that does not fit is refused, nothing is sent for it", async () => {
    const capped = await setupMoney({ runCapMicros: 37_500 });
    await money.cleanup();
    money = capped;
    await seed();
    await recordRewrite([2]);
    const { net, end } = run([rejected, good]);
    expect(await end).toMatchObject({ status: "failed", error: { code: "RUN_CAP_EXCEEDED" } });
    expect(net.calls).toHaveLength(1);
  });
});

describe("what the job refuses to run", () => {
  test("a write the set does not have is a bug, not a request", async () => {
    await seed();
    const { end } = run([good], { k: 9 });
    await expect(end).rejects.toThrow();
  });

  test("a resolved write is not run again", async () => {
    await seed();
    await recordRewrite([2]);
    await store.update(AVATAR, SET, (s) => withReviewWriteClosed(s, 2));
    const { net, end } = run([good]);
    await expect(end).rejects.toThrow();
    expect(net.calls).toHaveLength(0);
  });
});

describe("the type of Reply", () => {
  test("is the fake's own (keeps the import used)", () => {
    const reply: Reply = { status: 200, body: {} };
    expect(reply.status).toBe(200);
    const end: ReviewWriteEnd = { status: "cancelled" };
    expect(end.status).toBe("cancelled");
  });
});
