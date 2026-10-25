import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { batchOf, cancelBatch, createBatch, jobsOf, mostOpenClipReserves, plainPhotos, seedBatchAvatar } from "./clips/testing/batchKit";
import { clipNetwork, command, create, startClipEngine, until, type ClipEngine, type VideoScript } from "./clips/testing/engineClipKit";
import { chatReply, MODERATED, motionNetwork, type ChatHandler } from "./clips/testing/motionNet";
import { GOOD_TEXTS, IDEA, motionWorld } from "./clips/testing/motionWorld";
import { ledgerLines, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { join } from "node:path";
useNativeGlobals();

// Stage 5, 5b.2, S5.WB2 (plan s5b2 §8 «invariants on every path»): a batch is walked through random but fixed scripts: clean clips, free refusals, a 429, an uncertain submit, a bill above the reserve, and a
// cancel of the queue at a random moment. On every path: never two members between their reserve and their settle, the paid count balanced (the reconcile is never held IN_FLIGHT after the batch), the hold
// map empty, and no cap left behind (the month's room is the budget less what was spent and what is still open at worst).

setDefaultTimeout(120_000);

const dir = useEngineDir("studio-engine-clip-batch-property-");
const libraryDir = () => join(dir(), "library");
const BUDGET = 10_000_000;
const RISK_CONTROL = "task failed with status: FAIL, message: Failure to pass the risk control system";

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

/** What a POST does, drawn from a weighted pool: mostly clean, and now and then something that ends or stops a batch. */
function scriptFor(draw: number): VideoScript | undefined {
  if (draw < 0.5) return undefined;
  if (draw < 0.65) return { terminal: { status: "failed", error: RISK_CONTROL } };
  if (draw < 0.8) return { submit: { status: 429, body: { error: { code: 429, message: "Rate limit exceeded" } } } };
  if (draw < 0.9) return { submit: { status: 502 } };
  return { terminal: { status: "completed", cost: 0.6 } };
}

async function settled(engine: ClipEngine): Promise<void> {
  // The unit is given back (the reconcile is not held IN_FLIGHT) and every clip job has ended.
  const deadline = Date.now() + 30_000;
  for (;;) {
    const answer = await engine.engine.handle(command("money.reconcile"));
    const unitFree = !(answer.ok === false && answer.error.code === "IN_FLIGHT");
    const running = (await jobsOf(engine)).some((job) => job.kind === "clip" && job.status === "running");
    if (unitFree && !running) return;
    if (Date.now() > deadline) throw new Error("the batch did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** What the seeds below actually exercised: a property over paths that never took one would pass for nothing. */
const seen = new Set<string>();

describe("a batch on every path (fixed seeds)", () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    test(`seed ${seed}: one reserve open at a time, the paid count balanced, no hold and no cap left`, async () => {
      const rand = seeded(seed * 7919);
      const size = 1 + Math.floor(rand() * 4);
      const draws = Array.from({ length: 12 }, () => rand());
      const cancelAfter = rand() < 0.35 ? Math.floor(rand() * 3) : -1;
      const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(size));
      const net = clipNetwork({ klingBy: (n) => scriptFor(draws[(n - 1) % draws.length] ?? 1) });
      const engine = await startClipEngine(dir(), { net, monthlyBudgetMicros: BUDGET });

      let postsAtCancel = 0;
      const { batchId } = batchOf(await createBatch(engine, { avatarId, photoIds }));
      if (cancelAfter >= 0) {
        await until(() => engine.net.posts("kling").length > cancelAfter, "the cancel point").catch(() => undefined);
        await cancelBatch(engine, avatarId, batchId);
        // The member in flight at the cancel may still have its one POST to make; no other may follow it.
        postsAtCancel = engine.net.posts("kling").length;
      }
      await settled(engine);
      if (cancelAfter >= 0) expect(engine.net.posts("kling").length).toBeLessThanOrEqual(postsAtCancel + 1);

      const lines = ledgerLines(dir());
      for (const event of engine.events()) {
        if (event.type === "job.cancelled" && event.payload.kind === "clip" && event.payload.detail !== undefined) seen.add(event.payload.detail);
        if (event.type === "job.progress" && event.payload.kind === "clip" && event.payload.waitReason === "rate-limit") seen.add("429");
      }
      if (lines.some((line) => line.type === "reserve" && String(line.attemptId).endsWith("#2"))) seen.add("grok");
      expect(mostOpenClipReserves(lines)).toBeLessThanOrEqual(1);
      const status = engine.engine.budget?.status();
      expect(status?.heldMicros).toBe(0);
      const open = status?.openReserveMicros ?? 0;
      expect(engine.engine.monthRoom()?.freeMicros).toBe(BUDGET - (status?.spentThisMonthMicros ?? 0) - open);
      // No member sits queued, and the unit is free: the next batch is refused for anything but IN_FLIGHT, unless a clip's money is still open (WB2d, L2): then it is refused RECONCILE_REQUIRED, free.
      expect((await jobsOf(engine)).some((job) => job.kind === "clip" && job.status === "running")).toBe(false);
      const moneyOpen = (engine.engine.budget?.ledger.openReserves().length ?? 0) > 0;
      const next = await createBatch(engine, { avatarId, photoIds: photoIds.slice(0, 1) });
      if (moneyOpen) expect(next).toMatchObject({ ok: false, error: { code: "RECONCILE_REQUIRED" } });
      else if (!next.ok) expect(next.error.code).not.toBe("IN_FLIGHT");
      await settled(engine);
    });
  }

  test("the seeds took the paths that matter: a free refusal into Grok, a 429, a cancel, an uncertain stop and a halted-ledger stop", () => {
    for (const path of ["grok", "429", "cancelled", "money-uncertain", "ledger-stopped"]) expect(seen.has(path)).toBe(true);
  });
});

// ---------- S5.FU-DATA 8: part C calls and single clips on every path ----------
//
// The global guard (r2.1 N10) in both directions: a part C call (a chat reserve) and a clip (a clip reserve) are never open together; whichever comes second is refused IN_FLIGHT, free. The calls are
// started in random groups so that they meet, over chat answers that are good, unreadable, moderated or a 5xx, and over clips that end clean or fail. On every path the paid count ends at 0 (`paidStart`
// and `paidEnd` balance, a failed call included) and the guard is free again.

/** A chat attempt of a part C call has the id `<jobId>:motion#N` or `<jobId>:idea#N`; every other reserve of this test is a clip's. */
const isChatAttempt = (attemptId: string): boolean => /:(motion|idea)#\d+$/.test(attemptId);

/** The most chat reserves and the most clip reserves open at once, and whether one of each was ever open together. */
export function openByKind(lines: readonly Record<string, unknown>[]): { chat: number; clip: number; together: boolean } {
  const chat = new Set<string>();
  const clip = new Set<string>();
  let mostChat = 0;
  let mostClip = 0;
  let together = false;
  for (const line of lines) {
    const attemptId = String(line.attemptId);
    const open = isChatAttempt(attemptId) ? chat : clip;
    if (line.type === "reserve") open.add(attemptId);
    else if (line.type === "settle" || line.type === "release") open.delete(attemptId);
    mostChat = Math.max(mostChat, chat.size);
    mostClip = Math.max(mostClip, clip.size);
    if (chat.size > 0 && clip.size > 0) together = true;
  }
  return { chat: mostChat, clip: mostClip, together };
}

const CHAT_TEXTS = [GOOD_TEXTS[0], GOOD_TEXTS[1], GOOD_TEXTS[2], GOOD_TEXTS[3]] as const;

/** What the model answers to the nth chat attempt: mostly a good answer for the call asking, now and then something that ends it. */
function chatFor(draws: readonly number[]): ChatHandler {
  return (request) => {
    const draw = draws[(request.n - 1) % draws.length] ?? 0;
    if (draw < 0.15) return MODERATED;
    if (draw < 0.3) return chatReply("I cannot see the photo", 0.002);
    if (draw < 0.4) return { status: 502, body: { error: { message: "bad gateway" } } };
    const schema = request.json().response_format?.json_schema?.name;
    const text = CHAT_TEXTS[request.n % CHAT_TEXTS.length] ?? GOOD_TEXTS[0];
    return schema === "motion_idea"
      ? chatReply({ text_en: text, refusal: "none" }, 0.001)
      : chatReply({ motions: [{ label_ru: "Движение", text_en: text }], frame: { capture: "unknown", phoneVisible: false, faceVisible: true } }, 0.0034);
  };
}

/**
 * A clip's script for this property: it ends inside its own money window (a clean render, a free refusal, a 429 that is waited out). An uncertain stop (a 502 on the submit) is left out ON PURPOSE: its reserve
 * stays open after the clip's job has ended, waiting for the reconcile, and the guard is about the clip's proof window, which is over then; the batch property above already covers the uncertain stop.
 */
function endingClipScript(draw: number): VideoScript | undefined {
  if (draw < 0.6) return undefined;
  if (draw < 0.8) return { terminal: { status: "failed", error: RISK_CONTROL } };
  return { submit: { status: 429, body: { error: { code: 429, message: "Rate limit exceeded" } } } };
}

const seenC = new Set<string>();

describe("part C calls beside single clips on every path (fixed seeds)", () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    test(`seed ${seed}: a chat reserve and a clip reserve are never open together, and the paid count ends at 0`, async () => {
      const rand = seeded(seed * 104729);
      const chatDraws = Array.from({ length: 10 }, () => rand());
      const clipDraws = Array.from({ length: 6 }, () => rand());
      const net = motionNetwork({ chat: chatFor(chatDraws), clip: { klingBy: (n) => endingClipScript(clipDraws[(n - 1) % clipDraws.length] ?? 1) } });
      const w = await motionWorld(dir(), { net, engine: { monthlyBudgetMicros: BUDGET } });
      const { avatarId, photoId } = w;
      const ops = Array.from({ length: 6 }, () => rand());

      const run = async (draw: number): Promise<string> => {
        const kind = draw < 0.34 ? "suggest" : draw < 0.67 ? "translate" : "clip";
        const answer =
          kind === "suggest" ? await w.suggest(1_000_000) : kind === "translate" ? await w.translate(IDEA, 1_000_000) : await create(w.started, { avatarId, photoId, acceptedWorstMicros: 850_000 });
        if (answer.ok) return `${kind}:ok`;
        const reason = answer.error.clipReason ?? answer.error.code;
        seenC.add(reason);
        return `${kind}:${reason}`;
      };
      // Random groups of one to three, started together: the second meets the first.
      for (let i = 0; i < ops.length; ) {
        const size = 1 + Math.floor((ops[i] ?? 0) * 3);
        const group = ops.slice(i, i + size);
        i += size;
        await Promise.all(group.map((draw) => run(draw)));
        await settled(w.started);
      }

      const lines = ledgerLines(dir());
      const open = openByKind(lines);
      expect(open.together).toBe(false);
      expect(open.chat).toBeLessThanOrEqual(1);
      expect(open.clip).toBeLessThanOrEqual(1);
      expect(mostOpenClipReserves(lines.filter((line) => !isChatAttempt(String(line.attemptId))))).toBeLessThanOrEqual(1);
      // paidStart and paidEnd balance: every part C call counted itself in and out, whether it was paid, refused, failed or stopped.
      expect(w.started.engine.paidCommandsOpen()).toBe(0);
      expect(w.started.engine.budget?.status().heldMicros).toBe(0);
      // The guard is free again: the next part C call is refused for no busy reason.
      const next = await w.suggest(1_000_000);
      if (!next.ok) expect(["motion-busy", "clip-busy", "suggest-busy", "idea-busy", "one-at-a-time", "batch-running"]).not.toContain(next.error.clipReason ?? "");
      await settled(w.started);
      expect(w.started.engine.paidCommandsOpen()).toBe(0);
      for (const line of lines) if (isChatAttempt(String(line.attemptId)) && line.type === "reserve") seenC.add("chat");
      if (lines.some((line) => !isChatAttempt(String(line.attemptId)) && line.type === "reserve")) seenC.add("clip");
    });
  }

  test("the seeds took the paths that matter: a chat call, a clip, and both ways of the guard", () => {
    for (const path of ["chat", "clip", "motion-busy", "clip-busy"]) expect(seenC.has(path)).toBe(true);
  });
});
