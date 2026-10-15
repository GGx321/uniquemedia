import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { MOTION_SUGGEST_EXPECTED_MICROS, MOTION_SUGGEST_WORST_MICROS, MOTION_TRANSLATE_EXPECTED_MICROS, ownIdeaLabel } from "../shared/engine";
import { JPEG } from "./openrouter/testing/fakes";
import { clipsDir, create, jobEnd, jobIdOf } from "./clips/testing/engineClipKit";
import { MODERATED, chatReply, errorOf, resultOf, send, type ChatRequest } from "./clips/testing/motionNet";
import { MOTION_PROMPT_TEXTS } from "./clips/motionPrompts";
import { CANARY, FRAME_READING, GOOD_TEXTS, IDEA, ideaReply, motionWorld, suggestionReply } from "./clips/testing/motionWorld";
import { MotionStoreFile } from "./clips/schemas";
import { readClipRecord } from "./clips/store";
import { engineSettings, useEngineDir, writeLedger } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();
setDefaultTimeout(60_000);

// Stage 5, 5b.2, S5.WC3 (plan s5b2 §5.3, I5.66-I5.68; Q-H = 2): the four part C commands in the real engine, over a real library and a fake OpenRouter whose chat route is scripted. Every refusal is free and
// comes in the contract's order; a paid call is reserved before it is sent and settled by usage.cost; the stored suggestions and ideas are listed by `clips.options` and resolved by `clips.create`.

const dir = useEngineDir("studio-engine-clip-motions-");
const UNREADABLE = chatReply("I cannot see the photo", 0.002);
const NOT_MOTION = "slowly she turns her head";
const UNDRESS = "she slowly takes off her robe";

async function storeOf(path: string): Promise<MotionStoreFile> {
  return MotionStoreFile.parse(JSON.parse(await readFile(path, "utf8")));
}

describe("the contract guards the handlers", () => {
  test("an idea with a newline is VALIDATION", async () => {
    const w = await motionWorld(dir());
    const payload = { avatarId: w.avatarId, photoId: w.photoId, text: "медленно\nповорачивает голову", acceptedWorstMicros: 9_000 };
    expect(errorOf(await send(w.started, "clips.translateIdea", payload)).code).toBe("VALIDATION");
    expect(w.net.chats).toHaveLength(0);
  });

  test("an idea of 301 characters is VALIDATION", async () => {
    const w = await motionWorld(dir());
    const payload = { avatarId: w.avatarId, photoId: w.photoId, text: "я".repeat(301), acceptedWorstMicros: 9_000 };
    expect(errorOf(await send(w.started, "clips.translateIdea", payload)).code).toBe("VALIDATION");
  });
});

describe("the free estimates", () => {
  test("estimateSuggest is the writer's two attempts: the design figure for the expected, and a worst case never below the design figure (a bigger prompt raises it honestly)", async () => {
    const w = await motionWorld(dir());
    const estimate = await w.estimateSuggest();
    expect(estimate).toMatchObject({ expectedMicros: MOTION_SUGGEST_EXPECTED_MICROS, prices: "fallback" });
    expect(estimate.worstMicros).toBeGreaterThanOrEqual(MOTION_SUGGEST_WORST_MICROS);
  });

  test("estimateIdea is the translator's two attempts on a 300-character idea at the most bytes", async () => {
    const w = await motionWorld(dir());
    const estimate = await w.estimateIdea();
    expect(estimate.expectedMicros).toBe(MOTION_TRANSLATE_EXPECTED_MICROS);
    expect(estimate.worstMicros).toBeGreaterThanOrEqual(5_000);
  });

  test("an estimate is free: no key needed, no chat call, no ledger line", async () => {
    const w = await motionWorld(dir(), { engine: { key: null } });
    await w.estimateSuggest();
    await w.estimateIdea();
    expect(w.net.chats).toHaveLength(0);
    expect(w.ledger()).toEqual([]);
  });

  test("NOT_FOUND for a photo or an avatar the library does not have", async () => {
    const w = await motionWorld(dir());
    expect(errorOf(await send(w.started, "clips.estimateSuggest", { avatarId: w.avatarId, photoId: "photo-nope-0001" })).code).toBe("NOT_FOUND");
    expect(errorOf(await send(w.started, "clips.estimateIdea", { avatarId: "avatar-nope-0001", photoId: w.photoId })).code).toBe("NOT_FOUND");
  });

  test("LIBRARY_UNAVAILABLE without an open library", async () => {
    const w = await motionWorld(dir());
    await w.started.engine.receive({ kind: "control", type: "settings.update", settings: engineSettings(dir(), { libraryPath: `${dir()}/does-not-exist` }) });
    expect(errorOf(await send(w.started, "clips.estimateSuggest", { avatarId: w.avatarId, photoId: w.photoId })).code).toBe("LIBRARY_UNAVAILABLE");
  });
});

describe("clips.suggestMotions: the money", () => {
  test("is reserved at one attempt's worst case under <job>:motion#1 and settled at usage.cost, and the result carries the cost", async () => {
    const w = await motionWorld(dir(), { chat: () => suggestionReply(GOOD_TEXTS.slice(0, 3), 0.0034) });
    const estimate = await w.estimateSuggest();
    const result = resultOf(await w.suggest(estimate.worstMicros));
    expect(result).toMatchObject({ outcome: "ok", costMicros: 3_400 });
    const lines = w.ledger();
    expect(lines.map((l) => l.type)).toEqual(["reserve", "settle"]);
    expect(String(lines[0]?.attemptId)).toMatch(/:motion#1$/);
    // The attempt is reserved at what its own message needs: never above half of the price the owner accepted (two attempts), and the cap of the call is that whole price.
    expect(Number(lines[0]?.worstMicros)).toBeGreaterThan(0);
    expect(Number(lines[0]?.worstMicros)).toBeLessThanOrEqual(estimate.worstMicros / 2);
    expect(lines[1]).toMatchObject({ attemptId: lines[0]?.attemptId, costMicros: 3_400, estimated: false });
  });

  test("PRICE_CHANGED when the accepted worst case is below the live estimate: free, nothing sent", async () => {
    const w = await motionWorld(dir(), { chat: () => suggestionReply(GOOD_TEXTS.slice(0, 1)) });
    const estimate = await w.estimateSuggest();
    expect(errorOf(await w.suggest(estimate.worstMicros - 1)).code).toBe("PRICE_CHANGED");
    expect(w.net.chats).toHaveLength(0);
    expect(w.ledger()).toEqual([]);
  });

  test("a lower live price than the accepted worst case passes", async () => {
    const w = await motionWorld(dir(), { chat: () => suggestionReply(GOOD_TEXTS.slice(0, 1)) });
    expect(resultOf(await w.suggest(1_000_000))).toMatchObject({ outcome: "ok" });
  });

  test("BUDGET_EXCEEDED when the month has no room for the worst case: free, nothing sent", async () => {
    const w = await motionWorld(dir(), { chat: () => suggestionReply(GOOD_TEXTS.slice(0, 1)), engine: { monthlyBudgetMicros: MOTION_SUGGEST_WORST_MICROS - 1 } });
    expect(errorOf(await w.suggest(1_000_000)).code).toBe("BUDGET_EXCEEDED");
    expect(w.net.chats).toHaveLength(0);
    expect(w.ledger()).toEqual([]);
  });

  test("AUTH_INVALID without a key: free, nothing sent", async () => {
    const w = await motionWorld(dir(), { engine: { key: null } });
    expect(errorOf(await w.suggest(1_000_000)).code).toBe("AUTH_INVALID");
    expect(w.net.chats).toHaveLength(0);
  });

  test("RECONCILE_REQUIRED while an earlier process's reserve is open: free, nothing sent", async () => {
    const w = await motionWorld(dir(), {
      beforeStart: () => writeLedger(dir(), [{ type: "reserve", attemptId: "old-0001", jobId: "old-0001", scope: { avatarJobId: "old-0001" }, model: "x-ai/grok-4.3", worstMicros: 1000, at: "2026-09-24T11:00:00.000Z" }]),
    });
    expect(errorOf(await w.suggest(1_000_000)).code).toBe("RECONCILE_REQUIRED");
    expect(w.net.chats).toHaveLength(0);
  });

  test("an unusable answer is paid: two unreadable answers are `none` with both costs, two settles, nothing stored", async () => {
    const w = await motionWorld(dir(), { chat: () => UNREADABLE });
    const result = resultOf(await w.suggest());
    expect(result).toEqual({ outcome: "none", costMicros: 4_000 });
    expect(w.net.chats).toHaveLength(2);
    expect(w.ledger().filter((l) => l.type === "settle").map((l) => l.costMicros)).toEqual([2_000, 2_000]);
    await expect(readFile(w.storePath(), "utf8")).rejects.toThrow();
  });

  test("a moderation refusal is free: `none`, cost 0, one chat call, a settle at zero", async () => {
    const w = await motionWorld(dir(), { chat: () => MODERATED });
    expect(resultOf(await w.suggest())).toEqual({ outcome: "none", costMicros: 0 });
    expect(w.net.chats).toHaveLength(1);
    expect(w.ledger().at(-1)).toMatchObject({ type: "settle", costMicros: 0 });
  });

  test("a paid unusable answer then a moderation refusal is `none` and carries the paid amount", async () => {
    const w = await motionWorld(dir(), { chat: (r) => (r.n === 1 ? UNREADABLE : MODERATED) });
    expect(resultOf(await w.suggest())).toEqual({ outcome: "none", costMicros: 2_000 });
  });

  test("two attempts at most: both failing the check is `none`, paid for both, and a third is never sent", async () => {
    const w = await motionWorld(dir(), { chat: () => suggestionReply([NOT_MOTION], 0.003) });
    expect(resultOf(await w.suggest())).toEqual({ outcome: "none", costMicros: 6_000 });
    expect(w.net.chats).toHaveLength(2);
  });

  test("the call's money is closed when it ends: no open reserve, no cap left behind", async () => {
    const w = await motionWorld(dir(), { chat: () => suggestionReply(GOOD_TEXTS.slice(0, 1)) });
    await w.suggest();
    expect(w.started.engine.budget?.status().openReserveMicros).toBe(0);
  });
});

describe("a hung downscale (M1)", () => {
  test("ends the suggestion free and frees the guard: no reserve, and a clip goes through afterwards", async () => {
    const w = await motionWorld(dir(), { engine: { deps: { clipDownscale: () => new Promise<Uint8Array>(() => undefined), clipDownscaleTimeoutMs: 60 } } });
    expect(errorOf(await w.suggest(1_000_000)).clipReason).toBe("photo-unreadable");
    expect(w.net.chats).toHaveLength(0);
    expect(w.ledger()).toEqual([]);
    const jobId = jobIdOf(await create(w.started, { avatarId: w.avatarId, photoId: w.photoId }));
    expect((await jobEnd(w.started, jobId)).type).toBe("job.done");
  });
});

describe("clips.suggestMotions: the photo and the store", () => {
  test("the vision writer sees the photo's downscale at most 1024 px, made from the gallery photo's bytes, never the master's", async () => {
    const seen: { length: number; maxSide: number }[] = [];
    const w = await motionWorld(dir(), {
      chat: () => suggestionReply(GOOD_TEXTS.slice(0, 1)),
      engine: {
        deps: {
          clipDownscale: async (bytes, maxSide) => {
            seen.push({ length: bytes.length, maxSide });
            return JPEG;
          },
        },
      },
    });
    await w.suggest();
    const photo = await w.started.engine.library?.readPhotoVerified(w.photoId);
    const master = await w.started.engine.library?.loadMasterOriginal(w.avatarId);
    expect(seen).toEqual([{ length: photo?.length ?? -1, maxSide: 1024 }]);
    const body = w.net.chats[0]?.body ?? "";
    expect(body).toContain(Buffer.from(JPEG).toString("base64"));
    expect(master === null || master === undefined ? false : body.includes(Buffer.from(master).toString("base64"))).toBe(false);
  });

  test("a good answer is stored under the photo: v-1..v-3 with their labels, the model, and the reading, strict", async () => {
    const w = await motionWorld(dir(), { chat: () => suggestionReply(GOOD_TEXTS.slice(0, 3)) });
    const result = resultOf(await w.suggest());
    expect(result).toMatchObject({
      outcome: "ok",
      reading: { notes: [] },
      motions: [
        { id: "v-1", source: "vision", label: "Движение 1", text: GOOD_TEXTS[0] },
        { id: "v-2", source: "vision", label: "Движение 2", text: GOOD_TEXTS[1] },
        { id: "v-3", source: "vision", label: "Движение 3", text: GOOD_TEXTS[2] },
      ],
    });
    const file = await storeOf(w.storePath());
    expect(file.items.map((i) => [i.id, i.model])).toEqual([
      ["v-1", "x-ai/grok-4.3"],
      ["v-2", "x-ai/grok-4.3"],
      ["v-3", "x-ai/grok-4.3"],
    ]);
    expect(file).toMatchObject({ next: { vision: 4, own: 1 }, reading: { notes: [] }, photoId: w.photoId });
  });

  test("a second suggestion continues the ids and replaces the reading", async () => {
    const w = await motionWorld(dir());
    await w.suggestOk(GOOD_TEXTS.slice(0, 2));
    w.net.setChat(() => suggestionReply(GOOD_TEXTS.slice(2, 3), 0.0034, { ...FRAME_READING, phoneVisible: true }));
    const second = resultOf(await w.suggest());
    expect(second).toMatchObject({ outcome: "ok", motions: [{ id: "v-3" }], reading: { notes: ["second-phone"] } });
    const file = await storeOf(w.storePath());
    expect(file.items.map((i) => i.id)).toEqual(["v-1", "v-2", "v-3"]);
    expect(file.reading).toEqual({ notes: ["second-phone"] });
  });

  test("the store keeps twelve (FIFO) and an id is never reused", async () => {
    const w = await motionWorld(dir());
    for (let n = 0; n < 5; n++) await w.suggestOk(GOOD_TEXTS.slice(0, 3));
    const file = await storeOf(w.storePath());
    expect(file.items).toHaveLength(12);
    expect(file.items[0]?.id).toBe("v-4");
    expect(file.next.vision).toBe(16);
  });

  test("the store is `motions-full` once every v- id is issued: VALIDATION, free, nothing sent", async () => {
    const w = await motionWorld(dir(), { chat: () => suggestionReply(GOOD_TEXTS.slice(0, 1)) });
    const sha = w.started.engine.library?.getPhoto(w.photoId)?.sha256 ?? "";
    await w.writeStore({ schemaVersion: 1, photoId: w.photoId, photoSha256: sha, next: { vision: 1000, own: 1 }, items: [] });
    expect(errorOf(await w.suggest()).clipReason).toBe("motions-full");
    expect(w.net.chats).toHaveLength(0);
    expect(w.ledger()).toEqual([]);
    // the other source is not full
    w.net.setChat(() => ideaReply(GOOD_TEXTS[0] ?? ""));
    expect(resultOf(await w.translate())).toMatchObject({ outcome: "ok" });
  });

  test("a frame of «Смелая» while bold clips are off: VALIDATION `bold-off`, free, for both calls", async () => {
    const w = await motionWorld(dir(), { seed: { category: "nightwear" }, engine: { deps: { clipSwitches: { boldClips: "off" } } } });
    expect(errorOf(await w.suggest(1_000_000)).clipReason).toBe("bold-off");
    expect(errorOf(await w.translate(IDEA, 1_000_000)).clipReason).toBe("bold-off");
    expect(w.net.chats).toHaveLength(0);
    expect(w.ledger()).toEqual([]);
  });

  test("the master portrait is VALIDATION `not-a-gallery-photo`; an unknown photo is NOT_FOUND; both free", async () => {
    const w = await motionWorld(dir());
    expect(errorOf(await send(w.started, "clips.suggestMotions", { avatarId: w.avatarId, photoId: w.masterId, acceptedWorstMicros: 1_000_000 })).clipReason).toBe("not-a-gallery-photo");
    expect(errorOf(await send(w.started, "clips.suggestMotions", { avatarId: w.avatarId, photoId: "photo-nope-0001", acceptedWorstMicros: 1_000_000 })).code).toBe("NOT_FOUND");
    expect(w.net.chats).toHaveLength(0);
  });

  test("a photo the age check did not call adult is VALIDATION `age-unverified`, free", async () => {
    const w = await motionWorld(dir(), { seed: { qa: { faceCos: 0.7, age: { adult: false, confidence: 0.9 } } } });
    expect(errorOf(await w.suggest(1_000_000)).clipReason).toBe("age-unverified");
  });
});

describe("clips.translateIdea", () => {
  test("is reserved under <job>:idea#1 and settled at usage.cost; the item is o-1 with the label the engine cut from his words and the English text", async () => {
    const w = await motionWorld(dir(), { chat: () => ideaReply(GOOD_TEXTS[0] ?? "", 0.001) });
    const result = resultOf(await w.translate());
    expect(result).toEqual({ outcome: "ok", item: { id: "o-1", source: "own", label: ownIdeaLabel(IDEA), text: GOOD_TEXTS[0] }, costMicros: 1_000 });
    expect(ownIdeaLabel(IDEA).length).toBeLessThanOrEqual(40);
    expect(ownIdeaLabel(IDEA)).not.toContain(CANARY);
    const lines = w.ledger();
    expect(String(lines[0]?.attemptId)).toMatch(/:idea#1$/);
    expect(lines[1]).toMatchObject({ type: "settle", costMicros: 1_000 });
  });

  test("the store keeps the label and the English text, never the idea", async () => {
    const w = await motionWorld(dir(), { chat: () => ideaReply(GOOD_TEXTS[0] ?? "") });
    await w.translate();
    const text = await readFile(w.storePath(), "utf8");
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain(IDEA);
    const file = await storeOf(w.storePath());
    expect(file.items).toEqual([expect.objectContaining({ id: "o-1", source: "own", label: ownIdeaLabel(IDEA), text: GOOD_TEXTS[0] })]);
    expect(file.next).toEqual({ vision: 1, own: 2 });
  });

  test("an idea that fails the checks after the repair is `rejected` with the closed problems, paid for both attempts, nothing stored", async () => {
    const w = await motionWorld(dir(), { chat: () => ideaReply(NOT_MOTION, 0.001) });
    const result = resultOf(await w.translate());
    expect(result).toMatchObject({ outcome: "rejected", costMicros: 2_000 });
    expect(Array.isArray((result as { problems: unknown }).problems)).toBe(true);
    expect(w.net.chats).toHaveLength(2);
    await expect(readFile(w.storePath(), "utf8")).rejects.toThrow();
  });

  test("an idea that takes clothing off on an ordinary frame is `rejected` with takes-off at once: one chat call", async () => {
    const w = await motionWorld(dir(), { chat: () => ideaReply(UNDRESS) });
    const result = resultOf(await w.translate());
    expect(result).toMatchObject({ outcome: "rejected", costMicros: 1_000 });
    expect((result as { problems: string[] }).problems).toContain("takes-off");
    expect(w.net.chats).toHaveLength(1);
  });

  test("the same idea on a frame of «Смелая» is accepted (Q-H = 2)", async () => {
    const w = await motionWorld(dir(), { chat: () => ideaReply(UNDRESS), seed: { category: "nightwear" }, engine: { deps: { clipSwitches: { boldClips: "kling-only" } } } });
    expect(resultOf(await w.translate())).toMatchObject({ outcome: "ok", item: { id: "o-1", text: UNDRESS } });
  });

  test("«снимает халат» on a frame of «Смелая» is translated faithfully by the bold prompt and stored under his label with the TAKES_OFF English text (M2)", async () => {
    // A model that does what its system prompt says: the bold variant translates the idea, the ordinary one softens it.
    const chat = (request: ChatRequest) => ideaReply(request.json().messages[0]?.content === MOTION_PROMPT_TEXTS.translatorSystemBold ? UNDRESS : GOOD_TEXTS[0] ?? "");
    const w = await motionWorld(dir(), { chat, seed: { category: "nightwear" }, engine: { deps: { clipSwitches: { boldClips: "kling-only" } } } });
    expect(resultOf(await w.translate("снимает халат"))).toEqual({ outcome: "ok", item: { id: "o-1", source: "own", label: "снимает халат", text: UNDRESS }, costMicros: 1_000 });
    const file = await storeOf(w.storePath());
    expect(file.items).toEqual([expect.objectContaining({ label: "снимает халат", text: UNDRESS })]);
  });

  test("on an ordinary frame the same idea gets the ordinary prompt and is not stored", async () => {
    const chat = (request: ChatRequest) => ideaReply(request.json().messages[0]?.content === MOTION_PROMPT_TEXTS.translatorSystemBold ? UNDRESS : GOOD_TEXTS[0] ?? "");
    const w = await motionWorld(dir(), { chat });
    expect(resultOf(await w.translate("снимает халат"))).toMatchObject({ outcome: "ok", item: { text: GOOD_TEXTS[0] } });
    expect(w.net.chats[0]?.json().messages[0]?.content).toBe(MOTION_PROMPT_TEXTS.translatorSystem);
  });

  test("a moderation refusal is free", async () => {
    const w = await motionWorld(dir(), { chat: () => MODERATED });
    expect(resultOf(await w.translate())).toEqual({ outcome: "none", costMicros: 0 });
  });

  test("ids count on: the next idea is o-2", async () => {
    const w = await motionWorld(dir());
    await w.translateOk(GOOD_TEXTS[0] ?? "");
    const second = await w.translateOk(GOOD_TEXTS[1] ?? "");
    expect(second).toMatchObject({ outcome: "ok", item: { id: "o-2" } });
  });
});

describe("clips.options and the clip commands resolve the stored motions", () => {
  async function filled() {
    const w = await motionWorld(dir());
    await w.suggestOk(GOOD_TEXTS.slice(0, 3));
    await w.suggestOk(GOOD_TEXTS.slice(3, 5));
    await w.translateOk(GOOD_TEXTS[0] ?? "", "первая идея");
    await w.translateOk(GOOD_TEXTS[1] ?? "", "вторая идея");
    await w.translateOk(GOOD_TEXTS[2] ?? "", "третья идея");
    return w;
  }

  test("lists the newest three suggestions and the newest two ideas after the code motions, with the reading, and makes no chat call", async () => {
    const w = await filled();
    const before = w.net.chats.length;
    const listed = await w.options();
    expect(listed.suitable && listed.motions.map((m) => m.id)).toEqual(["g-blink", "g-tilt", "g-breath", "v-3", "v-4", "v-5", "o-2", "o-3"]);
    expect(listed.suitable && listed.reading).toEqual({ notes: [] });
    expect(w.net.chats).toHaveLength(before);
  });

  test("checks the stored items again: one edited into a text that no longer passes is not listed, and an older one takes its place", async () => {
    const w = await filled();
    const file = await storeOf(w.storePath());
    await w.writeStore({ ...file, items: file.items.map((item) => (item.id === "v-5" ? { ...item, text: UNDRESS } : item)) });
    const listed = await w.options();
    expect(listed.suitable && listed.motions.filter((m) => m.source === "vision").map((m) => m.id)).toEqual(["v-2", "v-3", "v-4"]);
  });

  test("a changed photo sha256 empties the listing and the reading", async () => {
    const w = await filled();
    const file = await storeOf(w.storePath());
    await w.writeStore({ ...file, photoSha256: "f".repeat(64) });
    const listed = await w.options();
    expect(listed.suitable && listed.motions.map((m) => m.id)).toEqual(["g-blink", "g-tilt", "g-breath"]);
    expect(listed.suitable && listed.reading).toBeUndefined();
  });

  test("clips.create with a v- id makes the clip with that text; its record says `vision`, with the label", async () => {
    const w = await filled();
    const jobId = jobIdOf(await create(w.started, { avatarId: w.avatarId, photoId: w.photoId, motionId: "v-4" }));
    expect((await jobEnd(w.started, jobId)).type).toBe("job.done");
    const record = await readClipRecord(clipsDir(w.libraryDir, w.avatarId), jobId);
    expect(record.kind === "record" && record.record.motion).toEqual({ source: "vision", label: "Движение 1", text: GOOD_TEXTS[3] });
    const prompt = (JSON.parse(w.net.posts("kling")[0]?.body ?? "{}") as { prompt: string }).prompt;
    expect(prompt).toContain(GOOD_TEXTS[3] ?? "?");
  });

  test("clips.create with an o- id makes the clip with that text; its record says `own`, with the label cut from his words", async () => {
    const w = await filled();
    const jobId = jobIdOf(await create(w.started, { avatarId: w.avatarId, photoId: w.photoId, motionId: "o-3" }));
    expect((await jobEnd(w.started, jobId)).type).toBe("job.done");
    const record = await readClipRecord(clipsDir(w.libraryDir, w.avatarId), jobId);
    expect(record.kind === "record" && record.record.motion).toEqual({ source: "own", label: "третья идея", text: GOOD_TEXTS[2] });
  });

  test("an id the photo does not offer is VALIDATION `unknown-motion`, free: one beyond the newest three, one never issued, one from an empty store", async () => {
    const w = await filled();
    for (const motionId of ["v-1", "v-9", "o-1", "o-9"]) {
      const refused = errorOf(await create(w.started, { avatarId: w.avatarId, photoId: w.photoId, motionId }));
      expect([motionId, refused.code, refused.clipReason]).toEqual([motionId, "VALIDATION", "unknown-motion"]);
    }
    expect(w.ledger().filter((l) => String(l.attemptId).includes("video"))).toEqual([]);
  });

  test("an id from an empty store is `unknown-motion` too", async () => {
    const w = await motionWorld(dir());
    for (const motionId of ["v-1", "o-1"]) expect(errorOf(await create(w.started, { avatarId: w.avatarId, photoId: w.photoId, motionId })).clipReason).toBe("unknown-motion");
  });

  test("clips.createBatch resolves v- and o- ids the same way, and an unknown id is that item's own `unknown-motion`", async () => {
    const w = await filled();
    const payload = (motionId: string) => ({ avatarId: w.avatarId, items: [{ photoId: w.photoId, motionId }], quality: "std", seconds: 5, fallback: "auto", acceptedWorstMicros: 850_000 });
    const refused = errorOf(await send(w.started, "clips.createBatch", payload("v-1")));
    expect(refused).toMatchObject({ code: "VALIDATION", clipReason: "unknown-motion", path: ["items", 0] });
    const made = resultOf(await send(w.started, "clips.createBatch", payload("o-2"))) as { jobIds: string[] };
    expect((await jobEnd(w.started, made.jobIds[0] ?? "")).type).toBe("job.done");
    const record = await readClipRecord(clipsDir(w.libraryDir, w.avatarId), made.jobIds[0] ?? "");
    expect(record.kind === "record" && record.record.motion).toMatchObject({ source: "own", label: "вторая идея", text: GOOD_TEXTS[1] });
  });
});

describe("an own idea that takes clothing off goes to Kling alone (Q-H = 2)", () => {
  async function undressWorld(engine: NonNullable<Parameters<typeof motionWorld>[1]>["engine"]) {
    const w = await motionWorld(dir(), { chat: () => ideaReply(UNDRESS), seed: { category: "nightwear" }, engine });
    expect(resultOf(await w.translate())).toMatchObject({ outcome: "ok" });
    return w;
  }

  test("with BOLD_CLIPS `with-fallback` and an automatic fallback the clip runs on Kling alone: no Grok request, the request says fallback none", async () => {
    const w = await undressWorld({ deps: { clipSwitches: { boldClips: "with-fallback" } } });
    const jobId = jobIdOf(await create(w.started, { avatarId: w.avatarId, photoId: w.photoId, motionId: "o-1", fallback: "auto", acceptedWorstMicros: 504_000 }));
    expect((await jobEnd(w.started, jobId)).type).toBe("job.done");
    expect(w.net.posts("grok")).toHaveLength(0);
    const record = await readClipRecord(clipsDir(w.libraryDir, w.avatarId), jobId);
    expect(record.kind === "record" && record.record.request.fallback).toBe("none");
  });

  test("a Grok clip for it is refused `grok-not-offered` even in mode `offer`", async () => {
    const w = await undressWorld({ deps: { clipSwitches: { boldClips: "with-fallback", mode: "offer" } } });
    const refused = errorOf(await create(w.started, { avatarId: w.avatarId, photoId: w.photoId, motionId: "o-1", model: "grok", fallback: "none", acceptedWorstMicros: 850_000 }));
    expect(refused).toMatchObject({ code: "VALIDATION", clipReason: "grok-not-offered" });
  });

  test("the prompt carries «Nothing new appears.» and no clothing clause", async () => {
    const w = await undressWorld({ deps: { clipSwitches: { boldClips: "kling-only" } } });
    const jobId = jobIdOf(await create(w.started, { avatarId: w.avatarId, photoId: w.photoId, motionId: "o-1", fallback: "none", acceptedWorstMicros: 504_000 }));
    await jobEnd(w.started, jobId);
    const prompt = (JSON.parse(w.net.posts("kling")[0]?.body ?? "{}") as { prompt: string }).prompt;
    expect(prompt).toContain("Nothing new appears.");
    expect(prompt).not.toContain("nothing she wears comes off");
  });
});
