import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { EngineReply } from "./control";
import { openLibrary } from "./library";
import { sequentialIds, steppingClock } from "./library/testing/helpers";
import { create, createCommand, jobEnd, jobIdOf, phasesOf, until, type ClipEngine } from "./clips/testing/engineClipKit";
import { chatReply, errorOf, gate, motionNetwork, resultOf, send, type ChatRequest } from "./clips/testing/motionNet";
import { GOOD_TEXTS, ideaReply, motionWorld, suggestionReply, type MotionWorld } from "./clips/testing/motionWorld";
import { JPEG } from "./openrouter/testing/fakes";
import { useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();
setDefaultTimeout(60_000);

// Stage 5, 5b.2, S5.WC3 (plan s5b2 §5.3, I5.68; review r2.1 N10): the guard between the clip money and the part C chat calls, both ways, in the engine; one call per photo and kind; and what a running call
// holds (an avatar delete, a library switch) and does not (the avatar itself).

const dir = useEngineDir("studio-engine-clip-motions-guard-");

/** The right answer for whichever call asks, held until `open()`. */
function heldChat() {
  const door = gate();
  const chat = async (request: ChatRequest) => {
    await door.promise;
    return request.json().response_format?.json_schema?.name === "motion_idea" ? ideaReply(GOOD_TEXTS[1] ?? "") : suggestionReply([GOOD_TEXTS[0] ?? ""]);
  };
  return { chat, open: door.open };
}

async function reply(engine: ClipEngine, call: unknown) {
  await engine.engine.receive(call);
  return EngineReply.parse(engine.posted.at(-1));
}

/** A clip held in `rendering`: its money is open until `net.release("kling")`. */
async function heldClip(w: MotionWorld, avatarId = w.avatarId, photoId = w.photoId): Promise<string> {
  const jobId = jobIdOf(await create(w.started, { avatarId, photoId }));
  await until(() => phasesOf(w.started, jobId).includes("rendering"), "rendering");
  return jobId;
}

const batchPayload = (w: MotionWorld) => ({ avatarId: w.avatarId, items: [{ photoId: w.photoId, motionId: "g-blink" }], quality: "std", seconds: 5, fallback: "auto", acceptedWorstMicros: 850_000 });

describe("a part C call waits for the clip money: IN_FLIGHT `clip-busy`", () => {
  test("while a single clip holds the unit, suggestMotions and translateIdea answer it, and no chat line is sent", async () => {
    const net = motionNetwork({ clip: { kling: { held: true } }, chat: () => suggestionReply([GOOD_TEXTS[0] ?? ""]) });
    const w = await motionWorld(dir(), { net });
    const jobId = await heldClip(w);
    for (const answer of [await w.suggest(1_000_000), await w.translate(undefined, 1_000_000)]) expect(errorOf(answer)).toMatchObject({ code: "IN_FLIGHT", clipReason: "clip-busy" });
    expect(net.chats).toHaveLength(0);
    net.release("kling");
    await jobEnd(w.started, jobId);
  });

  test("while a batch holds the unit, the same", async () => {
    const net = motionNetwork({ clip: { kling: { held: true } }, chat: () => suggestionReply([GOOD_TEXTS[0] ?? ""]) });
    const w = await motionWorld(dir(), { net });
    const made = resultOf(await send(w.started, "clips.createBatch", batchPayload(w))) as { jobIds: string[] };
    await until(() => phasesOf(w.started, made.jobIds[0] ?? "").includes("rendering"), "rendering");
    expect(errorOf(await w.suggest(1_000_000))).toMatchObject({ code: "IN_FLIGHT", clipReason: "clip-busy" });
    expect(errorOf(await w.translate(undefined, 1_000_000))).toMatchObject({ code: "IN_FLIGHT", clipReason: "clip-busy" });
    expect(net.chats).toHaveLength(0);
    net.release("kling");
    await jobEnd(w.started, made.jobIds[0] ?? "");
  });

  test("any avatar's clip holds it: a clip of another avatar refuses this avatar's call", async () => {
    const net = motionNetwork({ clip: { kling: { held: true } } });
    const w = await motionWorld(dir(), { net, second: true });
    const other = w.other;
    if (other === undefined) throw new Error("no second avatar");
    const jobId = await heldClip(w, other.avatarId, other.photoId);
    expect(errorOf(await w.suggest(1_000_000)).clipReason).toBe("clip-busy");
    net.release("kling");
    await jobEnd(w.started, jobId);
  });

  test("once the clip's money is closed the call goes through", async () => {
    const net = motionNetwork({ clip: { kling: { held: true } }, chat: () => suggestionReply([GOOD_TEXTS[0] ?? ""]) });
    const w = await motionWorld(dir(), { net });
    const jobId = await heldClip(w);
    net.release("kling");
    await jobEnd(w.started, jobId);
    expect(resultOf(await w.suggest())).toMatchObject({ outcome: "ok" });
  });
});

describe("a clip waits for any part C call: IN_FLIGHT `motion-busy`, global", () => {
  async function runningCall(kind: "suggest" | "translate") {
    const held = heldChat();
    const w = await motionWorld(dir(), { chat: held.chat, second: true });
    const running = kind === "suggest" ? w.suggest() : w.translate();
    await until(() => w.net.chats.length === 1, "the chat request");
    return { w, held, running };
  }

  test.each(["suggest", "translate"] as const)("while a %s runs, clips.create answers it: no job, no reserve, no baseline read, no video request", async (kind) => {
    const { w, held, running } = await runningCall(kind);
    const callsBefore = w.net.calls.length;
    const ledgerBefore = w.ledger().length;
    expect(errorOf(await create(w.started, { avatarId: w.avatarId, photoId: w.photoId }))).toMatchObject({ code: "IN_FLIGHT", clipReason: "motion-busy" });
    expect(w.ledger()).toHaveLength(ledgerBefore);
    expect(w.net.calls.slice(callsBefore)).toEqual([]);
    held.open();
    expect(resultOf(await running)).toMatchObject({ outcome: "ok" });
  });

  test("while a call runs, clips.createBatch answers it too", async () => {
    const { w, held, running } = await runningCall("suggest");
    expect(errorOf(await send(w.started, "clips.createBatch", batchPayload(w)))).toMatchObject({ code: "IN_FLIGHT", clipReason: "motion-busy" });
    held.open();
    await running;
  });

  test("any avatar: a call on one avatar's photo refuses a clip of another avatar", async () => {
    const { w, held, running } = await runningCall("suggest");
    const other = w.other;
    if (other === undefined) throw new Error("no second avatar");
    expect(errorOf(await create(w.started, { avatarId: other.avatarId, photoId: other.photoId }))).toMatchObject({ code: "IN_FLIGHT", clipReason: "motion-busy" });
    held.open();
    await running;
  });

  test("the answer is the first rule a clip meets: before the key, the library and the photo", async () => {
    const { w, held, running } = await runningCall("suggest");
    expect(errorOf(await create(w.started, { avatarId: "avatar-nope-0001", photoId: "photo-nope-0001" })).clipReason).toBe("motion-busy");
    held.open();
    await running;
  });

  test("a call that ended leaves nothing behind: the clip goes through", async () => {
    const { w, held, running } = await runningCall("suggest");
    held.open();
    await running;
    const jobId = jobIdOf(await create(w.started, { avatarId: w.avatarId, photoId: w.photoId }));
    expect((await jobEnd(w.started, jobId)).type).toBe("job.done");
  });

  test("a call that was REFUSED (a price change) leaves nothing behind either", async () => {
    const w = await motionWorld(dir());
    expect(errorOf(await w.suggest(1)).code).toBe("PRICE_CHANGED");
    const jobId = jobIdOf(await create(w.started, { avatarId: w.avatarId, photoId: w.photoId }));
    expect((await jobEnd(w.started, jobId)).type).toBe("job.done");
  });

  test("a call that failed (a 401) leaves nothing behind either", async () => {
    const w = await motionWorld(dir(), { chat: () => ({ status: 401, body: { error: { message: "no auth" } } }) });
    expect(errorOf(await w.suggest()).code).toBe("AUTH_INVALID");
    expect(w.net.chats).toHaveLength(1);
  });
});

describe("one call per photo and kind", () => {
  test("a second suggestMotions for the same photo answers `suggest-busy`, free; the first goes on and finishes", async () => {
    const held = heldChat();
    const w = await motionWorld(dir(), { chat: held.chat });
    const first = w.suggest();
    await until(() => w.net.chats.length === 1, "the chat request");
    expect(errorOf(await w.suggest(1_000_000))).toMatchObject({ code: "IN_FLIGHT", clipReason: "suggest-busy" });
    expect(w.net.chats).toHaveLength(1);
    held.open();
    expect(resultOf(await first)).toMatchObject({ outcome: "ok" });
    expect(resultOf(await w.suggest())).toMatchObject({ outcome: "ok" });
  });

  test("a second translateIdea for the same photo answers `idea-busy`", async () => {
    const held = heldChat();
    const w = await motionWorld(dir(), { chat: held.chat });
    const first = w.translate();
    await until(() => w.net.chats.length === 1, "the chat request");
    expect(errorOf(await w.translate(undefined, 1_000_000))).toMatchObject({ code: "IN_FLIGHT", clipReason: "idea-busy" });
    held.open();
    expect(resultOf(await first)).toMatchObject({ outcome: "ok" });
  });

  test("a suggestion and an idea for the same photo may run together", async () => {
    const held = heldChat();
    const w = await motionWorld(dir(), { chat: held.chat });
    const suggestion = w.suggest();
    const idea = w.translate();
    await until(() => w.net.chats.length === 2, "both chat requests");
    held.open();
    expect(resultOf(await suggestion)).toMatchObject({ outcome: "ok" });
    expect(resultOf(await idea)).toMatchObject({ outcome: "ok" });
  });

  test("two photos of two avatars may be suggested together", async () => {
    const held = heldChat();
    const w = await motionWorld(dir(), { chat: held.chat, second: true });
    const other = w.other;
    if (other === undefined) throw new Error("no second avatar");
    const first = w.suggest();
    const second = send(w.started, "clips.suggestMotions", { avatarId: other.avatarId, photoId: other.photoId, acceptedWorstMicros: 1_000_000 });
    await until(() => w.net.chats.length === 2, "both chat requests");
    held.open();
    expect(resultOf(await first)).toMatchObject({ outcome: "ok" });
    expect(resultOf(await second)).toMatchObject({ outcome: "ok" });
  });
});

describe("what a running call holds", () => {
  test("an avatar delete waits for the avatar's running call, and goes through once it ends", async () => {
    const held = heldChat();
    const w = await motionWorld(dir(), { chat: held.chat });
    const running = w.suggest();
    await until(() => w.net.chats.length === 1, "the chat request");
    const prepare = { kind: "control", type: "avatar.deletePrepare", callId: "call-00000001", avatarId: w.avatarId, token: "token-00000001" };
    const refused = await reply(w.started, prepare);
    expect(refused.error?.code).toBe("IN_FLIGHT");
    expect(refused.error?.detail).toContain("motion");
    held.open();
    await running;
    expect((await reply(w.started, { ...prepare, callId: "call-00000003" })).error).toBeUndefined();
  });

  test("another avatar's call does not stop this avatar's delete", async () => {
    const held = heldChat();
    const w = await motionWorld(dir(), { chat: held.chat, second: true });
    const other = w.other;
    if (other === undefined) throw new Error("no second avatar");
    const running = send(w.started, "clips.suggestMotions", { avatarId: other.avatarId, photoId: other.photoId, acceptedWorstMicros: 1_000_000 });
    await until(() => w.net.chats.length === 1, "the chat request");
    const answer = await reply(w.started, { kind: "control", type: "avatar.deletePrepare", callId: "call-00000001", avatarId: w.avatarId, token: "token-00000001" });
    expect(answer.error).toBeUndefined();
    await reply(w.started, { kind: "control", type: "avatar.deleteFinish", callId: "call-00000002", avatarId: w.avatarId, token: "token-00000001", outcome: "kept" });
    held.open();
    await running;
  });

  test("a library switch waits for the call from its first step, before any reserve is open: it is a paid command", async () => {
    const other = join(dir(), "other");
    await mkdir(other, { recursive: true });
    await openLibrary(other, { now: steppingClock(), newId: sequentialIds("other") });
    // The call is held in the photo's downscale, before its chat reserve: only the paid count can refuse the switch then.
    const door = gate();
    let entered = false;
    const w = await motionWorld(dir(), {
      chat: () => suggestionReply([GOOD_TEXTS[0] ?? ""]),
      engine: {
        deps: {
          clipDownscale: async () => {
            entered = true;
            await door.promise;
            return JPEG;
          },
        },
      },
    });
    const running = w.suggest();
    await until(() => entered, "the downscale");
    expect(w.net.chats).toHaveLength(0);
    const answer = await reply(w.started, { kind: "control", type: "library.open", callId: "call-00000009", path: other });
    expect(answer.error?.code).toBe("IN_FLIGHT");
    expect(w.started.engine.library?.root).toBe(w.libraryDir);
    door.open();
    expect(resultOf(await running)).toMatchObject({ outcome: "ok" });
  });

  test("the avatar itself is not claimed: an edit that claims it goes on while the call runs", async () => {
    const held = heldChat();
    const w = await motionWorld(dir(), { chat: held.chat });
    const running = w.suggest();
    await until(() => w.net.chats.length === 1, "the chat request");
    const archived = await w.started.engine.handle({ v: 5, id: "cmd-archive-0001", kind: "command", type: "avatars.archive", payload: { avatarId: w.avatarId } });
    expect(archived.ok).toBe(true);
    held.open();
    await running;
  });
});

describe("the key", () => {
  test("a 401 on the call marks the key rejected, as everywhere", async () => {
    const w = await motionWorld(dir(), { chat: () => ({ status: 401, body: { error: { message: "no auth" } } }) });
    await w.suggest();
    expect(errorOf(await w.suggest(1_000_000)).code).toBe("AUTH_INVALID");
    expect(w.net.chats).toHaveLength(1);
  });
});

void chatReply;
void createCommand;
