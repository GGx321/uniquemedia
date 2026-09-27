import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Estimate } from "../shared/engine";
import { manifestTraits } from "./avatars/records";
import { openLibrary } from "./library";
import { PNG_1X1, samplePhotoMeta } from "./library/testing/helpers";
import {
  command,
  descriptorReply,
  engineSettings,
  failed,
  GOOD,
  IMAGE_WORST,
  jobEnd,
  jobIdOf,
  network,
  ok,
  seedDraft,
  startEngine,
  TRAITS,
  until,
  useEngineDir,
} from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Owner's decision (2026-09-27): the paid image age check is optional, off by
// default. This file pins the money and behaviour of that toggle at the
// engine level; the age-check-on path itself stays pinned by the rest of the
// suite (engine.avatars.test.ts, engine.candidates.test.ts, candidateJob.test.ts),
// whose harness default is deliberately "on" for that reason.

const dir = useEngineDir("studio-engine-imageAgeCheck-");

/** The dated fallback table's prices with the toggle off: 4 portraits, no descriptor, no age checks. */
const NEXT_BATCH_OFF: Estimate = { expectedMicros: 160_000, worstMicros: 160_000, prices: "fallback", pricesAsOf: "2026-09-24" };
/** The same, for a whole new avatar: the descriptor plus 4 portraits, no age checks. */
const NEW_AVATAR_OFF: Estimate = { expectedMicros: 162_625, worstMicros: 187_500, prices: "fallback", pricesAsOf: "2026-09-24" };
/** The same next-batch price, on: 4 portraits and their age checks (plan.test.ts's own NEXT_BATCH). */
const NEXT_BATCH_ON: Estimate = { expectedMicros: 166_640, worstMicros: 181_000, prices: "fallback", pricesAsOf: "2026-09-24" };

function initOff(overrides: Parameters<typeof engineSettings>[1] = {}) {
  return { settings: engineSettings(dir(), { imageAgeCheck: "off", ...overrides }) };
}

function generateCandidates(avatarId: string, acceptedWorstMicros: number): unknown {
  return command("avatars.generateCandidates", { avatarId, acceptedWorstMicros });
}

function settingsUpdate(overrides: Parameters<typeof engineSettings>[1]): { kind: "control"; type: "settings.update"; settings: ReturnType<typeof engineSettings> } {
  return { kind: "control", type: "settings.update", settings: engineSettings(dir(), overrides) };
}

describe("settings.imageAgeCheck default and reporting", () => {
  test("the app's own default is off (settingsStore.ts); the engine reports whatever settings.json named", async () => {
    const { engine } = await startEngine(dir(), { init: initOff() });
    const response = ok(await engine.handle(command("settings.get")));
    if (response.type !== "settings.get") throw new Error("wrong type");
    expect(response.result.imageAgeCheck).toBe("off");
  });

  test("a settings.update control message changes it, reflected by settings.get and the snapshot", async () => {
    const { engine } = await startEngine(dir(), { init: initOff() });
    await engine.receive(settingsUpdate({ imageAgeCheck: "on" }));

    const response = ok(await engine.handle(command("settings.get")));
    if (response.type !== "settings.get") throw new Error("wrong type");
    expect(response.result.imageAgeCheck).toBe("on");

    const snapshot = ok(await engine.handle(command("engine.snapshot")));
    if (snapshot.type !== "engine.snapshot") throw new Error("wrong type");
    expect(snapshot.result.settings.imageAgeCheck).toBe("on");
  });
});

describe("estimates exclude the age check when the toggle is off", () => {
  test("avatars.estimate: $0.1875 worst, down from $0.2085 on", async () => {
    const { engine } = await startEngine(dir(), { init: initOff() });
    const response = ok(await engine.handle(command("avatars.estimate", { traits: TRAITS })));
    expect(response.result).toEqual(NEW_AVATAR_OFF);
  });

  test("avatars.estimateCandidates (another batch): $0.16 worst, down from $0.181 on", async () => {
    const { draftId } = await seedDraft(dir());
    const { engine } = await startEngine(dir(), { init: initOff() });
    const response = ok(await engine.handle(command("avatars.estimateCandidates", { avatarId: draftId })));
    expect(response.result).toEqual(NEXT_BATCH_OFF);
  });
});

describe("avatars.generateCandidates with the toggle off", () => {
  test("sends no age-check requests, stores 4 candidates with no qa.age, and money equals only the images' cost", async () => {
    const { draftId } = await seedDraft(dir());
    const { engine, events, net } = await startEngine(dir(), { init: initOff() });

    const jobId = jobIdOf(await engine.handle(generateCandidates(draftId, NEXT_BATCH_OFF.worstMicros)));
    const end = await jobEnd(events, jobId);

    expect(end).toMatchObject({ type: "job.done", payload: { jobId, result: { kind: "avatar.candidates", avatarId: draftId, rejectedByAgeCheck: 0, failedSlots: [] } } });
    expect(net.ageCalls()).toHaveLength(0);
    expect(net.imageCalls()).toHaveLength(4);

    const photos = engine.library?.photosByAvatar(draftId) ?? [];
    expect(photos).toHaveLength(4);
    expect(photos.every((p) => p.qa.age === undefined)).toBe(true);

    const money = ok(await engine.handle(command("money.status")));
    if (money.type !== "money.status" || money.result.ledger !== "open") throw new Error("expected an open ledger");
    expect(money.result.spentMicros).toBe(4 * IMAGE_WORST);
  });

  test("a draft's stored candidates (with no verdict) are all offered, and none is hidden", async () => {
    const { draftId } = await seedDraft(dir());
    const { engine, events } = await startEngine(dir(), { init: initOff() });
    await jobEnd(events, jobIdOf(await engine.handle(generateCandidates(draftId, NEXT_BATCH_OFF.worstMicros))));

    const snapshot = ok(await engine.handle(command("engine.snapshot")));
    if (snapshot.type !== "engine.snapshot") throw new Error("wrong type");
    const draft = snapshot.result.drafts.find((d) => d.avatarId === draftId);
    expect(draft?.candidates).toHaveLength(4);
    expect(draft?.hiddenBelowThreshold).toBe(0);
  });

  // MEDIUM (review): #nextBatchAtKnownPrices (engine.ts) must price the next
  // batch in the mode the engine is in NOW, not stay stuck on whatever mode
  // the last estimate happened to use.
  test("after a batch finishes, the snapshot's draft.estimate is the OFF next-batch price", async () => {
    const { draftId } = await seedDraft(dir());
    const { engine, events } = await startEngine(dir(), { init: initOff() });
    await jobEnd(events, jobIdOf(await engine.handle(generateCandidates(draftId, NEXT_BATCH_OFF.worstMicros))));

    const snapshot = ok(await engine.handle(command("engine.snapshot")));
    if (snapshot.type !== "engine.snapshot") throw new Error("wrong type");
    const draft = snapshot.result.drafts.find((d) => d.avatarId === draftId);
    expect(draft?.estimate).toEqual(NEXT_BATCH_OFF);
  });

  // MEDIUM (review, M8's own preflight): the preflight exists only to catch
  // a broken ffmpeg before it burns a whole batch of paid images that could
  // never pass the age check's downscale — with the check off, candidateJob.ts
  // never downscales at all, so a broken ffmpeg cannot affect this batch, and
  // the preflight must not even run (engine.ts's `#generateCandidates`).
  test("a throwing preflightDownscale does not stop the batch: the preflight is skipped entirely when the check is off", async () => {
    const { draftId } = await seedDraft(dir());
    const throwing = (): Promise<void> => Promise.reject(new Error("ffmpeg is broken"));
    const net = network();
    const { engine, events } = await startEngine(dir(), { init: initOff(), net, deps: { preflightDownscale: throwing } });

    const jobId = jobIdOf(await engine.handle(generateCandidates(draftId, NEXT_BATCH_OFF.worstMicros)));
    const end = await jobEnd(events, jobId);

    expect(end.type).toBe("job.done");
    expect(net.imageCalls()).toHaveLength(4);
  });
});

describe("a full new-avatar flow stays consistent in OFF mode end to end", () => {
  // MEDIUM (review): createDraft's own accepted-worst check, the draft's own
  // next-batch estimate, and generateCandidates' own accepted-worst check
  // must all agree on the OFF prices — not silently fall back to the ON ones
  // anywhere along the chain.
  test("createDraft accepted at the OFF worst case succeeds; the draft's own next-batch estimate is the OFF batch price; generateCandidates at that price succeeds", async () => {
    const net = network({ descriptors: [descriptorReply(GOOD)] });
    const { engine, events } = await startEngine(dir(), { init: initOff(), net });

    const estimate = ok(await engine.handle(command("avatars.estimate", { traits: TRAITS })));
    if (estimate.type !== "avatars.estimate") throw new Error("wrong type");
    expect(estimate.result.worstMicros).toBe(187_500);

    const created = ok(await engine.handle(command("avatars.createDraft", { traits: TRAITS, acceptedWorstMicros: estimate.result.worstMicros })));
    if (created.type !== "avatars.createDraft") throw new Error("wrong type");
    const { estimate: batchEstimate, avatarId } = created.result.draft;
    expect(batchEstimate).toEqual(NEXT_BATCH_OFF);
    if (batchEstimate === null) throw new Error("expected a priced draft");

    const jobId = jobIdOf(await engine.handle(generateCandidates(avatarId, batchEstimate.worstMicros)));
    const end = await jobEnd(events, jobId);
    expect(end.type).toBe("job.done");
    expect(net.ageCalls()).toHaveLength(0);
  });
});

describe("a candidate stored while the toggle was on, with a failing verdict, stays hidden after switching off", () => {
  test("draftFrom/the snapshot still hides it, and pick still refuses it", async () => {
    const { library } = await openLibrary(join(dir(), "library"));
    const draft = await library.createAvatar({ name: "Draft", age: TRAITS.age, traits: manifestTraits(TRAITS), descriptor: GOOD });
    const passing = await library.addPhoto(draft.id, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: true, confidence: 0.95 } } }));
    const failing = await library.addPhoto(draft.id, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: false, confidence: 0.9 } } }));

    const { engine } = await startEngine(dir(), { init: initOff() });
    const snapshot = ok(await engine.handle(command("engine.snapshot")));
    if (snapshot.type !== "engine.snapshot") throw new Error("wrong type");
    const found = snapshot.result.drafts.find((d) => d.avatarId === draft.id);
    expect(found?.candidates.map((c) => c.photoId).sort()).toEqual([passing.id].sort());
    expect(found?.hiddenBelowThreshold).toBe(1);

    const pickRefused = failed(await engine.handle(command("avatars.pick", { avatarId: draft.id, photoId: failing.id, name: "Mia" })));
    expect(pickRefused.error.code).toBe("NOT_FOUND");
  });
});

describe("a mid-flight toggle change: PRICE_CHANGED only on a rise; a drop just spends less", () => {
  test("estimated off, then switched on before the command: the lower accepted worst no longer matches — PRICE_CHANGED", async () => {
    const { draftId } = await seedDraft(dir());
    const { engine } = await startEngine(dir(), { init: initOff() });
    const estimate = ok(await engine.handle(command("avatars.estimateCandidates", { avatarId: draftId })));
    if (estimate.type !== "avatars.estimateCandidates") throw new Error("wrong type");
    expect(estimate.result.worstMicros).toBe(160_000);

    await engine.receive(settingsUpdate({ imageAgeCheck: "on" }));

    const refused = failed(await engine.handle(generateCandidates(draftId, estimate.result.worstMicros)));
    expect(refused.error.code).toBe("PRICE_CHANGED");
  });

  // Reviewer (HIGH): #checkAccepted only ever refuses a rise (T0's own
  // contract, errors.ts / commands.ts's AcceptedWorst) — never a drop, which
  // is routine (a fresh price load, the fallback table's TTL, or the toggle
  // turned off since the estimate) and simply means spending less than the
  // user agreed to, following the owner's latest choice.
  test("estimated on, then switched off before the command: the command proceeds at the new, lower worst case — no age check is sent", async () => {
    const { draftId } = await seedDraft(dir());
    const net = network();
    const { engine, events } = await startEngine(dir(), { net }); // harness default: on
    const estimate = ok(await engine.handle(command("avatars.estimateCandidates", { avatarId: draftId })));
    if (estimate.type !== "avatars.estimateCandidates") throw new Error("wrong type");
    expect(estimate.result.worstMicros).toBe(181_000);

    await engine.receive(settingsUpdate({ imageAgeCheck: "off" }));

    const jobId = jobIdOf(await engine.handle(generateCandidates(draftId, estimate.result.worstMicros)));
    const end = await jobEnd(events, jobId);

    expect(end.type).toBe("job.done");
    expect(net.ageCalls()).toHaveLength(0);
    expect(net.imageCalls()).toHaveLength(4);
  });
});

describe("a running job captures its mode at start: a mid-flight toggle change does not affect it", () => {
  test("a batch started with the check on keeps running its age checks even if the setting flips to off mid-flight", async () => {
    const { draftId } = await seedDraft(dir());
    const net = network();
    const { engine, events } = await startEngine(dir(), { init: { settings: engineSettings(dir(), { concurrency: { network: 1 } }) }, net });

    const jobId = jobIdOf(await engine.handle(generateCandidates(draftId, 181_000)));
    await until(() => net.imageCalls().length >= 1);
    await engine.receive(settingsUpdate({ imageAgeCheck: "off" }));

    await jobEnd(events, jobId);
    expect(net.ageCalls()).toHaveLength(4);
    const photos = engine.library?.photosByAvatar(draftId) ?? [];
    expect(photos.every((p) => p.qa.age?.adult === true)).toBe(true);
  });

  // LOW (review): the reverse direction of the test above.
  test("a batch started with the check off is unaffected by the setting flipping to on mid-flight: still no age checks", async () => {
    const { draftId } = await seedDraft(dir());
    const net = network();
    const { engine, events } = await startEngine(dir(), { init: { settings: engineSettings(dir(), { imageAgeCheck: "off", concurrency: { network: 1 } }) }, net });

    const jobId = jobIdOf(await engine.handle(generateCandidates(draftId, NEXT_BATCH_OFF.worstMicros)));
    await until(() => net.imageCalls().length >= 1);
    await engine.receive(settingsUpdate({ imageAgeCheck: "on" }));

    await jobEnd(events, jobId);
    expect(net.ageCalls()).toHaveLength(0);
    const photos = engine.library?.photosByAvatar(draftId) ?? [];
    expect(photos.every((p) => p.qa.age === undefined)).toBe(true);
  });
});

// MEDIUM (review #5): a draft's own estimate is a snapshot taken when it was
// last priced (createDraft, or a prior batch); if the toggle changes
// afterward, that stale number would disagree with the wizard's caption
// (AvatarWizard.tsx reads settings.imageAgeCheck live). Fixed by having
// #applySettings re-broadcast draft.changed, repriced in the new mode, for
// every open draft whenever imageAgeCheck itself changes — the renderer's
// store already applies draft.changed like any other event, so no renderer
// change is needed.
describe("a toggle change re-prices already-known drafts (#applySettings)", () => {
  test("switching the toggle re-broadcasts draft.changed with the estimate repriced in the new mode", async () => {
    const { draftId } = await seedDraft(dir());
    const { engine, events } = await startEngine(dir(), { init: initOff() });
    // Prices must be loaded at least once for #nextBatchAtKnownPrices to have something to peek.
    ok(await engine.handle(command("avatars.estimateCandidates", { avatarId: draftId })));
    const before = events().length;

    await engine.receive(settingsUpdate({ imageAgeCheck: "on" }));

    const found = events()
      .slice(before)
      .find((e) => e.type === "draft.changed" && e.payload.draft.avatarId === draftId);
    if (found === undefined || found.type !== "draft.changed") throw new Error("expected a draft.changed re-broadcast after the toggle changed");
    expect(found.payload.draft.estimate).toEqual(NEXT_BATCH_ON);
  });

  test("switching the toggle back off re-prices it again, down", async () => {
    const { draftId } = await seedDraft(dir());
    const { engine, events } = await startEngine(dir()); // harness default: on
    ok(await engine.handle(command("avatars.estimateCandidates", { avatarId: draftId })));
    const before = events().length;

    await engine.receive(settingsUpdate({ imageAgeCheck: "off" }));

    const found = events()
      .slice(before)
      .find((e) => e.type === "draft.changed" && e.payload.draft.avatarId === draftId);
    if (found === undefined || found.type !== "draft.changed") throw new Error("expected a draft.changed re-broadcast after the toggle changed");
    expect(found.payload.draft.estimate).toEqual(NEXT_BATCH_OFF);
  });

  test("no re-broadcast when the toggle itself does not change (an unrelated settings.update)", async () => {
    const { draftId } = await seedDraft(dir());
    const { engine, events } = await startEngine(dir(), { init: initOff() });
    ok(await engine.handle(command("avatars.estimateCandidates", { avatarId: draftId })));
    const before = events().length;

    // imageAgeCheck stays "off" explicitly: settingsUpdate() builds a whole
    // settings object from the harness defaults (imageAgeCheck "on") plus
    // overrides, so leaving it out here would itself be a toggle change.
    await engine.receive(settingsUpdate({ monthlyBudgetMicros: 5_000_000, imageAgeCheck: "off" }));

    expect(events().slice(before).filter((e) => e.type === "draft.changed" && e.payload.draft.avatarId === draftId)).toEqual([]);
  });
});
