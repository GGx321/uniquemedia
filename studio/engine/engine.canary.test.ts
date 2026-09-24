import { describe, expect, test } from "bun:test";
import type { AvatarTraits } from "../shared/engine";
import type { FetchCall } from "./openrouter/testing/fakes";
import {
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
  schemaName,
  startEngine,
  TRAITS,
  useEngineDir,
} from "./testing/engineHarness";

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
});
