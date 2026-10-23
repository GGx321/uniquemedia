import { describe, expect, test } from "bun:test";
import { ManualScheduler } from "./scheduler";
import { MockEngine, mockEngineClient } from "./mockEngine";
import { MIA, SOFIA, scenePhoto } from "./mockEngine.testkit";
import { makeBatchMock, phasesOf, startBatch, stepUntil } from "./mockEngine.clipBatch.testkit";
import { AVATAR, GOOD_TEXTS, IDEA, PLAIN, create, endOf, errorOf, flush, idea, makeClipMock, money, suggest, suggestion, translate, unwrap } from "./mockEngine.clipMotions.testkit";
import { CLIP_PHOTOS } from "./mockEngine.clips.testkit";

// Stage 5, 5b.2, S5.WC4 (plan s5b2 §5.3, I5.68; review r2.1 N10): the guard between the clip money and the part C calls, BOTH ways and global, in the mock, as in the engine (engine.clipMotions.guard.test.ts,
// engine.clipMotions.batchGuard.test.ts). The unit is the ONE predicate behind both directions; a batch holds it for its whole life, the gaps between members included.

const batchPayload = (photoId = PLAIN) => ({ avatarId: AVATAR, items: [{ photoId, motionId: "g-blink" }], quality: "std" as const, seconds: 5 as const, fallback: "auto" as const, acceptedWorstMicros: 850_000 });

/** A mock with a second avatar, Sofia, who has one ordinary photo. */
function twoAvatars() {
  const scheduler = new ManualScheduler();
  const sofiaPhoto = scenePhoto(1, { qa: { faceCos: 0.86 } }, SOFIA);
  const engine = new MockEngine({
    scheduler,
    avatars: [
      { ...MIA, photoCount: 1, eligibleUnusedCount: 1 },
      { ...SOFIA, photoCount: 1, eligibleUnusedCount: 1 },
    ],
    photos: [CLIP_PHOTOS.plain, sofiaPhoto],
  });
  return { scheduler, engine, client: mockEngineClient(engine), sofia: { avatarId: SOFIA.avatarId, photoId: sofiaPhoto.photoId } };
}

describe("a part C call waits for the clip money: IN_FLIGHT `clip-busy`", () => {
  test("while a single clip holds the unit, suggestMotions and translateIdea answer it, and nothing is reserved", async () => {
    const m = makeClipMock();
    await unwrap(create(m));
    for (const answer of [suggest(m), translate(m)]) expect(await errorOf(answer)).toMatchObject({ code: "IN_FLIGHT", clipReason: "clip-busy" });
    expect(m.engine.peekMotions().lines).toEqual([]);
    expect(m.engine.peekMotions().running).toBe(0);
  });

  test("while a batch holds the unit, the same", async () => {
    const m = makeBatchMock(2);
    await startBatch(m, m.photoIds.slice(0, 2));
    expect(await errorOf(m.client.request("clips.suggestMotions", { avatarId: AVATAR, photoId: m.photoIds[0] ?? "", acceptedWorstMicros: 1_000_000 }))).toMatchObject({ code: "IN_FLIGHT", clipReason: "clip-busy" });
    expect(await errorOf(m.client.request("clips.translateIdea", { avatarId: AVATAR, photoId: m.photoIds[0] ?? "", text: IDEA, acceptedWorstMicros: 1_000_000 }))).toMatchObject({ clipReason: "clip-busy" });
  });

  test("a batch holds it through the GAP between two members: the first has closed its money and the second has not yet reserved", async () => {
    const m = makeBatchMock(2);
    const { jobIds } = await startBatch(m, m.photoIds.slice(0, 2));
    // The second member's turn has come (`preparing`: its photo is read again) and it has not reserved yet; the first member's money is closed.
    stepUntil(m, () => phasesOf(m.events, jobIds[1] ?? "").includes("preparing") && !phasesOf(m.events, jobIds[1] ?? "").includes("submitting"), "the second member's turn");
    expect(m.engine.peekClips().attempts.filter((a) => a.state === "open")).toEqual([]);
    expect(m.engine.peekClips().unit).toBe("batch");
    expect(await errorOf(m.client.request("clips.suggestMotions", { avatarId: AVATAR, photoId: m.photoIds[0] ?? "", acceptedWorstMicros: 1_000_000 }))).toMatchObject({ code: "IN_FLIGHT", clipReason: "clip-busy" });
  });

  test("any avatar's clip holds it", async () => {
    const m = twoAvatars();
    await unwrap(m.client.request("clips.create", { avatarId: m.sofia.avatarId, photoId: m.sofia.photoId, motionId: "g-blink", model: "kling", quality: "std", seconds: 5, fallback: "auto", acceptedWorstMicros: 850_000 }));
    expect(await errorOf(m.client.request("clips.suggestMotions", { avatarId: AVATAR, photoId: PLAIN, acceptedWorstMicros: 1_000_000 }))).toMatchObject({ clipReason: "clip-busy" });
  });

  test("once the clip's money is closed and the batch is over the call goes through", async () => {
    const m = makeBatchMock(1);
    const { jobIds } = await startBatch(m, m.photoIds.slice(0, 1));
    stepUntil(m, () => endOf(m.events, jobIds[0] ?? "") !== undefined, "the member's end");
    stepUntil(m, () => m.engine.peekClips().unit === null, "the unit to go back");
    expect(await unwrap(m.client.request("clips.suggestMotions", { avatarId: AVATAR, photoId: m.photoIds[0] ?? "", acceptedWorstMicros: 1_000_000 }))).toMatchObject({ outcome: "ok" });
  });
});

describe("a clip waits for any part C call: IN_FLIGHT `motion-busy`, global", () => {
  async function runningCall(kind: "suggest" | "translate") {
    const m = makeClipMock();
    m.engine.holdMotionCalls(true);
    m.engine.scriptNextMotionReplies([kind === "suggest" ? suggestion(GOOD_TEXTS.slice(0, 1)) : idea(GOOD_TEXTS[1])]);
    const running = kind === "suggest" ? suggest(m) : translate(m);
    await flush();
    expect(m.engine.peekMotions()).toMatchObject({ running: 1, waiting: 1 });
    return { m, running };
  }

  test.each(["suggest", "translate"] as const)("while a %s runs, clips.create answers it: no job, no reserve, no unit", async (kind) => {
    const { m, running } = await runningCall(kind);
    const linesBefore = m.engine.peekMotions().lines.length;
    expect(await errorOf(create(m))).toMatchObject({ code: "IN_FLIGHT", clipReason: "motion-busy" });
    expect(m.engine.peekMotions().lines).toHaveLength(linesBefore);
    expect(m.engine.peekClips().attempts).toEqual([]);
    expect(m.engine.peekClips().unit).toBeNull();
    m.engine.holdMotionCalls(false);
    expect(await running).toMatchObject({ ok: true, result: { outcome: "ok" } });
  });

  test("while a call runs, clips.createBatch answers it too", async () => {
    const { m, running } = await runningCall("suggest");
    expect(await errorOf(m.client.request("clips.createBatch", { ...batchPayload(), items: [{ photoId: PLAIN, motionId: "g-blink" }] }))).toMatchObject({ code: "IN_FLIGHT", clipReason: "motion-busy" });
    m.engine.holdMotionCalls(false);
    await running;
  });

  test("any avatar: a call on one avatar's photo refuses a clip of another avatar", async () => {
    const m = twoAvatars();
    m.engine.holdMotionCalls(true);
    const running = m.client.request("clips.suggestMotions", { avatarId: AVATAR, photoId: PLAIN, acceptedWorstMicros: 1_000_000 });
    await flush();
    expect(await errorOf(m.client.request("clips.create", { avatarId: m.sofia.avatarId, photoId: m.sofia.photoId, motionId: "g-blink", model: "kling", quality: "std", seconds: 5, fallback: "auto", acceptedWorstMicros: 850_000 }))).toMatchObject({
      clipReason: "motion-busy",
    });
    m.engine.holdMotionCalls(false);
    await running;
  });

  test("the answer is the first rule a clip meets: before the key, the library and the photo", async () => {
    const { m, running } = await runningCall("suggest");
    expect((await errorOf(m.client.request("clips.create", { avatarId: "avatar-nope-0001", photoId: "photo-nope-0001", motionId: "g-blink", model: "kling", quality: "std", seconds: 5, fallback: "auto", acceptedWorstMicros: 850_000 }))).clipReason).toBe("motion-busy");
    m.engine.holdMotionCalls(false);
    await running;
  });

  test("a call that ended leaves nothing behind: the clip goes through", async () => {
    const { m, running } = await runningCall("suggest");
    m.engine.holdMotionCalls(false);
    await running;
    expect(m.engine.peekMotions().running).toBe(0);
    expect(await unwrap(create(m))).toHaveProperty("jobId");
  });

  test("a call that was REFUSED (a price change) leaves nothing behind either", async () => {
    const m = makeClipMock();
    expect((await errorOf(suggest(m, PLAIN, 1))).code).toBe("PRICE_CHANGED");
    expect(await unwrap(create(m))).toHaveProperty("jobId");
  });

  test("a call that failed (a 401, a timeout) leaves nothing behind either", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([{ kind: "http", status: 401 }]);
    expect((await errorOf(suggest(m))).code).toBe("AUTH_INVALID");
    expect(m.engine.peekMotions().running).toBe(0);
  });
});

describe("one call per photo and kind", () => {
  test("a second suggestMotions for the same photo answers `suggest-busy`, free; the first goes on and finishes", async () => {
    const m = makeClipMock();
    m.engine.holdMotionCalls(true);
    m.engine.scriptNextMotionReplies([suggestion(GOOD_TEXTS.slice(0, 1))]);
    const first = suggest(m);
    await flush();
    expect(await errorOf(suggest(m))).toMatchObject({ code: "IN_FLIGHT", clipReason: "suggest-busy" });
    expect(m.engine.peekMotions().lines).toHaveLength(1);
    m.engine.holdMotionCalls(false);
    expect(await unwrap(first)).toMatchObject({ outcome: "ok" });
    expect(await unwrap(suggest(m))).toMatchObject({ outcome: "ok" });
  });

  test("a second translateIdea for the same photo answers `idea-busy`", async () => {
    const m = makeClipMock();
    m.engine.holdMotionCalls(true);
    m.engine.scriptNextMotionReplies([idea(GOOD_TEXTS[1])]);
    const first = translate(m);
    await flush();
    expect(await errorOf(translate(m))).toMatchObject({ code: "IN_FLIGHT", clipReason: "idea-busy" });
    m.engine.holdMotionCalls(false);
    expect(await unwrap(first)).toMatchObject({ outcome: "ok" });
  });

  test("a suggestion and an idea for the same photo may run together", async () => {
    const m = makeClipMock();
    m.engine.holdMotionCalls(true);
    m.engine.scriptNextMotionReplies([suggestion(GOOD_TEXTS.slice(0, 1)), idea(GOOD_TEXTS[1])]);
    const a = suggest(m);
    const b = translate(m);
    await flush();
    expect(m.engine.peekMotions()).toMatchObject({ running: 2, waiting: 2 });
    m.engine.holdMotionCalls(false);
    expect(await unwrap(a)).toMatchObject({ outcome: "ok" });
    expect(await unwrap(b)).toMatchObject({ outcome: "ok" });
  });

  test("two photos of two avatars may be suggested together", async () => {
    const m = twoAvatars();
    m.engine.holdMotionCalls(true);
    const a = m.client.request("clips.suggestMotions", { avatarId: AVATAR, photoId: PLAIN, acceptedWorstMicros: 1_000_000 });
    const b = m.client.request("clips.suggestMotions", { avatarId: m.sofia.avatarId, photoId: m.sofia.photoId, acceptedWorstMicros: 1_000_000 });
    await flush();
    expect(m.engine.peekMotions().running).toBe(2);
    m.engine.holdMotionCalls(false);
    expect(await unwrap(a)).toMatchObject({ outcome: "ok" });
    expect(await unwrap(b)).toMatchObject({ outcome: "ok" });
  });
});

describe("what a running call holds", () => {
  test("an avatar delete waits for the avatar's running call, and goes through once it ends", async () => {
    const m = makeClipMock();
    m.engine.holdMotionCalls(true);
    const running = suggest(m);
    await flush();
    expect(await errorOf(m.client.request("avatars.deletePreview", { avatarId: AVATAR }))).toMatchObject({ code: "IN_FLIGHT", detail: "a motion suggestion or an idea translation of this avatar is running; delete the avatar when it ends" });
    m.engine.holdMotionCalls(false);
    await running;
    expect(await unwrap(m.client.request("avatars.deletePreview", { avatarId: AVATAR }))).toBeDefined();
  });

  test("another avatar's call does not stop this avatar's delete", async () => {
    const m = twoAvatars();
    m.engine.holdMotionCalls(true);
    const running = m.client.request("clips.suggestMotions", { avatarId: m.sofia.avatarId, photoId: m.sofia.photoId, acceptedWorstMicros: 1_000_000 });
    await flush();
    expect(await unwrap(m.client.request("avatars.deletePreview", { avatarId: AVATAR }))).toBeDefined();
    m.engine.holdMotionCalls(false);
    await running;
  });

  test("a library switch and a reconcile wait for the call from its first step", async () => {
    const m = makeClipMock();
    m.engine.holdMotionCalls(true);
    const running = suggest(m);
    await flush();
    expect(await errorOf(m.client.request("settings.setLibraryPath", { path: "/elsewhere" }))).toMatchObject({ code: "IN_FLIGHT" });
    expect(await errorOf(m.client.request("money.reconcile", {}))).toMatchObject({ code: "IN_FLIGHT" });
    m.engine.holdMotionCalls(false);
    await running;
  });

  test("the avatar itself is not claimed: archiving it goes on while the call runs", async () => {
    const m = makeClipMock();
    m.engine.holdMotionCalls(true);
    const running = suggest(m);
    await flush();
    expect((await m.client.request("avatars.archive", { avatarId: AVATAR })).ok).toBe(true);
    m.engine.holdMotionCalls(false);
    await running;
  });

  test("a restart with a call at the model forgets the call: nothing is counted, its reserve is the earlier process's and waits for the reconcile, and a clip is refused for it", async () => {
    const m = makeClipMock();
    m.engine.holdMotionCalls(true);
    const running = suggest(m);
    await flush();
    m.engine.restart();
    // The process that asked is gone: its answer never comes (the mock ends the stale request with an error), and nothing it counted is left.
    expect(await running).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    expect(m.engine.peekMotions()).toMatchObject({ running: 0, caps: [] });
    expect(await money(m)).toMatchObject({ reconcileNeeded: true, unsettledMicros: 16_149, unsettledCount: 1 });
    expect((await errorOf(create(m))).code).toBe("RECONCILE_REQUIRED");
    expect((await errorOf(suggest(m))).code).toBe("RECONCILE_REQUIRED");
  });

  test("the call's cap is live while it runs and gone when it ends", async () => {
    const m = makeClipMock();
    m.engine.holdMotionCalls(true);
    const running = suggest(m);
    await flush();
    expect(m.engine.peekMotions().caps).toEqual([{ capMicros: 33_786, committedMicros: 16_149 }]);
    m.engine.holdMotionCalls(false);
    await running;
    expect(m.engine.peekMotions().caps).toEqual([]);
  });
});
