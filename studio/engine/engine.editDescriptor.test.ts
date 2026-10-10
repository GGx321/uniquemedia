import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EngineFailure } from "./engineFailure";
import { manifestTraits } from "./avatars/records";
import { openLibrary } from "./library";
import { samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import { chatBody, fakeFetch, type FetchCall, type Reply } from "./openrouter/testing/fakes";
import type { QaGate } from "./runs/qa";
import { command, descriptorReply, engineSettings, failed, generate, GOOD, jobEnd, jobIdOf, network, OFFLINE, ok, portraitPng, seedDraft, startEngine, TRAITS, until, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();
setDefaultTimeout(30_000);

// `avatars.editDescriptor` (Stage 5, S5.0a): the owner's own, free edit of a saved avatar's descriptor, against a real engine over a real library in a temp dir.
// The claim rules are the point of most tests: an edit meets IN_FLIGHT while one of the five non-run jobs holds the avatar (a rewrite, a candidates batch, an
// archive, a delete, from S5.0c a check), and is allowed during a photo run.

const dir = useEngineDir("studio-engine-edit-descriptor-");
const BAD = "a young woman with hazel eyes";
const EDITED = "25-year-old European woman, green eyes, long straight blonde hair, athletic build";

let seeded = 0;

/** A saved avatar (a real portrait as master) with the given descriptor, in `status`. */
async function seedAvatar(opts: { descriptor?: string; status?: "active" | "archived" | "draft" } = {}): Promise<string> {
  const { library } = await openLibrary(join(dir(), "library"), { now: steppingClock(), newId: sequentialIds(`edit${++seeded}`) });
  const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: opts.descriptor ?? GOOD });
  if (opts.status === "draft") return avatar.id;
  const master = await library.addPhoto(avatar.id, portraitPng(1), samplePhotoMeta({ width: 60, height: 80, qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  if (opts.status === "archived") await library.updateAvatar(avatar.id, { status: "archived" });
  return avatar.id;
}

function edit(avatarId: string, text: string, expectedText: string = GOOD): unknown {
  return command("avatars.editDescriptor", { avatarId, text, expectedText });
}

function deletePrepare(avatarId: string): unknown {
  return { kind: "control", type: "avatar.deletePrepare", callId: "call-00000001", avatarId, token: "token-00000001" };
}

function storedText(avatarId: string): string {
  const manifest = JSON.parse(readFileSync(join(dir(), "library", "avatars", avatarId, "avatar.json"), "utf8")) as { descriptor: string };
  return manifest.descriptor;
}

async function started(opts: Parameters<typeof startEngine>[1] = {}) {
  return startEngine(dir(), { net: network(), ...opts });
}

describe("avatars.editDescriptor: the write", () => {
  test("stores the owner's text and answers the avatar with it", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await started();

    const answer = ok(await engine.handle(edit(avatarId, EDITED)));

    expect(answer).toMatchObject({ result: { avatar: { avatarId, descriptor: { age: 25, text: EDITED }, status: "active" } } });
    expect(storedText(avatarId)).toBe(EDITED);
  });

  test("announces the avatar with its new descriptor", async () => {
    const avatarId = await seedAvatar();
    const { engine, events } = await started();

    ok(await engine.handle(edit(avatarId, EDITED)));

    const changed = events().filter((e) => e.type === "avatar.changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ payload: { avatar: { avatarId, descriptor: { text: EDITED } } } });
  });

  test("costs nothing: no request leaves and the ledger gains no line", async () => {
    const avatarId = await seedAvatar();
    const net = network();
    const { engine } = await started({ net });

    ok(await engine.handle(edit(avatarId, EDITED)));

    expect(net.calls).toHaveLength(0);
  });

  test("stores the folded text: en dashes and curly quotes become plain ones", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await started();

    ok(await engine.handle(edit(avatarId, "25–year–old woman with a “warm” smile")));

    expect(storedText(avatarId)).toBe('25-year-old woman with a "warm" smile');
  });

  test("edits an archived avatar's descriptor and leaves it archived", async () => {
    const avatarId = await seedAvatar({ status: "archived" });
    const { engine } = await started();

    const answer = ok(await engine.handle(edit(avatarId, EDITED)));

    expect(answer).toMatchObject({ result: { avatar: { status: "archived", descriptor: { text: EDITED } } } });
  });

  test("mends a stored descriptor that fails today's rules, which the avatar list had put aside as unreadable", async () => {
    const avatarId = await seedAvatar({ descriptor: BAD });
    const { engine } = await started();
    const before = ok(await engine.handle(command("avatars.list")));
    expect(before).toMatchObject({ result: { avatars: [], unreadableAvatars: [{ avatarId }] } });

    ok(await engine.handle(edit(avatarId, EDITED, BAD)));

    expect(ok(await engine.handle(command("avatars.list")))).toMatchObject({ result: { avatars: [{ avatarId, descriptor: { text: EDITED } }], unreadableAvatars: [] } });
  });

  test("the next photo run's first image prompt carries the new text", async () => {
    const avatarId = await seedAvatar();
    const net = runNetwork();
    const { engine } = await runEngine(net);
    ok(await engine.handle(edit(avatarId, EDITED)));

    const { runId } = startedRun(await engine.handle(startRun(avatarId)));
    await until(() => net.imageCalls().length > 0, "the first image request");

    const prompt = String(net.imageCalls()[0]?.json().prompt);
    expect(prompt).toContain("green eyes, long straight blonde hair");
    expect(prompt).not.toContain("hazel eyes");
    ok(await engine.handle(command("runs.cancel", { runId })));
  });

  test("rewriteDescriptor still refuses a descriptor that now fits the rules", async () => {
    const avatarId = await seedAvatar({ descriptor: BAD });
    const { engine } = await started();
    ok(await engine.handle(edit(avatarId, EDITED, BAD)));

    const answer = failed(await engine.handle(command("avatars.rewriteDescriptor", { avatarId, acceptedWorstMicros: 1_000_000 })));

    expect(answer.error.code).toBe("VALIDATION");
    expect(storedText(avatarId)).toBe(EDITED);
  });
});

describe("avatars.editDescriptor: refusals", () => {
  test("an unknown avatar is NOT_FOUND", async () => {
    const { engine } = await started();

    expect(failed(await engine.handle(edit("avatar-nope", EDITED))).error.code).toBe("NOT_FOUND");
  });

  test("a draft is VALIDATION and stays as it was", async () => {
    const draftId = await seedAvatar({ status: "draft" });
    const { engine } = await started();

    expect(failed(await engine.handle(edit(draftId, EDITED))).error.code).toBe("VALIDATION");
    expect(storedText(draftId)).toBe(GOOD);
  });

  test("a stale proposal is refused as stale and writes nothing", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await started();

    const answer = failed(await engine.handle(edit(avatarId, EDITED, "25-year-old woman, an older stored text")));

    expect(answer.error).toMatchObject({ code: "VALIDATION", descriptorReason: "stale" });
    expect(storedText(avatarId)).toBe(GOOD);
  });

  test("the stale check comes before the text's own rules", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await started();

    const answer = failed(await engine.handle(edit(avatarId, "", "something else")));

    expect(answer.error).toMatchObject({ descriptorReason: "stale" });
  });

  test.each([
    ["empty", "   "],
    ["hidden-chars", "25-year-old woman\u200B"],
    ["too-long", `${GOOD} ${"x".repeat(600)}`],
    ["no-anchor", "European woman, hazel eyes"],
    ["script", "25-year-old \u0436\u0435\u043D\u0449\u0438\u043D\u0430, hazel eyes"],
    ["non-ascii-digits", "25-year-old woman with \u0663 freckles"],
    ["other-age", "25-year-old woman who looks 19 years old"],
    ["under-21-bound", "25-year-old woman, under 21"],
    ["number", "25-year-old woman with 3 moles"],
  ] as const)("refuses a text that breaks the rule %s and writes nothing", async (descriptorReason, text) => {
    const avatarId = await seedAvatar();
    const { engine, events } = await started();

    const answer = failed(await engine.handle(edit(avatarId, text)));

    expect(answer.error).toMatchObject({ code: "VALIDATION", descriptorReason });
    expect(storedText(avatarId)).toBe(GOOD);
    expect(events().filter((e) => e.type === "avatar.changed")).toHaveLength(0);
  });

  test("refuses a youth word, naming it", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await started();

    const answer = failed(await engine.handle(edit(avatarId, "25-year-old petite woman, hazel eyes")));

    expect(answer.error).toMatchObject({ code: "VALIDATION", descriptorReason: "youth-word", descriptorWords: ["petite"] });
    expect(storedText(avatarId)).toBe(GOOD);
  });

  test("refuses a payload text over the bound before any rule is read", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await started();

    const answer = failed(await engine.handle(edit(avatarId, "x".repeat(4_001))));

    expect(answer.error.code).toBe("VALIDATION");
    expect(answer.error.descriptorReason).toBeUndefined();
  });
});

describe("avatars.editDescriptor: the write is judged inside the library's exclusive section", () => {
  test("the validator it hands the library refuses a composite that is invalid for the manifest read under the lock", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await started();
    const library = engine.library;
    if (library === null) throw new Error("no library");
    const original = library.updateAvatar.bind(library);
    // Stands for a change landing between the engine's early check and the write: the validator is handed a manifest whose age no longer matches the text.
    library.updateAvatar = (id, patch, validate) => original(id, patch, validate === undefined ? undefined : (next) => validate({ ...next, age: 30 }));

    const answer = failed(await engine.handle(edit(avatarId, EDITED)));

    expect(answer.error).toMatchObject({ code: "VALIDATION", descriptorReason: "no-anchor" });
    expect(storedText(avatarId)).toBe(GOOD);
  });

  test("a write that fails answers INTERNAL, keeps the old text and announces nothing", async () => {
    const avatarId = await seedAvatar();
    const { engine, events } = await started();
    const library = engine.library;
    if (library === null) throw new Error("no library");
    library.updateAvatar = async () => {
      throw new Error("disk full");
    };

    const answer = failed(await engine.handle(edit(avatarId, EDITED)));

    expect(answer.error.code).toBe("INTERNAL");
    expect(storedText(avatarId)).toBe(GOOD);
    expect(events().filter((e) => e.type === "avatar.changed")).toHaveLength(0);
  });

  test("an EngineFailure thrown by the validator reaches the owner as it is", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await started();
    const library = engine.library;
    if (library === null) throw new Error("no library");
    library.updateAvatar = async () => {
      throw new EngineFailure({ code: "VALIDATION", descriptorReason: "stale" });
    };

    expect(failed(await engine.handle(edit(avatarId, EDITED))).error).toMatchObject({ code: "VALIDATION", descriptorReason: "stale" });
  });
});

describe("avatars.editDescriptor: claims", () => {
  test("is refused IN_FLIGHT while a rewrite holds the avatar, and allowed when it ends", async () => {
    const avatarId = await seedAvatar({ descriptor: BAD });
    let release: (reply: Reply) => void = () => {};
    const held = new Promise<Reply>((resolve) => {
      release = resolve;
    });
    const net = network({ descriptors: [() => held] });
    const { engine } = await started({ net });
    const rewriting = engine.handle(command("avatars.rewriteDescriptor", { avatarId, acceptedWorstMicros: 1_000_000 }));
    await until(() => net.descriptorCalls().length === 1, "the rewrite's descriptor request");

    expect(failed(await engine.handle(edit(avatarId, EDITED, BAD))).error.code).toBe("IN_FLIGHT");
    expect(storedText(avatarId)).toBe(BAD);

    release(descriptorReply(GOOD));
    ok(await rewriting);
    expect(ok(await engine.handle(edit(avatarId, EDITED, GOOD)))).toMatchObject({ result: { avatar: { descriptor: { text: EDITED } } } });
  });

  test("is refused IN_FLIGHT while an archive holds the avatar", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await started();

    const archiving = engine.handle(command("avatars.archive", { avatarId }));
    const refused = await engine.handle(edit(avatarId, EDITED));
    ok(await archiving);

    expect(failed(refused).error.code).toBe("IN_FLIGHT");
    expect(storedText(avatarId)).toBe(GOOD);
  });

  test("is refused IN_FLIGHT while a delete is prepared, though the avatar is out of the library's indexes, and allowed once a kept delete gives it back", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await started();
    await engine.receive(deletePrepare(avatarId));

    expect(failed(await engine.handle(edit(avatarId, EDITED))).error.code).toBe("IN_FLIGHT");

    await engine.receive({ kind: "control", type: "avatar.deleteFinish", callId: "call-00000002", avatarId, token: "token-00000001", outcome: "kept" });
    ok(await engine.handle(edit(avatarId, EDITED)));
    expect(storedText(avatarId)).toBe(EDITED);
  });

  test("is refused IN_FLIGHT while a batch of candidates holds the avatar (a draft, whose edit is otherwise VALIDATION)", async () => {
    const { draftId } = await seedDraft(dir());
    const net = network({ image: () => ({ hang: true }) });
    const { engine, events } = await started({ net });
    const jobId = jobIdOf(await engine.handle(generate(draftId)));
    await until(() => net.imageCalls().length > 0, "the batch's first image request");

    expect(failed(await engine.handle(edit(draftId, EDITED))).error.code).toBe("IN_FLIGHT");

    ok(await engine.handle(command("avatars.cancel", { jobId })));
    await jobEnd(events, jobId);
  });

  test("is allowed while a photo run runs, and the run keeps going", async () => {
    const avatarId = await seedAvatar();
    const net = runNetwork();
    const { engine, events } = await runEngine(net);
    const { runId, jobId } = startedRun(await engine.handle(startRun(avatarId)));
    await until(() => net.imageCalls().length > 0, "the run's first image request");

    ok(await engine.handle(edit(avatarId, EDITED)));

    expect(storedText(avatarId)).toBe(EDITED);
    expect(events().some((e) => e.type === "job.failed" && "jobId" in e.payload && e.payload.jobId === jobId)).toBe(false);
    ok(await engine.handle(command("runs.cancel", { runId })));
  });

  test("a live run keeps the descriptor it started with", async () => {
    const avatarId = await seedAvatar();
    const net = runNetwork();
    const { engine } = await runEngine(net);
    const { runId } = startedRun(await engine.handle(startRun(avatarId)));
    await until(() => net.imageCalls().length > 0, "the run's first image request");

    ok(await engine.handle(edit(avatarId, EDITED)));

    expect(String(net.imageCalls()[0]?.json().prompt)).toContain("hazel eyes");
    ok(await engine.handle(command("runs.cancel", { runId })));
  });
});

// ---------- a photo run over a fake OpenRouter whose image requests hang ----------

/** The face gate every run needs (invariant-mirroring `engine.runs.test.ts`): it passes every photo. */
function faceGate(): QaGate {
  return { name: "face", paid: false, check: async () => ({ verdict: "pass" }) };
}

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
    deps: { qaGates: [faceGate()] },
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
