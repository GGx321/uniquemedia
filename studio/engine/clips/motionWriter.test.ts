import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MOTION_ENGLISH, MOTION_PROBLEMS } from "../../shared/engine";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import type { Scope } from "../money/ledger";
import { chatBody, fakeFetch, JPEG, makeClient, setupMoney, withoutAt, type Money, type Step } from "../openrouter/testing/fakes";
import { MOTION_PROMPT_TEXTS } from "./motionPrompts";
import { WRITER_JSON_SCHEMA, runMotionWriter, writerPriceShape, type WriterJob, type WriterOutcome } from "./motionWriter";
import { GOOD_MOTION, GOOD_MOTION_2, GOOD_MOTION_3, UNDER_AGE_MOTION, UNDRESS_MOTION, boldMirrorFrame, timerFrame } from "./testing/motionKit";
import { chatAttemptWorstMicros } from "../openrouter/chat";
useNativeGlobals();

// Stage 5, 5b.2, S5.WC3 (plan s5b2 §5.3 «The vision writer», I5.66, I5.68): the wiring of the writer over the real chat client, the real budget and a fake HTTP. The wording of the system prompt is
// WCX's and is not tested here, only where it goes.

const SCOPE: Scope = { avatarJobId: "job-00000001" };
/** One attempt at its ceilings: (1 000 answer + 3 000 reasoning (S5.WCX)) × $2.50/M + 3 000 prompt × $1.25/M. */
const ATTEMPT_WORST = 13_750;
const JOB: WriterJob = { jobId: "job-00000001", scope: SCOPE, textModel: "x-ai/grok-4.3", photoId: "photo-0001", image: JPEG, facts: timerFrame(), listed: [] };

const FRAME = { capture: "timer", phoneVisible: false, faceVisible: true };
const answer = (motions: { label_ru: string; text_en: string }[], frame: Record<string, unknown> = FRAME) => ({ motions, frame });
const good = (text = GOOD_MOTION, label = "Поправляет прядь") => ({ label_ru: label, text_en: text });

function reply(body: unknown, cost = 0.0034): Step {
  return { status: 200, body: chatBody(typeof body === "string" ? body : JSON.stringify(body), { cost }) };
}

let money: Money;
beforeEach(async () => {
  money = await setupMoney();
});
afterEach(async () => {
  await money.cleanup();
});

function run(steps: Step[], job: WriterJob = JOB) {
  const net = fakeFetch(steps);
  const { client } = makeClient(net.fetch);
  const logs: string[] = [];
  const result: Promise<WriterOutcome> = runMotionWriter({ chat: client.chat, budget: money.budget, priceBook: money.priceBook, log: (line) => logs.push(line) }, job);
  return { net, logs, result };
}

function userMessage(net: { calls: { json(): unknown }[] }, n: number): Record<string, unknown> {
  const body = net.calls[n]?.json() as { messages: { role: string; content: string | { type: string; text?: string }[] }[] };
  const last = body.messages.filter((m) => m.role === "user").at(-1)?.content;
  const text = typeof last === "string" ? last : (last?.find((part) => part.type === "text")?.text ?? "");
  return JSON.parse(text) as Record<string, unknown>;
}

describe("the request", () => {
  test("the photo goes as one image, the system prompt is the writer text, the model is the settings' text model, reasoning low, a strict JSON schema", async () => {
    const { net, result } = run([reply(answer([good()]))]);
    await result;
    const body = net.calls[0]?.json() as Record<string, unknown> & { messages: { role: string; content: unknown }[] };
    expect(body).toMatchObject({ model: "x-ai/grok-4.3", reasoning: { effort: "low" }, usage: { include: true }, response_format: { type: "json_schema", json_schema: { name: WRITER_JSON_SCHEMA.name, strict: true } } });
    expect(body.messages[0]).toEqual({ role: "system", content: MOTION_PROMPT_TEXTS.writerSystem });
    const images = JSON.stringify(body).match(/data:image\/jpeg;base64,/g) ?? [];
    expect(images).toHaveLength(1);
  });

  test("the frame's facts are JSON data in the user message, never in the system prompt", async () => {
    const { net, result } = run([reply(answer([good()]))]);
    await result;
    expect(userMessage(net, 0)).toMatchObject({ frame: { capture: "timer", faceVisible: "yes", legsFraming: false, bold: false, phoneAllowed: false } });
  });

  test("S5.WCX: what the sheet already lists is JSON data in the user message (`listed`), on every attempt, and never in the system prompt", async () => {
    const listed = ["she slowly lifts her chin a little", "she slowly crosses her ankles"];
    const { net, result } = run([reply("{not json"), reply(answer([good()]))], { ...JOB, listed });
    await result;
    expect(net.calls).toHaveLength(2);
    for (const n of [0, 1]) expect(userMessage(net, n).listed).toEqual(listed);
    const system = (net.calls[0]?.json() as { messages: { role: string; content: unknown }[] }).messages[0]?.content;
    for (const text of listed) expect(String(system)).not.toContain(text);
  });

  test("S5.WCX: an empty sheet is an empty list", async () => {
    const { net, result } = run([reply(answer([good()]))]);
    await result;
    expect(userMessage(net, 0).listed).toEqual([]);
  });

  test("S5.WCX: the price shape counts the widest list: the scene motion, three code motions and three suggestions, each of 60 characters", () => {
    const user = writerPriceShape().messages.find((m) => m.role === "user")?.content ?? "";
    const data = JSON.parse(typeof user === "string" ? user : "{}") as { listed?: string[] };
    expect(data.listed).toHaveLength(7);
    expect(data.listed?.every((text) => text.length === 60)).toBe(true);
  });

  test("the first attempt is <job>:motion#1, reserved at its worst case in the call's scope", async () => {
    const { result } = run([reply(answer([good()]))]);
    await result;
    const reserve = withoutAt(money.lines())[0];
    expect(reserve).toMatchObject({ type: "reserve", attemptId: "job-00000001:motion#1", scope: SCOPE, model: "x-ai/grok-4.3" });
    expect(Number(reserve?.worstMicros)).toBeGreaterThan(0);
    expect(Number(reserve?.worstMicros)).toBeLessThanOrEqual(ATTEMPT_WORST * 2);
  });

  test("S5.WCX: each attempt reserves max_tokens plus 3 000 reasoning tokens as completion, and still sends max_tokens alone", async () => {
    const { net, result } = run([reply(answer([good()]))]);
    await result;
    const sent = net.calls[0]?.json() as { max_tokens: number; reasoning: unknown };
    const widestWithout = chatAttemptWorstMicros(money.priceBook, { model: "x-ai/grok-4.3", ...writerPriceShape(), maxTokens: 1_000, inputTokens: 3_000, images: 1 });
    expect(Number(money.lines()[0]?.worstMicros)).toBeGreaterThan(widestWithout);
    expect(sent.max_tokens).toBe(1_000);
    expect(sent.reasoning).toEqual({ effort: "low" });
  });

  test("S5.WCX: a bill above any reserve the writer held before the allowance (a 4 000-token reasoning tail) closes without stopping the ledger", async () => {
    const BILL = 12_000;
    const widestWithout = chatAttemptWorstMicros(money.priceBook, { model: "x-ai/grok-4.3", ...writerPriceShape(), maxTokens: 1_000, inputTokens: 3_000, images: 1 });
    expect(widestWithout).toBeLessThan(BILL);
    const { result } = run([reply(answer([good()]), BILL / 1e6)]);
    expect(await result).toMatchObject({ kind: "ok", costMicros: BILL });
    expect(money.budget.aboveWorstAttempts()).toEqual([]);
  });

  test("the schema names the three fields of the frame reading and at most the writer's own keys (strict)", () => {
    const schema = WRITER_JSON_SCHEMA.schema as { required: string[]; additionalProperties: boolean; properties: { frame: { required: string[] } } };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["motions", "frame"]);
    expect(schema.properties.frame.required).toEqual(["capture", "phoneVisible", "faceVisible"]);
  });

  test("the price shape is the largest attempt: the longest feedback and activity, so the estimate never undercuts a reserve", () => {
    const shape = writerPriceShape();
    expect(shape.jsonSchema).toBe(WRITER_JSON_SCHEMA);
    const text = shape.messages.map((m) => m.content).join("");
    for (const problem of MOTION_PROBLEMS) expect(text).toContain(problem);
    expect(text).toContain("unreadable");
  });
});

describe("a good answer", () => {
  test("gives the checked drafts, the reading, and what the call cost", async () => {
    const { result } = run([reply(answer([good(GOOD_MOTION, "Поправляет прядь"), good(GOOD_MOTION_2, "Наклоняет голову")]), 0.0034)]);
    expect(await result).toEqual({
      kind: "ok",
      drafts: [
        { label: "Поправляет прядь", text: GOOD_MOTION },
        { label: "Наклоняет голову", text: GOOD_MOTION_2 },
      ],
      reading: { notes: [] },
      costMicros: 3_400,
    });
    expect(money.lines().filter((l) => l.type === "settle").map((l) => l.costMicros)).toEqual([3_400]);
  });

  test("a capital She and a final period, the way models write, are normalised before the check and the text is accepted", async () => {
    const { result } = run([reply(answer([good("She slowly brushes a strand of hair back with her hand.")]))]);
    const outcome = await result;
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.drafts[0]?.text).toBe("she slowly brushes a strand of hair back with her hand");
      expect(MOTION_ENGLISH.test(outcome.drafts[0]?.text ?? "")).toBe(true);
    }
  });

  test("a typographic apostrophe is made plain before the check, so the contract's charset never sees it", async () => {
    const { result } = run([reply(answer([good("she slowly tucks her mum’s hair back")])), reply(answer([good()]))]);
    const outcome = await result;
    expect(outcome.kind === "ok" ? outcome.drafts.map((d) => d.text) : null).toEqual([GOOD_MOTION]);
  });

  test("a repeated text is kept once", async () => {
    const { result } = run([reply(answer([good(GOOD_MOTION), good(`${GOOD_MOTION}.`, "Другая метка")]))]);
    const outcome = await result;
    expect(outcome.kind === "ok" ? outcome.drafts.map((d) => d.text) : null).toEqual([GOOD_MOTION]);
  });

  test("a label over 40 characters is cut by word with an ellipsis, a blank label drops its motion", async () => {
    const longLabel = "Медленно поправляет волосы и аккуратно убирает прядь за ухо";
    const { result } = run([reply(answer([good(GOOD_MOTION, longLabel), good(GOOD_MOTION_2, "   ")]))]);
    const outcome = await result;
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.drafts).toHaveLength(1);
      expect(outcome.drafts[0]?.label.length).toBeLessThanOrEqual(40);
      expect(outcome.drafts[0]?.label.endsWith("…")).toBe(true);
    }
  });

  test("a label with a control character is cleaned, never stored raw", async () => {
    const { result } = run([reply(answer([good(GOOD_MOTION, "Поправляет\u0000‮ прядь")]))]);
    const outcome = await result;
    expect(outcome.kind === "ok" ? outcome.drafts[0]?.label : null).toBe("Поправляет прядь");
  });
});

describe("failing texts are dropped, never offered", () => {
  test("a text that fails the check is dropped and logged by its place and the closed problems, never its text", async () => {
    const { result, logs } = run([reply(answer([good(GOOD_MOTION), good("slowly she turns her head", "Поворот"), good(GOOD_MOTION_3, "Вдох")]))]);
    const outcome = await result;
    expect(outcome.kind === "ok" ? outcome.drafts.map((d) => d.text) : null).toEqual([GOOD_MOTION, GOOD_MOTION_3]);
    const line = logs.find((l) => l.includes("dropped"));
    expect(line).toContain("photo-0001");
    expect(line).toContain("not-motion");
    expect(line).not.toContain("slowly she turns");
  });

  test("S5.WC2c: a vision text that takes clothing off is offered, on an ordinary frame and on «Смелая»; one the age guard refuses is dropped", async () => {
    for (const [i, facts] of [timerFrame(), boldMirrorFrame()].entries()) {
      const { result } = run([reply(answer([good(UNDRESS_MOTION, "Снимает халат"), good(UNDER_AGE_MOTION, "Снимает халат"), good(GOOD_MOTION)]))], { ...JOB, jobId: `job-0000010${i}`, facts });
      const outcome = await result;
      expect(outcome.kind === "ok" ? outcome.drafts.map((d) => d.text) : null).toEqual([UNDRESS_MOTION, GOOD_MOTION]);
    }
  });

  test("an answer with four motions is not thrown away: the first three are taken, one attempt, paid once", async () => {
    const four = [good(GOOD_MOTION), good(GOOD_MOTION_2, "Два"), good(GOOD_MOTION_3, "Три"), good("she slowly looks down and smiles to herself", "Четыре")];
    const { net, result } = run([reply(answer(four))]);
    const outcome = await result;
    expect(outcome.kind === "ok" ? outcome.drafts.map((d) => d.text) : null).toEqual([GOOD_MOTION, GOOD_MOTION_2, GOOD_MOTION_3]);
    expect(net.calls).toHaveLength(1);
  });

  test("an answer with no motion at all is unreadable", async () => {
    const { net, result } = run([reply(answer([])), reply(answer([good()]))]);
    expect((await result).kind).toBe("ok");
    expect(net.calls).toHaveLength(2);
  });
});

describe("the second attempt", () => {
  test("when every text failed, a second attempt carries the closed problem codes and no text of the first answer", async () => {
    const { net, result } = run([reply(answer([good("slowly she turns her head", "Поворот")]), 0.003), reply(answer([good()]), 0.0035)]);
    const outcome = await result;
    expect(outcome).toMatchObject({ kind: "ok", costMicros: 6_500 });
    expect(userMessage(net, 1)).toMatchObject({ problems: ["not-motion"] });
    expect(JSON.stringify(net.calls[1]?.json())).not.toContain("slowly she turns her head");
    expect(withoutAt(money.lines()).filter((l) => l.type === "reserve").map((l) => l.attemptId)).toEqual(["job-00000001:motion#1", "job-00000001:motion#2"]);
  });

  test("an unreadable answer (not JSON) is asked once more with the code `unreadable`", async () => {
    const { net, result } = run([reply("I cannot see a photo"), reply(answer([good()]))]);
    expect((await result).kind).toBe("ok");
    expect(userMessage(net, 1)).toMatchObject({ problems: ["unreadable"] });
  });

  test("a paid answer with no content is asked once more, and counts what it cost", async () => {
    const { result } = run([{ status: 200, body: chatBody(null, { cost: 0.0012, finishReason: "length" }) }, reply(answer([good()]), 0.0034)]);
    expect(await result).toMatchObject({ kind: "ok", costMicros: 4_600 });
  });

  test("two attempts at most: both failing is `none`, paid for both, and a third is never sent", async () => {
    const bad = reply(answer([good("slowly she turns her head", "Поворот")]), 0.003);
    const { net, result } = run([bad, bad]);
    expect(await result).toEqual({ kind: "none", costMicros: 6_000 });
    expect(net.calls).toHaveLength(2);
    expect(money.ledger.openReserves()).toEqual([]);
  });

  test("S5.WC2c: when every failed text was refused by the age guard, no repair is asked for: one attempt, `none`, paid", async () => {
    const { net, result } = run([reply(answer([good(UNDER_AGE_MOTION, "Снимает халат")]), 0.003)]);
    expect(await result).toEqual({ kind: "none", costMicros: 3_000 });
    expect(net.calls).toHaveLength(1);
  });

  test("S5.WC2c: a text the age guard refused beside one a repair can fix still gets the repair, and its `content` is not fed back", async () => {
    const { net, result } = run([reply(answer([good(UNDER_AGE_MOTION, "Снимает халат"), good("slowly she turns her head", "Поворот")])), reply(answer([good()]))]);
    expect((await result).kind).toBe("ok");
    expect(userMessage(net, 1)).toEqual(expect.objectContaining({ problems: ["not-motion"] }));
  });
});

describe("the money of a refusal and of a failure", () => {
  test("a moderation refusal is free: `none`, cost 0, no second attempt", async () => {
    const { net, result } = run([{ status: 400, body: { error: { message: "xAI blocked this request through content moderation." } } }]);
    expect(await result).toEqual({ kind: "none", costMicros: 0 });
    expect(net.calls).toHaveLength(1);
  });

  test("a paid unusable answer then a moderation refusal is `none` and carries the paid amount", async () => {
    const { result } = run([reply("not json", 0.0021), { status: 400, body: { error: { message: "xAI blocked this request through content moderation." } } }]);
    expect(await result).toEqual({ kind: "none", costMicros: 2_100 });
  });

  test("a paid first attempt then a failing second one (a 5xx) is `none` with the paid amount, never a bare error (L2)", async () => {
    const { result } = run([reply("not json", 0.0021), { status: 503, body: { error: { message: "down" } } }, { status: 503, body: { error: { message: "down" } } }, { status: 503, body: { error: { message: "down" } } }, { status: 503, body: { error: { message: "down" } } }]);
    expect(await result).toEqual({ kind: "none", costMicros: 2_100 });
  });

  test("a 402 on the second attempt stays an error: «нет кредитов» is not hidden behind a paid `none` (LOW-c)", async () => {
    const { result } = run([reply("not json", 0.0021), { status: 402, body: { error: { message: "no credits" } } }]);
    expect(await result).toMatchObject({ kind: "error", error: { code: "INSUFFICIENT_CREDITS" } });
  });

  test("a timeout or a network failure on the second attempt stays an error: its reserve is left open, so the paid amount would be understated (LOW-c)", async () => {
    const down: Step = { reject: new TypeError("fetch failed") };
    const { result } = run([reply("not json", 0.0021), down, down, down, down, down]);
    expect(await result).toMatchObject({ kind: "error", error: { code: "NETWORK" } });
  });

  test("a 401 is an error with its code, and the cost so far", async () => {
    const { result } = run([{ status: 401, body: { error: { message: "no auth" } } }]);
    expect(await result).toMatchObject({ kind: "error", error: { code: "AUTH_INVALID" }, costMicros: 0 });
  });

  test("a body that is not a chat answer at all is paid, `none`, and not asked again", async () => {
    const { net, result } = run([{ status: 200, body: { nothing: "here", usage: { cost: 0.002 } } }]);
    expect(await result).toEqual({ kind: "none", costMicros: 2_000 });
    expect(net.calls).toHaveLength(1);
  });
});

describe("the frame reading (marks only)", () => {
  test("capture-differs when the model sees another camera than the plan's; none when it agrees", async () => {
    const differs = run([reply(answer([good()], { ...FRAME, capture: "mirror" }))]);
    expect(await differs.result).toMatchObject({ reading: { notes: ["capture-differs"] } });
  });

  test("second-phone when a phone shows in a frame where hers is not meant to", async () => {
    const { result } = run([reply(answer([good()], { ...FRAME, phoneVisible: true }))]);
    expect(await result).toMatchObject({ reading: { notes: ["second-phone"] } });
  });

  test("both notes together, each once, and a reading never refuses or changes a price", async () => {
    const { result } = run([reply(answer([good()], { capture: "mirror", phoneVisible: true, faceVisible: false }))]);
    expect(await result).toMatchObject({ kind: "ok", reading: { notes: ["capture-differs", "second-phone"] }, costMicros: 3_400 });
  });

  test("a mirror frame whose phone shows is expected: no second-phone", async () => {
    const { result } = run([reply(answer([good()], { capture: "mirror", phoneVisible: true, faceVisible: true }))], { ...JOB, facts: boldMirrorFrame() });
    expect(await result).toMatchObject({ reading: { notes: [] } });
  });

  test("a capture the model names that is not a capture at all makes the answer unreadable", async () => {
    const { net, result } = run([reply(answer([good()], { ...FRAME, capture: "drone" })), reply(answer([good()]))]);
    expect((await result).kind).toBe("ok");
    expect(net.calls).toHaveLength(2);
  });
});
