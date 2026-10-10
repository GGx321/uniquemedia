import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bodyPhrase, type AvatarBody } from "../shared/engine";
import { manifestTraits } from "./avatars/records";
import { openLibrary } from "./library";
import { samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import { chatBody, fakeFetch, imageBody, type FetchCall, type Reply } from "./openrouter/testing/fakes";
import type { QaGate } from "./runs/qa";
import { command, descriptorReply, engineSettings, failed, GOOD, jobEnd, network, OFFLINE, ok, portraitPng, startEngine, TRAITS, until, useEngineDir, NEW_AVATAR } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();
setDefaultTimeout(30_000);

// Stage 5, S5.2a: the body traits against a real engine over a real library in a temp dir. `avatars.setBody` and `avatars.dismissBodyProposal` (free, claimed like
// `avatars.editDescriptor`), the composite rule (text + «; » + body phrase <= 600) on every write path, and the phrase in the descriptor every run carries.

const dir = useEngineDir("studio-engine-body-");
const BODY: AvatarBody = { height: "tall", bust: "full", legLength: "long", legShape: "slim" };
const PHRASE = "tall, a full bust and long slim legs";
const PROPOSAL = { values: { bust: "full" }, seen: { bust: "photo", height: "not-visible" }, at: "2026-10-10T10:00:00.000Z" };
const EDITED = "25-year-old European woman, green eyes, long straight blonde hair, athletic build";

/** A valid descriptor text of exactly `length` characters. */
const textOf = (length: number, mark = "x"): string => `${GOOD.slice(0, -1)}, `.padEnd(length - 1, mark).padEnd(length, mark);

let seeded = 0;

async function seedAvatar(opts: { descriptor?: string; status?: "active" | "archived" | "draft"; body?: Record<string, unknown>; proposal?: boolean; schemaVersion?: 1 } = {}): Promise<string> {
  const { library } = await openLibrary(join(dir(), "library"), { now: steppingClock(), newId: sequentialIds(`body${++seeded}`) });
  const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: { ...manifestTraits(TRAITS), ...opts.body } as Record<string, string | string[]>, descriptor: opts.descriptor ?? GOOD });
  if (opts.status === "draft") return avatar.id;
  const master = await library.addPhoto(avatar.id, portraitPng(1), samplePhotoMeta({ width: 60, height: 80, qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  if (opts.status === "archived") await library.updateAvatar(avatar.id, { status: "archived" });
  if (opts.proposal === true || opts.schemaVersion === 1) {
    const path = join(dir(), "library", "avatars", avatar.id, "avatar.json");
    const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (opts.proposal === true) manifest.bodyProposal = PROPOSAL;
    if (opts.schemaVersion === 1) Object.assign(manifest, { schemaVersion: 1, traits: { hair: "chestnut" } });
    writeFileSync(path, JSON.stringify(manifest));
  }
  return avatar.id;
}

function stored(avatarId: string): { descriptor: string; traits: Record<string, unknown>; schemaVersion: number; bodyProposal?: unknown } {
  return JSON.parse(readFileSync(join(dir(), "library", "avatars", avatarId, "avatar.json"), "utf8")) as { descriptor: string; traits: Record<string, unknown>; schemaVersion: number };
}

const setBody = (avatarId: string, body: unknown): unknown => command("avatars.setBody", { avatarId, body });
const edit = (avatarId: string, text: string, expectedText: string = GOOD): unknown => command("avatars.editDescriptor", { avatarId, text, expectedText });
const dismiss = (avatarId: string): unknown => command("avatars.dismissBodyProposal", { avatarId });
const deletePrepare = (avatarId: string): unknown => ({ kind: "control", type: "avatar.deletePrepare", callId: "call-00000001", avatarId, token: "token-00000001" });

/** A gate on the next write of an avatar's manifest: it stops before its rename until `release()`. It fires once, after `arm()`. */
function manifestWriteGate() {
  let armed = false;
  let reach: () => void = () => {};
  let letGo: () => void = () => {};
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const released = new Promise<void>((resolve) => {
    letGo = resolve;
  });
  return {
    arm: () => {
      armed = true;
    },
    reached,
    release: letGo,
    deps: {
      library: {
        testHooks: {
          beforeRename: async (finalPath: string): Promise<void> => {
            if (!armed || !finalPath.endsWith("avatar.json")) return;
            armed = false;
            reach();
            await released;
          },
        },
      },
    },
  };
}

async function started(opts: Parameters<typeof startEngine>[1] = {}) {
  return startEngine(dir(), { net: network(), ...opts });
}

describe("avatars.setBody: the write", () => {
  test("stores the body keys as traits, leaves the descriptor text and the schema version alone, and answers the avatar with its body", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await started();

    const answer = ok(await engine.handle(setBody(avatarId, BODY)));

    expect(answer).toMatchObject({ result: { avatar: { avatarId, body: BODY, descriptor: { age: 25, text: GOOD } } } });
    const file = stored(avatarId);
    expect(file.traits).toMatchObject({ height: "tall", bust: "full", legLength: "long", legShape: "slim", build: "athletic" });
    expect(file.descriptor).toBe(GOOD);
    expect(file.schemaVersion).toBe(2);
  });

  test("keeps the body marks a list on disk", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await started();

    ok(await engine.handle(setBody(avatarId, { bodyMarks: ["tattoo-ankle", "mole-back"] })));

    expect(stored(avatarId).traits.bodyMarks).toEqual(["tattoo-ankle", "mole-back"]);
  });

  test("announces the avatar once, with its body", async () => {
    const avatarId = await seedAvatar();
    const { engine, events } = await started();

    ok(await engine.handle(setBody(avatarId, BODY)));

    const changed = events().filter((e) => e.type === "avatar.changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ payload: { avatar: { avatarId, body: BODY } } });
  });

  test("costs nothing: no request leaves", async () => {
    const avatarId = await seedAvatar();
    const net = network();
    const { engine } = await started({ net });

    ok(await engine.handle(setBody(avatarId, BODY)));

    expect(net.calls).toHaveLength(0);
  });

  test("replaces the whole body: a key left out goes back to «не задано»", async () => {
    const avatarId = await seedAvatar({ body: { height: "tall", bust: "full", figure: "pear", bodyMarks: ["mole-back"] } });
    const { engine } = await started();

    const answer = ok(await engine.handle(setBody(avatarId, { bust: "small" })));

    expect(answer).toMatchObject({ result: { avatar: { body: { bust: "small" } } } });
    const traits = stored(avatarId).traits;
    expect(traits.bust).toBe("small");
    for (const key of ["height", "figure", "bodyMarks"]) expect(key in traits).toBe(false);
  });

  test("an empty body and an empty list of marks clear the body: the summary then carries no body key", async () => {
    const avatarId = await seedAvatar({ body: { height: "tall", bodyMarks: ["mole-back"] } });
    const { engine } = await started();

    const answer = ok(await engine.handle(setBody(avatarId, { bodyMarks: [] })));

    if (answer.type !== "avatars.setBody") throw new Error("wrong type");
    expect("body" in answer.result.avatar).toBe(false);
    expect("bodyMarks" in stored(avatarId).traits).toBe(false);
    expect("height" in stored(avatarId).traits).toBe(false);
  });

  test("clears a stored body proposal in the same write, and the announced avatar no longer carries it", async () => {
    const avatarId = await seedAvatar({ proposal: true });
    const { engine, events } = await started();
    expect(ok(await engine.handle(command("avatars.list")))).toMatchObject({ result: { avatars: [{ bodyProposal: PROPOSAL }] } });

    const answer = ok(await engine.handle(setBody(avatarId, { bust: "full" })));

    if (answer.type !== "avatars.setBody") throw new Error("wrong type");
    expect("bodyProposal" in answer.result.avatar).toBe(false);
    expect("bodyProposal" in stored(avatarId)).toBe(false);
    expect(stored(avatarId).traits.bust).toBe("full");
    expect(events().filter((e) => e.type === "avatar.changed")).toHaveLength(1);
  });

  test("works on an archived avatar and leaves it archived", async () => {
    const avatarId = await seedAvatar({ status: "archived" });
    const { engine } = await started();

    expect(ok(await engine.handle(setBody(avatarId, BODY)))).toMatchObject({ result: { avatar: { status: "archived", body: BODY } } });
  });

  test("the avatar list carries the body, and omits the key for an avatar with none", async () => {
    const withBody = await seedAvatar({ body: BODY });
    const without = await seedAvatar();
    const { engine } = await started();

    const answer = ok(await engine.handle(command("avatars.list")));

    if (answer.type !== "avatars.list") throw new Error("wrong type");
    const byId = new Map(answer.result.avatars.map((a) => [a.avatarId, a]));
    expect(byId.get(withBody)?.body).toEqual(BODY);
    expect("body" in (byId.get(without) ?? {})).toBe(false);
  });
});

describe("avatars.setBody: refusals", () => {
  test("an unknown avatar is NOT_FOUND", async () => {
    const { engine } = await started();
    expect(failed(await engine.handle(setBody("avatar-nope", BODY))).error.code).toBe("NOT_FOUND");
  });

  test("a draft is VALIDATION: its body is chosen in the wizard", async () => {
    const draftId = await seedAvatar({ status: "draft" });
    const { engine } = await started();

    expect(failed(await engine.handle(setBody(draftId, BODY))).error.code).toBe("VALIDATION");
    expect("height" in stored(draftId).traits).toBe(false);
  });

  test("a schema-version-1 record is VALIDATION and stays as it was", async () => {
    const avatarId = await seedAvatar({ schemaVersion: 1 });
    const { engine } = await started();
    const before = readFileSync(join(dir(), "library", "avatars", avatarId, "avatar.json"), "utf8");

    expect(failed(await engine.handle(setBody(avatarId, BODY))).error.code).toBe("VALIDATION");
    expect(readFileSync(join(dir(), "library", "avatars", avatarId, "avatar.json"), "utf8")).toBe(before);
  });

  test.each([
    ["three body marks", { bodyMarks: ["tattoo-ankle", "tattoo-hip", "mole-back"] }],
    ["a repeated body mark", { bodyMarks: ["mole-back", "mole-back"] }],
    ["a value off the list", { height: "giant" }],
    ["an unknown key", { weight: "light" }],
    ["the build word", { build: "slim" }],
    ["null in place of the body", null],
  ])("refuses %s as VALIDATION at the contract and writes nothing", async (_label, body) => {
    const avatarId = await seedAvatar();
    const { engine } = await started();

    expect(failed(await engine.handle(setBody(avatarId, body))).error.code).toBe("VALIDATION");
    expect("height" in stored(avatarId).traits).toBe(false);
    expect("bodyMarks" in stored(avatarId).traits).toBe(false);
  });

  test("a composite of exactly 600 is stored", async () => {
    const text = textOf(600 - 2 - PHRASE.length);
    const avatarId = await seedAvatar({ descriptor: text });
    const { engine } = await started();

    ok(await engine.handle(setBody(avatarId, BODY)));

    expect(stored(avatarId).traits.height).toBe("tall");
  });

  test("a composite of 601 is refused with the Russian reason «вместе длиннее 600» and writes nothing", async () => {
    const text = textOf(600 - 2 - PHRASE.length + 1);
    const avatarId = await seedAvatar({ descriptor: text });
    const { engine, events } = await started();

    const answer = failed(await engine.handle(setBody(avatarId, BODY)));

    expect(answer.error).toMatchObject({ code: "VALIDATION", descriptorReason: "too-long-with-body" });
    expect("height" in stored(avatarId).traits).toBe(false);
    expect(events().filter((e) => e.type === "avatar.changed")).toHaveLength(0);
  });

  test("clearing a body is allowed for a descriptor that has no room for one", async () => {
    const avatarId = await seedAvatar({ descriptor: textOf(600), body: { height: "tall" } });
    const { engine } = await started();

    ok(await engine.handle(setBody(avatarId, {})));

    expect("height" in stored(avatarId).traits).toBe(false);
  });

  test("the validator it hands the library judges the whole contract: a text that now fails the rules refuses the body as «invalid»", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await started();
    const library = engine.library;
    if (library === null) throw new Error("no library");
    const original = library.updateAvatarTraits.bind(library);
    // Stands for a text that stopped fitting the rules between the early check and the write.
    library.updateAvatarTraits = (id, merge, validate, options) => original(id, merge, validate === undefined ? undefined : (next, current) => validate({ ...next, descriptor: "a petite woman" }, current), options);

    const answer = failed(await engine.handle(setBody(avatarId, BODY)));

    expect(answer.error).toMatchObject({ code: "VALIDATION", descriptorReason: "invalid" });
    expect("height" in stored(avatarId).traits).toBe(false);
  });

  test("a rewrite is allowed for a descriptor that fits alone but not with its body (a composite over 600 is not a dead end)", async () => {
    const avatarId = await seedAvatar({ descriptor: textOf(590), body: BODY });
    const net = network({ descriptors: [descriptorReply(GOOD)] });
    const { engine } = await started({ net });

    ok(await engine.handle(command("avatars.estimateRewriteDescriptor", { avatarId })));
    ok(await engine.handle(command("avatars.rewriteDescriptor", { avatarId, acceptedWorstMicros: 1_000_000 })));

    expect(stored(avatarId).descriptor).toBe(GOOD);
    expect(stored(avatarId).traits.height).toBe("tall");
  });

  test("a write that fails answers INTERNAL, keeps the old body and announces nothing", async () => {
    const avatarId = await seedAvatar();
    const { engine, events } = await started();
    const library = engine.library;
    if (library === null) throw new Error("no library");
    library.updateAvatarTraits = async () => {
      throw new Error("disk full");
    };

    expect(failed(await engine.handle(setBody(avatarId, BODY))).error.code).toBe("INTERNAL");
    expect("height" in stored(avatarId).traits).toBe(false);
    expect(events().filter((e) => e.type === "avatar.changed")).toHaveLength(0);
  });
});

describe("avatars.setBody and avatars.editDescriptor judge the composite inside the library's exclusive section", () => {
  test("a body set while an edit's text is on its way: the edit is judged against the body stored by then and refused", async () => {
    const text = textOf(300);
    const avatarId = await seedAvatar({ descriptor: text });
    const gate = manifestWriteGate();
    const { engine } = await started({ deps: gate.deps });
    gate.arm();
    const setting = engine.handle(setBody(avatarId, BODY));
    await gate.reached;
    // The edit's early check reads the manifest as it was (no body yet) and passes at 580; its write queues behind the body write and meets the body there.
    const editing = engine.handle(edit(avatarId, textOf(580, "y"), text));
    gate.release();

    ok(await setting);
    expect(failed(await editing).error).toMatchObject({ code: "VALIDATION", descriptorReason: "too-long-with-body" });
    expect(stored(avatarId).descriptor).toBe(text);
    expect(stored(avatarId).traits.height).toBe("tall");
  });

  test("an edit that lands while a body is on its way: the body is judged against the text stored by then and refused", async () => {
    const text = textOf(300);
    const avatarId = await seedAvatar({ descriptor: text });
    const gate = manifestWriteGate();
    const { engine } = await started({ deps: gate.deps });
    gate.arm();
    const editing = engine.handle(edit(avatarId, textOf(580, "y"), text));
    await gate.reached;
    const setting = engine.handle(setBody(avatarId, BODY));
    gate.release();

    ok(await editing);
    expect(failed(await setting).error).toMatchObject({ code: "VALIDATION", descriptorReason: "too-long-with-body" });
    expect("height" in stored(avatarId).traits).toBe(false);
  });

  test("an edit is refused when the text with the stored body would pass 600, and accepted at exactly 600", async () => {
    const avatarId = await seedAvatar({ body: BODY });
    const { engine } = await started();
    const limit = 600 - 2 - PHRASE.length;

    expect(failed(await engine.handle(edit(avatarId, textOf(limit + 1)))).error).toMatchObject({ descriptorReason: "too-long-with-body" });
    expect(stored(avatarId).descriptor).toBe(GOOD);
    ok(await engine.handle(edit(avatarId, textOf(limit))));
    expect(stored(avatarId).descriptor).toHaveLength(limit);
  });

  test("an edit by an avatar with no body keeps the old limit of 600", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await started();

    ok(await engine.handle(edit(avatarId, textOf(600))));
  });
});

describe("avatars.setBody and avatars.dismissBodyProposal: claims", () => {
  test("setBody is refused IN_FLIGHT while a rewrite holds the avatar, and allowed when it ends", async () => {
    const avatarId = await seedAvatar({ descriptor: "a young woman with hazel eyes" });
    let release: (reply: Reply) => void = () => {};
    const held = new Promise<Reply>((resolve) => {
      release = resolve;
    });
    const net = network({ descriptors: [() => held] });
    const { engine } = await started({ net });
    const rewriting = engine.handle(command("avatars.rewriteDescriptor", { avatarId, acceptedWorstMicros: 1_000_000 }));
    await until(() => net.descriptorCalls().length === 1, "the rewrite's descriptor request");

    expect(failed(await engine.handle(setBody(avatarId, BODY))).error.code).toBe("IN_FLIGHT");
    expect("height" in stored(avatarId).traits).toBe(false);

    release(descriptorReply(GOOD));
    ok(await rewriting);
    ok(await engine.handle(setBody(avatarId, BODY)));
  });

  test("setBody and dismissBodyProposal are refused IN_FLIGHT while a delete is prepared, and allowed once a kept delete gives the avatar back", async () => {
    const avatarId = await seedAvatar({ proposal: true });
    const { engine } = await started();
    await engine.receive(deletePrepare(avatarId));

    expect(failed(await engine.handle(setBody(avatarId, BODY))).error.code).toBe("IN_FLIGHT");
    expect(failed(await engine.handle(dismiss(avatarId))).error.code).toBe("IN_FLIGHT");

    await engine.receive({ kind: "control", type: "avatar.deleteFinish", callId: "call-00000002", avatarId, token: "token-00000001", outcome: "kept" });
    ok(await engine.handle(setBody(avatarId, BODY)));
  });

  test("setBody is refused IN_FLIGHT while an archive holds the avatar, and the archive still lands", async () => {
    const avatarId = await seedAvatar();
    const gate = manifestWriteGate();
    const { engine } = await started({ deps: gate.deps });
    gate.arm();
    const archiving = engine.handle(command("avatars.archive", { avatarId }));
    await gate.reached;

    const refused = await engine.handle(setBody(avatarId, BODY));
    gate.release();
    ok(await archiving);

    expect(failed(refused).error.code).toBe("IN_FLIGHT");
    expect(stored(avatarId).traits.height).toBeUndefined();
  });

  test.each([
    ["setBody", (avatarId: string) => setBody(avatarId, BODY)],
    ["dismissBodyProposal", (avatarId: string) => dismiss(avatarId)],
  ])("a delete prepared while %s's write is in flight is refused IN_FLIGHT, and the avatar stays in the index", async (_name, write) => {
    const avatarId = await seedAvatar({ proposal: true });
    const gate = manifestWriteGate();
    const { engine, posted } = await started({ deps: gate.deps });
    gate.arm();
    const writing = engine.handle(write(avatarId));
    await gate.reached;

    await engine.receive(deletePrepare(avatarId));
    const reply = posted.at(-1);
    gate.release();
    ok(await writing);

    expect(reply).toMatchObject({ kind: "control", type: "reply", callId: "call-00000001", error: { code: "IN_FLIGHT" } });
    expect(ok(await engine.handle(command("avatars.list")))).toMatchObject({ result: { avatars: [{ avatarId }] } });
  });

  test.each([
    ["setBody", (avatarId: string) => setBody(avatarId, BODY)],
    ["dismissBodyProposal", (avatarId: string) => dismiss(avatarId)],
  ])("a library switch is refused while %s's write is in flight", async (_name, write) => {
    const avatarId = await seedAvatar({ proposal: true });
    const gate = manifestWriteGate();
    const { engine, posted } = await started({ deps: gate.deps });
    gate.arm();
    const writing = engine.handle(write(avatarId));
    await gate.reached;

    await engine.receive({ kind: "control", type: "library.open", callId: "call-00000009", path: join(dir(), "other-library") });
    const reply = posted.at(-1);
    gate.release();
    ok(await writing);

    expect(reply).toMatchObject({ kind: "control", type: "reply", callId: "call-00000009", error: { code: "IN_FLIGHT" } });
  });

  test("setBody is allowed while a photo run runs, and the run keeps going", async () => {
    const avatarId = await seedAvatar();
    const net = runNetwork();
    const { engine, events } = await runEngine(net);
    const { runId, jobId } = startedRun(await engine.handle(startRun(avatarId)));
    await until(() => net.imageCalls().length > 0, "the run's first image request");

    ok(await engine.handle(setBody(avatarId, BODY)));

    expect(stored(avatarId).traits.height).toBe("tall");
    expect(events().some((e) => e.type === "job.failed" && "jobId" in e.payload && e.payload.jobId === jobId)).toBe(false);
    ok(await engine.handle(command("runs.cancel", { runId })));
    await jobEnd(events, jobId);
  });
});

describe("avatars.dismissBodyProposal", () => {
  test("clears the stored proposal, leaves the traits and the text alone, and announces the avatar without it", async () => {
    const avatarId = await seedAvatar({ proposal: true, body: { height: "average" } });
    const { engine, events } = await started();

    const answer = ok(await engine.handle(dismiss(avatarId)));

    if (answer.type !== "avatars.dismissBodyProposal") throw new Error("wrong type");
    expect("bodyProposal" in answer.result.avatar).toBe(false);
    expect(answer.result.avatar.body).toEqual({ height: "average" });
    expect("bodyProposal" in stored(avatarId)).toBe(false);
    expect(stored(avatarId).traits.height).toBe("average");
    expect(stored(avatarId).descriptor).toBe(GOOD);
    expect(events().filter((e) => e.type === "avatar.changed")).toHaveLength(1);
  });

  test("with no proposal it answers the avatar as it is and announces nothing", async () => {
    const avatarId = await seedAvatar();
    const { engine, events } = await started();

    expect(ok(await engine.handle(dismiss(avatarId)))).toMatchObject({ result: { avatar: { avatarId } } });
    expect(events().filter((e) => e.type === "avatar.changed")).toHaveLength(0);
  });

  test("a proposal is never a trait: listing an avatar with one shows no body", async () => {
    const avatarId = await seedAvatar({ proposal: true });
    const { engine } = await started();

    const answer = ok(await engine.handle(command("avatars.list")));

    if (answer.type !== "avatars.list") throw new Error("wrong type");
    const avatar = answer.result.avatars.find((a) => a.avatarId === avatarId);
    expect<unknown>(avatar?.bodyProposal).toEqual(PROPOSAL);
    expect("body" in (avatar ?? {})).toBe(false);
  });

  test("an unknown avatar is NOT_FOUND and a draft is VALIDATION", async () => {
    const draftId = await seedAvatar({ status: "draft" });
    const { engine } = await started();

    expect(failed(await engine.handle(dismiss("avatar-nope"))).error.code).toBe("NOT_FOUND");
    expect(failed(await engine.handle(dismiss(draftId))).error.code).toBe("VALIDATION");
  });
});

describe("the descriptor a run carries (promptDescriptorOf)", () => {
  test("the first image prompt carries the body phrase once, after the descriptor text", async () => {
    const avatarId = await seedAvatar({ body: BODY });
    const net = runNetwork();
    const { engine, events } = await runEngine(net);
    const { runId, jobId } = startedRun(await engine.handle(startRun(avatarId)));
    await until(() => net.imageCalls().length > 0, "the first image request");

    const prompt = String(net.imageCalls()[0]?.json().prompt);
    const anchor = `${GOOD.replace(/\.$/, "")}; ${PHRASE}`;
    expect(prompt).toContain(anchor);
    expect(prompt.split(PHRASE)).toHaveLength(2);
    ok(await engine.handle(command("runs.cancel", { runId })));
    await jobEnd(events, jobId);
  });

  test("an avatar with no body keys has no «; » after its descriptor: the prompt is what it was", async () => {
    const avatarId = await seedAvatar();
    const net = runNetwork();
    const { engine, events } = await runEngine(net);
    const { runId, jobId } = startedRun(await engine.handle(startRun(avatarId)));
    await until(() => net.imageCalls().length > 0, "the first image request");

    const prompt = String(net.imageCalls()[0]?.json().prompt);
    expect(prompt).toContain(GOOD.replace(/\.$/, ""));
    expect(prompt).not.toContain(`${GOOD.replace(/\.$/, "")};`);
    ok(await engine.handle(command("runs.cancel", { runId })));
    await jobEnd(events, jobId);
  });

  test("a body set before a run is in its prompt, and a body set after the run started is not (a live job keeps the descriptor it started with)", async () => {
    const avatarId = await seedAvatar();
    let letFirstGo: (reply: Reply) => void = () => {};
    const firstHeld = new Promise<Reply>((resolve) => {
      letFirstGo = resolve;
    });
    const net = runNetwork((n) => (n === 1 ? firstHeld : { hang: true }));
    const { engine, events } = await runEngine(net, 1);
    const { runId, jobId } = startedRun(await engine.handle(startRun(avatarId)));
    await until(() => net.imageCalls().length === 1, "the run's first image request");

    ok(await engine.handle(setBody(avatarId, BODY)));
    letFirstGo({ status: 200, body: imageBody(portraitPng(2), { cost: 0.04 }) });
    await until(() => net.imageCalls().length === 2, "the run's second image request");

    expect(String(net.imageCalls()[1]?.json().prompt)).not.toContain(PHRASE);
    ok(await engine.handle(command("runs.cancel", { runId })));
    await jobEnd(events, jobId);
  });

  test("a body key that fails to parse drops the body, not the avatar: she is listed and her run goes out without a body", async () => {
    const avatarId = await seedAvatar({ body: { height: "tall", bust: "gigantic" } });
    const net = runNetwork();
    const { engine, events } = await runEngine(net);
    const listed = ok(await engine.handle(command("avatars.list")));
    if (listed.type !== "avatars.list") throw new Error("wrong type");
    expect(listed.result.avatars.map((a) => a.avatarId)).toContain(avatarId);
    expect(listed.result.unreadableAvatars).toEqual([]);

    const { runId, jobId } = startedRun(await engine.handle(startRun(avatarId)));
    await until(() => net.imageCalls().length > 0, "the first image request");

    expect(String(net.imageCalls()[0]?.json().prompt)).not.toContain("tall");
    ok(await engine.handle(command("runs.cancel", { runId })));
    await jobEnd(events, jobId);
  });

  test("the run-start readiness check sees the composite: a stored body that leaves no room refuses the run before any spend", async () => {
    const avatarId = await seedAvatar({ descriptor: textOf(590), body: BODY });
    const net = runNetwork();
    const { engine } = await runEngine(net);

    const estimate = failed(await engine.handle(command("runs.estimate", { avatarId, count: 4, categories: ["home"], poses: { profile: false, back: false } })));
    const start = failed(await engine.handle(startRun(avatarId)));

    expect(estimate.error.code).toBe("DESCRIPTOR_INVALID");
    expect(start.error.code).toBe("DESCRIPTOR_INVALID");
    expect(net.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });
});

describe("avatars.createDraft with a body", () => {
  const traits = { ...TRAITS, ...BODY, bodyMarks: ["tattoo-ankle"] } as const;

  test("stores the body keys with the draft, and the descriptor request carries none of them", async () => {
    const net = network({ descriptors: [descriptorReply(GOOD)] });
    const { engine } = await started({ net });

    const response = ok(await engine.handle(command("avatars.createDraft", { traits, acceptedWorstMicros: NEW_AVATAR.worstMicros })));

    if (response.type !== "avatars.createDraft") throw new Error("wrong type");
    expect(response.result.draft.traits).toMatchObject(BODY);
    expect(engine.library?.getAvatar(response.result.draft.avatarId)?.traits).toMatchObject({ height: "tall", bodyMarks: ["tattoo-ankle"] });
    const sent = JSON.stringify(net.descriptorCalls()[0]?.json());
    for (const word of ["tall", "bust", "legs", "tattoo", "bodyMarks"]) expect(sent).not.toContain(word);
  });

  test("an answer with no room for the body phrase is asked for again, and the stored descriptor is the text alone", async () => {
    const phrase = bodyPhrase({ ...BODY, bodyMarks: ["tattoo-ankle"] }) ?? "";
    const tooLong = textOf(600 - 2 - phrase.length + 1);
    const net = network({ descriptors: [descriptorReply(tooLong), descriptorReply(GOOD)] });
    const { engine } = await started({ net });

    const response = ok(await engine.handle(command("avatars.createDraft", { traits, acceptedWorstMicros: NEW_AVATAR.worstMicros })));

    if (response.type !== "avatars.createDraft") throw new Error("wrong type");
    expect(response.result.draft.descriptor).toEqual({ age: 25, text: GOOD });
    expect(net.descriptorCalls()).toHaveLength(2);
    expect(JSON.stringify(net.descriptorCalls()[1]?.json())).toContain(`longer than ${600 - 2 - phrase.length} characters`);
  });

  test("a rewrite of a stored descriptor counts the stored body: an answer with no room for it is asked for again", async () => {
    const phrase = bodyPhrase({ ...BODY, bodyMarks: ["tattoo-ankle"] }) ?? "";
    const avatarId = await seedAvatar({ descriptor: "a young woman with hazel eyes", body: { ...BODY, bodyMarks: ["tattoo-ankle"] } });
    const net = network({ descriptors: [descriptorReply(textOf(600 - 2 - phrase.length + 1)), descriptorReply(GOOD)] });
    const { engine } = await started({ net });

    ok(await engine.handle(command("avatars.rewriteDescriptor", { avatarId, acceptedWorstMicros: 1_000_000 })));

    expect(net.descriptorCalls()).toHaveLength(2);
    expect(stored(avatarId).descriptor).toBe(GOOD);
    expect(stored(avatarId).traits.height).toBe("tall");
    const sent = JSON.stringify(net.descriptorCalls()[0]?.json());
    for (const word of ["bust", "legs", "tattoo", "bodyMarks"]) expect(sent).not.toContain(word);
  });

  test("three body marks are refused at the contract before anything is spent", async () => {
    const net = network({ descriptors: [descriptorReply(GOOD)] });
    const { engine } = await started({ net });

    const answer = failed(await engine.handle(command("avatars.createDraft", { traits: { ...traits, bodyMarks: ["tattoo-ankle", "tattoo-hip", "mole-back"] }, acceptedWorstMicros: NEW_AVATAR.worstMicros })));

    expect(answer.error.code).toBe("VALIDATION");
    expect(net.calls).toHaveLength(0);
  });
});

// ---------- a photo run over a fake OpenRouter whose image requests hang ----------

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

function runNetwork(image: (n: number) => Reply | Promise<Reply> = () => ({ hang: true })) {
  let images = 0;
  const route = async (call: FetchCall): Promise<Reply> => {
    if (call.url.endsWith("/images")) return image(++images);
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

function runEngine(net: ReturnType<typeof runNetwork>, networkConcurrency?: number) {
  return startEngine(dir(), {
    init: { settings: engineSettings(dir(), { imageAgeCheck: "off", ...(networkConcurrency === undefined ? {} : { concurrency: { network: networkConcurrency } }) }) },
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
