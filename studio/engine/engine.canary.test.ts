import { describe, expect, test } from "bun:test";
import type { AvatarTraits } from "../shared/engine";
import { chatBody, type FetchCall, type Reply } from "./openrouter/testing/fakes";
import {
  ageReply,
  command,
  descriptorReply,
  generate,
  GOOD,
  jobEnd,
  jobIdOf,
  ledgerLines,
  network,
  NEW_AVATAR,
  ok,
  portraitPng,
  schemaName,
  seedDraft,
  startEngine,
  TRAITS,
  useEngineDir,
} from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Mandatory before the first paid image call (plan T6a-2b, item 2): a
// network-level canary. The vibe feeds the descriptor LLM only; the AST rule
// in prompts.test.ts cannot see a leak through `JSON.stringify(traits)`, a
// spread or a computed key. So every paid job runs here with a marker vibe,
// and no request that reaches the (fake) network may carry any of its words,
// except the `:descriptor#N` attempts — which must, or the scan proves nothing.
//
// Limitation: the scan finds the words only as plain text in the URL, the
// headers or the body (any letter case). A leak that transforms them first —
// base64 (e.g. inside an image or a data URL), a hash, an encoding, a
// translation, or a paraphrase by a model — is not caught here; the
// structural rule in avatars/prompts.test.ts and review remain the guard for those.

const dir = useEngineDir("studio-engine-canary-");

const MARKER_WORDS = ["zebra", "lantern", "marmalade"];
const MARKED: AvatarTraits = { ...TRAITS, vibe: MARKER_WORDS.join(" ") };

/** Whether any marker word is anywhere in the request: URL, headers or body, in any letter case. */
function carriesMarker(call: FetchCall): boolean {
  const text = `${call.url}\n${JSON.stringify(call.headers)}\n${call.body ?? ""}`.toLowerCase();
  return MARKER_WORDS.some((word) => text.includes(word));
}

function descriptorAttempts(): string[] {
  return ledgerLines(dir()).flatMap((l) => (l.type === "reserve" && /:descriptor#\d+$/.test(String(l.attemptId)) ? [String(l.attemptId)] : []));
}

async function createMarkedDraft(engine: Awaited<ReturnType<typeof startEngine>>["engine"]): Promise<string> {
  const answer = ok(await engine.handle(command("avatars.createDraft", { traits: MARKED, acceptedWorstMicros: NEW_AVATAR.worstMicros })));
  if (answer.type !== "avatars.createDraft") throw new Error("wrong type");
  return answer.result.draft.avatarId;
}

describe("the vibe never leaves the engine except in the descriptor attempts", () => {
  test("avatars.createDraft: only its descriptor attempts carry it, a rejected answer's retry included", async () => {
    const net = network({ descriptors: [descriptorReply("25-year-old European girl, hazel eyes."), descriptorReply(GOOD)] });
    const { engine } = await startEngine(dir(), { net });

    await createMarkedDraft(engine);

    const carrying = net.calls.filter(carriesMarker);
    expect(descriptorAttempts()).toHaveLength(2);
    expect(carrying).toHaveLength(descriptorAttempts().length);
    expect(carrying.every((call) => schemaName(call) === "avatar_descriptor")).toBe(true);
  });

  test("avatars.generateCandidates, the first batch and four more: no image request and no age check carries it", async () => {
    const net = network({ descriptors: [descriptorReply(GOOD)] });
    const { engine, events } = await startEngine(dir(), { net });
    const draftId = await createMarkedDraft(engine);

    for (let batch = 0; batch < 2; batch++) {
      const end = await jobEnd(events, jobIdOf(await engine.handle(generate(draftId))));
      expect(end.type).toBe("job.done");
    }

    expect([net.imageCalls().length, net.ageCalls().length]).toEqual([8, 8]);
    const carrying = net.calls.filter(carriesMarker);
    expect(carrying).toHaveLength(descriptorAttempts().length);
    expect(carrying.every((call) => schemaName(call) === "avatar_descriptor")).toBe(true);
    expect([...net.imageCalls(), ...net.ageCalls()].filter(carriesMarker)).toEqual([]);
  });

  test("avatars.rewriteDescriptor: only its descriptor attempt carries it, a rejected answer's retry included", async () => {
    const { draftId } = await seedDraft(dir(), { traits: MARKED, descriptor: "a young woman with hazel eyes" });
    const net = network({ descriptors: [descriptorReply("25-year-old European girl, hazel eyes."), descriptorReply(GOOD)] });
    const { engine } = await startEngine(dir(), { net });

    const estimate = ok(await engine.handle(command("avatars.estimateRewriteDescriptor", { avatarId: draftId })));
    if (estimate.type !== "avatars.estimateRewriteDescriptor") throw new Error("wrong type");
    ok(await engine.handle(command("avatars.rewriteDescriptor", { avatarId: draftId, acceptedWorstMicros: estimate.result.worstMicros })));

    const carrying = net.calls.filter(carriesMarker);
    expect(descriptorAttempts()).toHaveLength(2);
    expect(carrying).toHaveLength(descriptorAttempts().length);
    expect(carrying.every((call) => schemaName(call) === "avatar_descriptor")).toBe(true);
  });
});

// T6c: an imported avatar has no owner-authored vibe at all (her traits come
// from the vision call, not from the wizard) — the only owner-entered text in
// the whole import flow is the display name, collected before the paid
// command and never sent to any model. This canary proves that directly:
// nothing about the request bodies of a marker-named import carries the name.
describe("avatars.importAvatar: the owner's name never leaves the engine", () => {
  const dir2 = useEngineDir("studio-engine-canary-import-");
  const MARKER_NAME = "zebra-lantern-marmalade";

  function importDescribeReply(overrides: Record<string, unknown> = {}, cost = 0.0021): Reply {
    const answer = {
      people: 1,
      woman: true,
      age: 25,
      ethnicity: "european",
      skinTone: "light-olive",
      hairColor: "chestnut",
      hairLength: "shoulder",
      hairTexture: "wavy",
      eyeColor: "hazel",
      build: "athletic",
      marks: ["freckles"],
      descriptor: GOOD,
      ...overrides,
    };
    return { status: 200, body: chatBody(JSON.stringify(answer), { cost }) };
  }

  test("the age check and the describe call never carry the owner-entered name, marker-named import included", async () => {
    const net = network({ age: () => ageReply(true, 0.93), descriptors: [importDescribeReply()] });
    const { engine, posted } = await startEngine(dir2(), { net });
    const callId = "call-canary-0001";
    // H3: a realistic-sized fixture, not a degenerate 1×1 PNG — ffmpeg's real
    // downscale exits non-zero on a 1×1 input on Windows CI (exit 5/116).
    await engine.receive({ kind: "control", type: "import.stagePhoto", callId, bytes: portraitPng() });
    const reply = posted.find(
      (m) => typeof m === "object" && m !== null && "kind" in m && m.kind === "control" && "type" in m && m.type === "reply" && "callId" in m && m.callId === callId,
    ) as { stage?: { stagingId: string } } | undefined;
    const stagingId = reply?.stage?.stagingId;
    if (stagingId === undefined) throw new Error("staging failed");

    const estimate = ok(await engine.handle(command("avatars.estimateImport", { stagingId })));
    if (estimate.type !== "avatars.estimateImport") throw new Error("wrong type");
    const response = await engine.handle(command("avatars.importAvatar", { stagingId, name: MARKER_NAME, confirmedAiPersona: true, acceptedWorstMicros: estimate.result.worstMicros }));

    // L2: the canary proves nothing if the import itself silently failed —
    // it must actually reach the describe call for the "never carries it" check below to mean anything.
    expect(ok(response).ok).toBe(true);
    expect(net.calls.filter((c) => c.url.endsWith("/chat/completions") && schemaName(c) === "import_describe")).toHaveLength(1);

    const marker = MARKER_NAME.toLowerCase();
    const carrying = net.calls.filter((call) => `${call.url}\n${JSON.stringify(call.headers)}\n${call.body ?? ""}`.toLowerCase().includes(marker));
    expect(carrying).toEqual([]);
  });
});
