import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Estimate } from "../shared/engine";
import { manifestTraits } from "./avatars/records";
import { openLibrary } from "./library";
import { samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import { chatBody, fakeFetch, type FetchCall, type Reply } from "./openrouter/testing/fakes";
import {
  checkCalls,
  checkReply,
  command,
  descriptorReply,
  engineSettings,
  failed,
  GOOD,
  jobEnd,
  jobIdOf,
  ledgerLines,
  network,
  OFFLINE,
  ok,
  portraitPng,
  seedDraft,
  startEngine,
  TRAITS,
  until,
  useEngineDir,
  generate,
} from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();
setDefaultTimeout(30_000);

// `avatars.estimateCheckDescriptor` and `avatars.checkDescriptor` (Stage 5, S5.0c): the descriptor-vs-master check of a SAVED avatar, against a real engine over a real library in a
// temp dir and a fake OpenRouter. The check is paid (accepted by a click that showed its worst, reserved before the call, settled after it) and it NEVER writes (I5.6): the owner
// applies a proposal with the free `avatars.editDescriptor`. It follows the claims of `rewriteDescriptor` (IN_FLIGHT while a job, a command or a photo run holds the avatar).

const dir = useEngineDir("studio-engine-check-descriptor-");
const BAD = "a young woman with hazel eyes";
const FIXED = "25-year-old European woman, light olive skin, hazel eyes, long straight platinum hair with bangs, athletic build, light freckles across the nose.";

/** Two attempts at their ceilings on grok-4.3 (fallback table): 2 × (7K in × $1.25/M + 1.5K out × $2.50/M). */
const CHECK_ESTIMATE: Estimate = { expectedMicros: 3_375, worstMicros: 25_000, prices: "fallback", pricesAsOf: "2026-09-24" };
const ATTEMPT_WORST = 12_500;

const HAIR_WRONG = {
  aspects: {
    hair: { state: "mismatch", descriptor: "волнистые каштановые", photo: "прямые платиновые с чёлкой" },
    eyes: { state: "ok", descriptor: "", photo: "" },
    marks: { state: "ok", descriptor: "", photo: "" },
    body: { state: "not-visible", descriptor: "", photo: "" },
  },
  descriptor: FIXED,
};

let seeded = 0;

/** A saved avatar (a real portrait as master) with the given descriptor, in `status`. */
async function seedAvatar(opts: { descriptor?: string; status?: "active" | "archived" | "draft" } = {}): Promise<string> {
  const { library } = await openLibrary(join(dir(), "library"), { now: steppingClock(), newId: sequentialIds(`chk${++seeded}`) });
  const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: opts.descriptor ?? GOOD });
  if (opts.status === "draft") return avatar.id;
  const master = await library.addPhoto(avatar.id, portraitPng(1), samplePhotoMeta({ width: 60, height: 80, qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  if (opts.status === "archived") await library.updateAvatar(avatar.id, { status: "archived" });
  return avatar.id;
}

function check(avatarId: string, acceptedWorstMicros: number = CHECK_ESTIMATE.worstMicros): unknown {
  return command("avatars.checkDescriptor", { avatarId, acceptedWorstMicros });
}

function estimateCheck(avatarId: string): unknown {
  return command("avatars.estimateCheckDescriptor", { avatarId });
}

function storedText(avatarId: string): string {
  const manifest = JSON.parse(readFileSync(join(dir(), "library", "avatars", avatarId, "avatar.json"), "utf8")) as { descriptor: string };
  return manifest.descriptor;
}

function manifestBytes(avatarId: string): string {
  return readFileSync(join(dir(), "library", "avatars", avatarId, "avatar.json"), "utf8");
}

async function started(opts: Parameters<typeof startEngine>[1] = {}) {
  return startEngine(dir(), { net: network(), ...opts });
}

/** The checked result of a good `avatars.checkDescriptor` answer. */
function checkOf(response: Parameters<typeof ok>[0]) {
  const answer = ok(response);
  if (answer.type !== "avatars.checkDescriptor") throw new Error(`expected a check answer, got ${answer.type}`);
  return answer.result.check;
}

function paidLines(): Record<string, unknown>[] {
  return ledgerLines(dir());
}

describe("avatars.estimateCheckDescriptor", () => {
  test("prices up to two check attempts on the settings' text model", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await started();

    expect(ok(await engine.handle(estimateCheck(avatarId)))).toMatchObject({ result: CHECK_ESTIMATE });
  });

  test("prices a draft too, so the wizard can show the price under «Сохранить»", async () => {
    const draftId = await seedAvatar({ status: "draft" });
    const { engine } = await started();

    expect(ok(await engine.handle(estimateCheck(draftId)))).toMatchObject({ result: CHECK_ESTIMATE });
  });

  test("an unknown avatar is NOT_FOUND", async () => {
    const { engine } = await started();

    expect(failed(await engine.handle(estimateCheck("avatar-nope"))).error.code).toBe("NOT_FOUND");
  });

  test("a missing library is LIBRARY_UNAVAILABLE", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await started();
    await engine.receive({ kind: "control", type: "settings.update", settings: engineSettings(dir(), { libraryPath: join(dir(), "does-not-exist") }) });

    expect(failed(await engine.handle(estimateCheck(avatarId))).error.code).toBe("LIBRARY_UNAVAILABLE");
  });

  test("is free: it sends no paid request and writes no ledger line", async () => {
    const avatarId = await seedAvatar();
    const net = network();
    const { engine } = await started({ net });

    ok(await engine.handle(estimateCheck(avatarId)));

    expect(net.paidCalls()).toHaveLength(0);
    expect(paidLines()).toEqual([]);
  });

  test("prices a stored descriptor that fails today's rules too: it is a price, not a check", async () => {
    const avatarId = await seedAvatar({ descriptor: BAD });
    const { engine } = await started();

    expect(ok(await engine.handle(estimateCheck(avatarId)))).toMatchObject({ result: CHECK_ESTIMATE });
  });
});

describe("avatars.checkDescriptor: the check", () => {
  test("a good answer is the check, with the descriptor it judged", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await started();

    expect(checkOf(await engine.handle(check(avatarId)))).toEqual({
      matches: true,
      aspects: { hair: { state: "ok" }, eyes: { state: "ok" }, marks: { state: "ok" }, body: { state: "not-visible" } },
      proposal: null,
      checkedText: GOOD,
    });
  });

  test("a hair mismatch comes back with its phrases and a proposal", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await started({ net: network({ check: () => checkReply(HAIR_WRONG) }) });

    expect(checkOf(await engine.handle(check(avatarId)))).toMatchObject({
      matches: false,
      aspects: { hair: { state: "mismatch", descriptor: "волнистые каштановые", photo: "прямые платиновые с чёлкой" } },
      proposal: FIXED,
      checkedText: GOOD,
    });
  });

  test("the request: the settings' text model, the strict check schema, the master as an image and the stored descriptor as data", async () => {
    const avatarId = await seedAvatar();
    const net = network();
    const { engine } = await started({ net, init: { settings: engineSettings(dir(), { textModel: "x-ai/grok-4.3" }) } });

    ok(await engine.handle(check(avatarId)));

    const [call] = checkCalls(net);
    expect(call?.json()).toMatchObject({
      model: "x-ai/grok-4.3",
      max_tokens: 1_500,
      response_format: { type: "json_schema", json_schema: { name: "descriptor_check", strict: true } },
    });
    const body = JSON.stringify(call?.json());
    expect(body).toContain("data:image/jpeg;base64,");
    expect(body).toContain(JSON.stringify(GOOD).slice(1, -1));
  });

  test("the avatar's name is owner text and never reaches the prompt", async () => {
    const avatarId = await seedAvatar();
    const net = network();
    const { engine } = await started({ net });

    ok(await engine.handle(check(avatarId)));

    expect(JSON.stringify(checkCalls(net)[0]?.json())).not.toContain("Mia");
  });

  test("checks an archived avatar", async () => {
    const avatarId = await seedAvatar({ status: "archived" });
    const { engine } = await started();

    expect(checkOf(await engine.handle(check(avatarId))).matches).toBe(true);
  });

  test("a proposal is applied only by the owner: editDescriptor with the check's checkedText accepts it", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await started({ net: network({ check: () => checkReply(HAIR_WRONG) }) });
    const result = checkOf(await engine.handle(check(avatarId)));
    expect(storedText(avatarId)).toBe(GOOD);

    ok(await engine.handle(command("avatars.editDescriptor", { avatarId, text: result.proposal, expectedText: result.checkedText })));

    expect(storedText(avatarId)).toBe(FIXED);
  });

  test("a second check after the first runs the same way: the claim and the cap are gone", async () => {
    const avatarId = await seedAvatar();
    const net = network();
    const { engine } = await started({ net });

    ok(await engine.handle(check(avatarId)));
    ok(await engine.handle(check(avatarId)));

    expect(checkCalls(net)).toHaveLength(2);
  });
});

describe("avatars.checkDescriptor: it never writes (I5.6)", () => {
  test("the manifest is byte for byte the same after a check that proposes a different text", async () => {
    const avatarId = await seedAvatar();
    const before = manifestBytes(avatarId);
    const { engine } = await started({ net: network({ check: () => checkReply(HAIR_WRONG) }) });

    expect(checkOf(await engine.handle(check(avatarId))).proposal).toBe(FIXED);

    expect(manifestBytes(avatarId)).toBe(before);
  });

  test("it reaches no library write at all, and announces no avatar", async () => {
    const avatarId = await seedAvatar();
    const { engine, events } = await started({ net: network({ check: () => checkReply(HAIR_WRONG) }) });
    const library = engine.library;
    if (library === null) throw new Error("no library");
    library.updateAvatar = async () => {
      throw new Error("a check must not write");
    };

    ok(await engine.handle(check(avatarId)));

    expect(events().filter((e) => e.type === "avatar.changed" || e.type === "draft.changed")).toHaveLength(0);
  });
});

describe("avatars.checkDescriptor: the money", () => {
  test("reserves the attempt's worst case before the call under <jobId>:check#1, in the job's own scope, and settles at usage.cost", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await started();

    ok(await engine.handle(check(avatarId)));

    const lines = paidLines();
    const reserve = lines.find((l) => l.type === "reserve") as { attemptId: string; jobId: string; scope: { avatarJobId: string }; worstMicros: number } | undefined;
    if (reserve === undefined) throw new Error("no reserve was written");
    expect(reserve.attemptId).toBe(`${reserve.jobId}:check#1`);
    expect(reserve.scope).toEqual({ avatarJobId: reserve.jobId });
    expect(reserve.worstMicros).toBe(ATTEMPT_WORST);
    expect(lines.map((l) => l.type)).toEqual(["reserve", "settle"]);
    expect(lines[1]).toMatchObject({ attemptId: reserve.attemptId, costMicros: 2_100, estimated: false });
  });

  test("an unparseable answer is asked once more under check#2: both are reserved at the worst case and settled, nothing stays open", async () => {
    const avatarId = await seedAvatar();
    const replies: Reply[] = [{ status: 200, body: chatBody("the hair looks fine", { cost: 0.002 }) }, checkReply()];
    const { engine } = await started({ net: network({ check: (_call, n) => replies[n - 1] ?? OFFLINE }) });

    ok(await engine.handle(check(avatarId)));

    expect(paidLines().map((l) => [l.type, String(l.attemptId).split(":").at(-1)])).toEqual([
      ["reserve", "check#1"],
      ["settle", "check#1"],
      ["reserve", "check#2"],
      ["settle", "check#2"],
    ]);
  });

  test("emits the money status after the call", async () => {
    const avatarId = await seedAvatar();
    const { engine, events } = await started();

    ok(await engine.handle(check(avatarId)));

    expect(events().filter((e) => e.type === "money.changed").length).toBeGreaterThan(0);
  });

  test("the accepted worst case exactly equal to the current one passes", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await started();

    expect(checkOf(await engine.handle(check(avatarId, CHECK_ESTIMATE.worstMicros))).matches).toBe(true);
  });

  test("PRICE_CHANGED when the accepted worst case is one below the current one: nothing is sent", async () => {
    const avatarId = await seedAvatar();
    const net = network();
    const { engine } = await started({ net });

    expect(failed(await engine.handle(check(avatarId, CHECK_ESTIMATE.worstMicros - 1))).error.code).toBe("PRICE_CHANGED");
    expect(net.paidCalls()).toHaveLength(0);
    expect(paidLines()).toEqual([]);
  });

  test("BUDGET_EXCEEDED when the month has no room for the worst case: nothing is sent", async () => {
    const avatarId = await seedAvatar();
    const net = network();
    const { engine } = await started({ net, init: { settings: engineSettings(dir(), { monthlyBudgetMicros: CHECK_ESTIMATE.worstMicros - 1 }) } });

    expect(failed(await engine.handle(check(avatarId))).error.code).toBe("BUDGET_EXCEEDED");
    expect(net.paidCalls()).toHaveLength(0);
  });

  test("the draft estimate and the check's own price are the same figure", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await started();

    const estimate = ok(await engine.handle(estimateCheck(avatarId)));
    if (estimate.type !== "avatars.estimateCheckDescriptor") throw new Error("wrong type");

    expect(checkOf(await engine.handle(check(avatarId, estimate.result.worstMicros))).matches).toBe(true);
  });
});

describe("avatars.checkDescriptor: refusals, all free", () => {
  test("no key: AUTH_INVALID, nothing is sent", async () => {
    const avatarId = await seedAvatar();
    const net = network();
    const { engine } = await started({ net, key: null });

    expect(failed(await engine.handle(check(avatarId))).error.code).toBe("AUTH_INVALID");
    expect(net.calls).toHaveLength(0);
  });

  test("an unknown avatar is NOT_FOUND", async () => {
    const { engine } = await started();

    expect(failed(await engine.handle(check("avatar-nope"))).error.code).toBe("NOT_FOUND");
  });

  test("a draft is VALIDATION: there is no master to compare with yet", async () => {
    const draftId = await seedAvatar({ status: "draft" });
    const net = network();
    const { engine } = await started({ net });

    expect(failed(await engine.handle(check(draftId))).error.code).toBe("VALIDATION");
    expect(net.paidCalls()).toHaveLength(0);
  });

  test("a stored descriptor that fails today's rules is DESCRIPTOR_INVALID: mend it first", async () => {
    const avatarId = await seedAvatar({ descriptor: BAD });
    const net = network();
    const { engine } = await started({ net });

    expect(failed(await engine.handle(check(avatarId))).error.code).toBe("DESCRIPTOR_INVALID");
    expect(net.paidCalls()).toHaveLength(0);
  });

  test("a missing library is LIBRARY_UNAVAILABLE", async () => {
    const avatarId = await seedAvatar();
    const net = network();
    const { engine } = await started({ net });
    await engine.receive({ kind: "control", type: "settings.update", settings: engineSettings(dir(), { libraryPath: join(dir(), "does-not-exist") }) });

    expect(failed(await engine.handle(check(avatarId))).error.code).toBe("LIBRARY_UNAVAILABLE");
    expect(net.paidCalls()).toHaveLength(0);
  });

  test("a payload without the accepted worst case is refused by the contract", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await started();

    expect(failed(await engine.handle(command("avatars.checkDescriptor", { avatarId }))).error.code).toBe("VALIDATION");
  });
});

describe("avatars.checkDescriptor: failures", () => {
  test("an answer unreadable twice is INTERNAL; both attempts are settled and nothing is left open; the avatar is untouched", async () => {
    const avatarId = await seedAvatar();
    const before = manifestBytes(avatarId);
    const bad: Reply = { status: 200, body: chatBody("nope", { cost: 0.002 }) };
    const { engine } = await started({ net: network({ check: () => bad }) });

    expect(failed(await engine.handle(check(avatarId))).error.code).toBe("INTERNAL");

    expect(paidLines().filter((l) => l.type === "settle")).toHaveLength(2);
    expect(manifestBytes(avatarId)).toBe(before);
  });

  test("a moderation refusal is free and final: MODERATION_REFUSED, one request", async () => {
    const avatarId = await seedAvatar();
    const net = network({ check: () => ({ status: 400, body: { error: { message: "xAI blocked this request through content moderation." } } }) });
    const { engine } = await started({ net });

    expect(failed(await engine.handle(check(avatarId))).error.code).toBe("MODERATION_REFUSED");
    expect(checkCalls(net)).toHaveLength(1);
    expect(paidLines().at(-1)).toMatchObject({ type: "settle", costMicros: 0 });
  });

  test("a 401 answers AUTH_INVALID and marks the key rejected", async () => {
    const avatarId = await seedAvatar();
    const net = network({ check: () => ({ status: 401, body: { error: { message: "No auth credentials found" } } }) });
    const { engine, events } = await started({ net });

    expect(failed(await engine.handle(check(avatarId))).error.code).toBe("AUTH_INVALID");
    expect(events().at(-1)).toMatchObject({ type: "settings.changed", payload: { settings: { apiKey: { rejected: true } } } });
  });

  test("a request that gets no answer within the check's own timeout fails TIMEOUT and leaves its reserve open at the worst case", async () => {
    const avatarId = await seedAvatar();
    const net = network({ check: () => ({ hang: true }) });
    const { engine } = await started({ net, deps: { descriptorCheckTimeoutMs: 50 } });

    const answer = failed(await engine.handle(check(avatarId)));

    expect(answer.error.code).toBe("TIMEOUT");
    const lines = paidLines();
    expect(lines.filter((l) => l.type === "reserve").map((l) => l.worstMicros)).toEqual([ATTEMPT_WORST]);
    expect(lines.filter((l) => l.type === "settle")).toHaveLength(0);
  });
});

describe("avatars.checkDescriptor: claims", () => {
  /** A held check: its request is out and unanswered until `release`. */
  async function heldCheck(avatarId: string) {
    let release: (reply: Reply) => void = () => {};
    const held = new Promise<Reply>((resolve) => {
      release = resolve;
    });
    const net = network({ check: () => held });
    const running = await started({ net });
    const pending = running.engine.handle(check(avatarId));
    await until(() => checkCalls(net).length === 1, "the check's request");
    return { ...running, net, pending, release };
  }

  test("a second check of the same avatar is IN_FLIGHT and sends nothing", async () => {
    const avatarId = await seedAvatar();
    const { engine, net, pending, release } = await heldCheck(avatarId);

    expect(failed(await engine.handle(check(avatarId))).error.code).toBe("IN_FLIGHT");
    expect(checkCalls(net)).toHaveLength(1);

    release(checkReply());
    ok(await pending);
  });

  test("an edit of the descriptor is IN_FLIGHT while a check holds the avatar, and allowed when it ends", async () => {
    const avatarId = await seedAvatar();
    const { engine, pending, release } = await heldCheck(avatarId);

    const refused = await engine.handle(command("avatars.editDescriptor", { avatarId, text: FIXED, expectedText: GOOD }));
    expect(failed(refused).error.code).toBe("IN_FLIGHT");
    expect(storedText(avatarId)).toBe(GOOD);

    release(checkReply());
    ok(await pending);
    ok(await engine.handle(command("avatars.editDescriptor", { avatarId, text: FIXED, expectedText: GOOD })));
    expect(storedText(avatarId)).toBe(FIXED);
  });

  test("an archive is IN_FLIGHT while a check holds the avatar", async () => {
    const avatarId = await seedAvatar();
    const { engine, pending, release } = await heldCheck(avatarId);

    expect(failed(await engine.handle(command("avatars.archive", { avatarId }))).error.code).toBe("IN_FLIGHT");

    release(checkReply());
    ok(await pending);
  });

  test("a delete prepared while a check holds the avatar is refused IN_FLIGHT", async () => {
    const avatarId = await seedAvatar();
    const { engine, posted, pending, release } = await heldCheck(avatarId);

    await engine.receive({ kind: "control", type: "avatar.deletePrepare", callId: "call-00000001", avatarId, token: "token-00000001" });
    const reply = posted.at(-1);

    expect(reply).toMatchObject({ kind: "control", type: "reply", callId: "call-00000001", error: { code: "IN_FLIGHT" } });
    release(checkReply());
    ok(await pending);
  });

  test("a library switch is refused while a check is paid for: the check counts as a paid command", async () => {
    const avatarId = await seedAvatar();
    const { engine, posted, pending, release } = await heldCheck(avatarId);

    await engine.receive({ kind: "control", type: "library.open", callId: "call-00000009", path: join(dir(), "other-library") });
    const reply = posted.at(-1);

    expect(reply).toMatchObject({ kind: "control", type: "reply", callId: "call-00000009", error: { code: "IN_FLIGHT" } });
    release(checkReply());
    ok(await pending);
  });

  test("another avatar can be checked meanwhile: the claim is the avatar's", async () => {
    const first = await seedAvatar();
    const second = await seedAvatar();
    const { engine, pending, release } = await heldCheck(first);

    release(checkReply());
    ok(await pending);
    expect(checkOf(await engine.handle(check(second))).matches).toBe(true);
  });

  test("a refused check leaves no claim: after a failure the avatar can be edited and checked again", async () => {
    const avatarId = await seedAvatar();
    const replies: Reply[] = [{ status: 400, body: { error: { message: "xAI blocked this request through content moderation." } } }, checkReply()];
    const { engine } = await started({ net: network({ check: (_call, n) => replies[n - 1] ?? OFFLINE }) });

    expect(failed(await engine.handle(check(avatarId))).error.code).toBe("MODERATION_REFUSED");

    ok(await engine.handle(command("avatars.editDescriptor", { avatarId, text: FIXED, expectedText: GOOD })));
    expect(checkOf(await engine.handle(check(avatarId))).checkedText).toBe(FIXED);
  });

  test("a rewrite of the descriptor, a candidates batch and a check exclude one another: a batch holds the avatar against a check", async () => {
    const { draftId } = await seedDraft(dir());
    const net = network({ image: () => ({ hang: true }) });
    const { engine, events } = await started({ net });
    const jobId = jobIdOf(await engine.handle(generate(draftId)));
    await until(() => net.imageCalls().length > 0, "the batch's first image request");

    // A draft is VALIDATION for a check; IN_FLIGHT comes first, from the claim.
    expect(failed(await engine.handle(check(draftId))).error.code).toBe("IN_FLIGHT");

    ok(await engine.handle(command("avatars.cancel", { jobId })));
    await jobEnd(events, jobId);
  });

  test("is refused IN_FLIGHT while a photo run holds the avatar, and nothing is sent for it", async () => {
    const avatarId = await seedAvatar();
    const net = runNetwork();
    const { engine, events } = await runEngine(net);
    const { runId, jobId } = startedRun(await engine.handle(startRun(avatarId)));
    await until(() => net.imageCalls().length > 0, "the run's first image request");

    expect(failed(await engine.handle(check(avatarId))).error.code).toBe("IN_FLIGHT");
    expect(net.calls.filter((c) => c.url.endsWith("/chat/completions") && String(c.body).includes("descriptor_check"))).toHaveLength(0);

    ok(await engine.handle(command("runs.cancel", { runId })));
    await jobEnd(events, jobId);
  });
});

// A rewrite is the other paid command that holds an avatar by the same claim; a check meeting it is refused the same way.
describe("avatars.checkDescriptor: against a rewrite", () => {
  test("a check is IN_FLIGHT while a rewrite holds the avatar", async () => {
    const avatarId = await seedAvatar({ descriptor: BAD });
    let release: (reply: Reply) => void = () => {};
    const held = new Promise<Reply>((resolve) => {
      release = resolve;
    });
    const net = network({ descriptors: [() => held] });
    const { engine } = await started({ net });
    const rewriting = engine.handle(command("avatars.rewriteDescriptor", { avatarId, acceptedWorstMicros: 1_000_000 }));
    await until(() => net.descriptorCalls().length === 1, "the rewrite's descriptor request");

    expect(failed(await engine.handle(check(avatarId))).error.code).toBe("IN_FLIGHT");

    release(descriptorReply(GOOD));
    ok(await rewriting);
  });
});

// ---------- a photo run over a fake OpenRouter whose image requests hang ----------

function isWriter(call: FetchCall): boolean {
  if (!call.url.endsWith("/chat/completions")) return false;
  const format = call.json().response_format;
  return typeof format === "object" && format !== null && "json_schema" in format && JSON.stringify(format.json_schema).includes("scene_sentences");
}

function slotsAskedFor(call: FetchCall): number[] {
  const body = call.json();
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const user = messages.find((m: unknown) => typeof m === "object" && m !== null && "role" in m && m.role === "user");
  const text = typeof user === "object" && user !== null && "content" in user && typeof user.content === "string" ? user.content : "";
  return (JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1)) as { slotIndex: number }[]).map((s) => s.slotIndex);
}

/** Writer answers, image requests hang (the run stays open until cancelled). */
function runNetwork() {
  const route = async (call: FetchCall): Promise<Reply> => {
    if (call.url.endsWith("/images")) return { hang: true };
    if (isWriter(call)) {
      const scenes = slotsAskedFor(call).map((slotIndex) => ({ slotIndex, sentence: `A friend catches her mid-laugh at the kitchen counter in the morning light (${slotIndex}).` }));
      return { status: 200, body: chatBody(JSON.stringify({ scenes }), { cost: 0.0112 }) };
    }
    if (call.url.endsWith("/credits")) return { status: 200, body: { data: { total_credits: 25, total_usage: 1 } } };
    if (call.url.endsWith("/models") || call.url.endsWith("/endpoints")) return OFFLINE;
    throw new Error(`unexpected request to ${call.method} ${call.url}`);
  };
  const net = fakeFetch(Array.from({ length: 64 }, () => route));
  return { fetch: net.fetch, calls: net.calls, imageCalls: () => net.calls.filter((c) => c.url.endsWith("/images")) };
}

function runEngine(net: ReturnType<typeof runNetwork>) {
  return startEngine(dir(), {
    init: { settings: engineSettings(dir(), { imageAgeCheck: "off" }) },
    net: { fetch: net.fetch, calls: net.calls, imageCalls: net.imageCalls, ageCalls: () => [], descriptorCalls: () => [], paidCalls: () => net.calls.filter((c) => c.method === "POST") },
    deps: { qaGates: [{ name: "face", paid: false, check: async () => ({ verdict: "pass" as const }) }] },
  });
}

const FOUR_WORST = 4 * 3 * 50_000 + 75_000;

function startRun(avatarId: string): unknown {
  return command("runs.start", { avatarId, count: 4, categories: ["home"], poses: { profile: false, back: false }, acceptedWorstMicros: FOUR_WORST });
}

function startedRun(response: Parameters<typeof ok>[0]): { runId: string; jobId: string } {
  const answer = ok(response);
  if (answer.type !== "runs.start") throw new Error(`expected a run answer, got ${answer.type}`);
  return answer.result;
}
