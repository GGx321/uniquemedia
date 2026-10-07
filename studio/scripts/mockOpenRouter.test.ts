import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { authorizationLabel, markerMatch, requestCarries, startMockOpenRouter, type MockOpenRouter } from "./mockOpenRouter";
import { failureDetail } from "./failureDetail";
import { poolMessages, readPoolAnswer } from "../engine/scenes/poolGen";
import { IDEA_JSON_SCHEMA, ideaMessages, readIdeaAnswer, type IdeaSlot } from "../engine/scenes/ideaWriter";
import { WRITER_JSON_SCHEMA } from "../engine/scenes";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// The packaged smoke's marker scan (smoke-engine.ts) reads what this mock
// recorded, so it can only be as thorough as the record: the request's URL
// (query included), every header, and the body as it was sent, the way
// engine.canary.test.ts's own scan reads a fake fetch's call. A word hidden
// in a query string, a header or a body that is not JSON must not slip past.

// The test preload swaps the global fetch for happy-dom's (which sends a CORS preflight and returns its own Response); Bun's own is the one that speaks plain HTTP to the loopback mock.
const nativeFetch = Bun.fetch;
// ...and the mock answers with `new Response(...)`, which Bun.serve only accepts native: swap that one global too for this file.
const happyDomResponse = globalThis.Response;
const sample = await nativeFetch("data:,");
const nativeResponse = sample.constructor;
beforeAll(() => {
  if (typeof nativeResponse === "function") globalThis.Response = nativeResponse as typeof Response;
});
afterAll(() => {
  globalThis.Response = happyDomResponse;
});

const WORDS = ["zebra", "lantern", "marmalade"];

let mock: MockOpenRouter | null = null;
afterEach(async () => {
  await mock?.stop();
  mock = null;
});

async function started(): Promise<MockOpenRouter> {
  mock = await startMockOpenRouter({ descriptorText: "A 25-year-old woman." });
  return mock;
}

/** The mock's base is `http://127.0.0.1:<port>/api/v1`; every request below is a loopback one. */
async function send(m: MockOpenRouter, path: string, init: RequestInit = {}): Promise<void> {
  await nativeFetch(`${m.url}${path}`, init).then((r) => r.text());
}

describe("requestCarries", () => {
  test("finds a word in the URL's query string, in any letter case", async () => {
    const m = await started();
    await send(m, "/credits?note=Zebra");
    expect(m.requests.map((r) => requestCarries(r, WORDS))).toEqual([true]);
    expect(m.requests[0]?.url).toContain("/api/v1/credits?note=Zebra");
  });

  test("finds a word in any header, not only Authorization", async () => {
    const m = await started();
    await send(m, "/credits", { headers: { "x-note": "a LANTERN glows" } });
    expect(m.requests.map((r) => requestCarries(r, WORDS))).toEqual([true]);
    expect(m.requests[0]?.headers["x-note"]).toBe("a LANTERN glows");
  });

  test("finds a word in a JSON body", async () => {
    const m = await started();
    await send(m, "/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "Marmalade toast" }] }) });
    expect(m.requests.map((r) => requestCarries(r, WORDS))).toEqual([true]);
  });

  test("finds a word in a body that is not JSON: the parsed body is null there, the text as sent is not", async () => {
    const m = await started();
    await send(m, "/chat/completions", { method: "POST", headers: { "content-type": "text/plain" }, body: "not json, but ZEBRA is in it" });
    expect(m.requests[0]?.body).toBeNull();
    expect(m.requests.map((r) => requestCarries(r, WORDS))).toEqual([true]);
  });

  test("a request with none of the words carries none", async () => {
    const m = await started();
    await send(m, "/credits");
    await send(m, "/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [] }) });
    expect(m.requests.map((r) => requestCarries(r, WORDS))).toEqual([false, false]);
  });

  test("an empty word list matches nothing", async () => {
    const m = await started();
    await send(m, "/credits?note=zebra");
    expect(m.requests.map((r) => requestCarries(r, []))).toEqual([false]);
  });
});

describe("requestCarries lowercases the marker words too", () => {
  test("an upper-case or mixed-case word in the list still matches", async () => {
    const m = await started();
    await send(m, "/credits?note=zebra");
    expect(m.requests.map((r) => requestCarries(r, ["ZEBRA"]))).toEqual([true]);
    expect(m.requests.map((r) => requestCarries(r, ["Lantern", "Zebra"]))).toEqual([true]);
  });
});

// CS.2: the pool call of a custom category ("scene_pool"). The smoke creates a category against this mock, so what the mock answers must be a pool the
// engine's own reader accepts whole, at a cost /credits adds up, and its requests are listed apart from every other chat call.
describe("the pool call", () => {
  const body = (user: string) =>
    JSON.stringify({
      model: "x-ai/grok-4.3",
      messages: [
        { role: "system", content: "rules" },
        { role: "user", content: user },
      ],
      response_format: { type: "json_schema", json_schema: { name: "scene_pool", strict: true, schema: {} } },
    });
  const post = (m: MockOpenRouter, user = "Description of the theme") => nativeFetch(`${m.url}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: body(user) });

  test("answers a pool the engine's reader accepts whole, with nothing dropped", async () => {
    const m = await started();
    const reply = (await (await post(m)).json()) as { choices: { message: { content: string } }[] };
    const read = readPoolAnswer(reply.choices[0]?.message.content ?? "");
    expect(read.ok && read.dropped).toBe(0);
    expect(read.ok && read.label).toBe("Mock theme");
  });

  test("a description with no angle gets a pool with no poses", async () => {
    const m = await started();
    const reply = (await (await post(m, poolMessages("кофейни и булочные")[1]?.content)).json()) as { choices: { message: { content: string } }[] };
    const read = readPoolAnswer(reply.choices[0]?.message.content ?? "");
    expect(read.ok && "poses" in read.pool).toBe(false);
  });

  test("the paid canary's description («Лежит на животе… Вид сзади») gets back and activities in that body position (CS.8a)", async () => {
    const m = await started();
    const description = "Лежит на животе в домашних шортиках и топике. Вид сзади";
    const reply = (await (await post(m, poolMessages(description)[1]?.content)).json()) as { choices: { message: { content: string } }[] };
    const read = readPoolAnswer(reply.choices[0]?.message.content ?? "");
    expect(read.ok && read.dropped).toBe(0);
    expect(read.ok && read.pool.poses).toEqual(["back"]);
    expect(read.ok && read.pool.locations.every((l) => l.activities.every((a) => a.text.startsWith("lying on her stomach")))).toBe(true);
  });

  test("lists the request apart from the other chat calls, and books its cost against /credits", async () => {
    const m = await started();
    await post(m);
    expect(m.poolRequests()).toHaveLength(1);
    expect(m.sceneWriterRequests()).toHaveLength(0);
    expect(m.unexpected).toEqual([]);
    expect(m.totalUsageUsd()).toBeCloseTo(0.0051, 6);
  });

  test("answers what the scenario told it to, and a cost of its own", async () => {
    mock = await startMockOpenRouter({ descriptorText: "A 25-year-old woman.", poolAnswer: { label: "Seine bakeries" }, costsUsd: { pool: 0.006 } });
    const reply = (await (await post(mock)).json()) as { choices: { message: { content: string } }[] };
    const read = readPoolAnswer(reply.choices[0]?.message.content ?? "");
    expect(read.ok && read.label).toBe("Seine bakeries");
    expect(mock.totalUsageUsd()).toBeCloseTo(0.006, 6);
  });
});

// CS.4b: the idea variant of the scene writer. «+ Своя сцена» sends the owner's idea (any script) under the same "scene_sentences" schema; the mock answers one
// sentence per own scene, in a shape the engine's own reader accepts for those scenes, and lists the request with the other scene-writer calls.
describe("the idea writer call", () => {
  const slots: IdeaSlot[] = [
    { slotIndex: 6, idea: "кофе на балконе утром", shot: "friend", pose: "front" },
    { slotIndex: 7, idea: "кофе на балконе утром", shot: "selfie", pose: "three-quarter" },
    { slotIndex: 8, idea: "прогулка по набережной", shot: "mirror", pose: "front" },
  ];
  const post = (m: MockOpenRouter, asked: readonly IdeaSlot[] = slots) =>
    nativeFetch(`${m.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "x-ai/grok-4.3", messages: ideaMessages(asked), response_format: { type: "json_schema", json_schema: IDEA_JSON_SCHEMA } }),
    });

  test("answers a sentence for every own scene that the writer's own reader accepts, whatever the shot", async () => {
    const m = await started();
    const reply = (await (await post(m)).json()) as { choices: { message: { content: string } }[] };
    const read = readIdeaAnswer(reply.choices[0]?.message.content ?? "", slots);
    expect(read.ok && [...read.sentences.keys()]).toEqual([6, 7, 8]);
  });

  test("the sentences differ from scene to scene", async () => {
    const m = await started();
    const reply = (await (await post(m)).json()) as { choices: { message: { content: string } }[] };
    const read = readIdeaAnswer(reply.choices[0]?.message.content ?? "", slots);
    expect(read.ok && new Set(read.sentences.values()).size).toBe(3);
  });

  test("is listed with the scene writer's requests and books the writer's cost against /credits", async () => {
    const m = await started();
    await post(m);
    expect(m.sceneWriterRequests()).toHaveLength(1);
    expect(m.poolRequests()).toHaveLength(0);
    expect(m.unexpected).toEqual([]);
    expect(m.totalUsageUsd()).toBeCloseTo(0.011, 6);
  });

  describe("a slot whose angle the model picks (CS.8a)", () => {
    const pickWith = async (asked: readonly IdeaSlot[], mirrorAllowed: boolean) => {
      const m = await started();
      const reply = (await (await post(m, asked)).json()) as { choices: { message: { content: string } }[] };
      return readIdeaAnswer(reply.choices[0]?.message.content ?? "", asked, mirrorAllowed);
    };
    const pick = (asked: readonly IdeaSlot[]) => pickWith(asked, false);

    test("an idea that asks for a view from behind, in Russian, gets back and a shot nobody holds a phone for", async () => {
      const read = await pick([{ slotIndex: 6, idea: "лежит на животе, вид сзади", shot: null, pose: null }]);
      expect(read.ok && read.angles.get(6)).toEqual({ shot: "candid", pose: "back" });
    });

    test("so does an idea that says «back» in English", async () => {
      const read = await pick([{ slotIndex: 6, idea: "lying on her stomach, back view", shot: null, pose: null }]);
      expect(read.ok && read.angles.get(6)?.pose).toBe("back");
    });

    test("an idea that asks for a profile gets profile", async () => {
      const read = await pick([{ slotIndex: 6, idea: "в профиль у окна", shot: null, pose: null }]);
      expect(read.ok && read.angles.get(6)).toEqual({ shot: "candid", pose: "profile" });
    });

    test("an idea that says nothing of the angle gets a friend's photo facing the camera", async () => {
      const read = await pick([{ slotIndex: 6, idea: "кофе на балконе утром", shot: null, pose: null }]);
      expect(read.ok && read.angles.get(6)).toEqual({ shot: "friend", pose: "front" });
    });

    test("an idea that names a mirror gets the mirror on «Авто», facing the camera; one that names none never does", async () => {
      const named = await pickWith([{ slotIndex: 6, idea: "селфи в зеркале лифта", shot: null, pose: null }], true);
      expect(named.ok && named.angles.get(6)).toEqual({ shot: "mirror", pose: "front" });
      const plain = await pickWith([{ slotIndex: 6, idea: "кофе на балконе", shot: null, pose: null }], false);
      expect(plain.ok && plain.angles.get(6)?.shot).toBe("friend");
    });

    test("a shot the owner chose stays, and a mirror or selfie is never turned away", async () => {
      const read = await pick([
        { slotIndex: 6, idea: "вид сзади", shot: "friend", pose: null },
        { slotIndex: 7, idea: "вид сзади", shot: "selfie", pose: null },
        { slotIndex: 8, idea: "вид сзади", shot: "mirror", pose: null },
      ]);
      expect(read.ok && [...read.angles.values()]).toEqual([
        { shot: "friend", pose: "back" },
        { shot: "selfie", pose: "front" },
        { shot: "mirror", pose: "front" },
      ]);
    });
  });

  test("a follow-up after a refusal (the re-ask paragraph) is read the same way", async () => {
    const m = await started();
    const messages = ideaMessages(slots, { problems: ["empty"], missingSlots: [], twoHandedSlots: [], wordSlots: [], words: [], poseSlots: [] });
    const reply = await nativeFetch(`${m.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "x-ai/grok-4.3", messages, response_format: { type: "json_schema", json_schema: IDEA_JSON_SCHEMA } }),
    });
    expect(reply.status).toBe(200);
  });
});

describe("markerMatch says which word matched and where, and nothing else", () => {
  test.each([
    ["url", "/credits?note=zebra", {}],
    ["headers", "/credits", { headers: { "x-note": "lantern" } }],
    ["body", "/chat/completions", { method: "POST", headers: { "content-type": "text/plain" }, body: "marmalade" }],
  ] as const)("a word in the %s", async (where, path, init: RequestInit) => {
    const m = await started();
    await send(m, path, init);
    const found = m.requests[0] === undefined ? null : markerMatch(m.requests[0], WORDS);
    expect(found?.in).toBe(where);
    expect(WORDS).toContain(found?.word ?? "");
  });

  test("null when no word is there", async () => {
    const m = await started();
    await send(m, "/credits");
    expect(m.requests[0] === undefined ? "no request" : markerMatch(m.requests[0], WORDS)).toBeNull();
  });
});

// A failed check prints its detail. A recorded request holds the Authorization header and whole bodies: none of that may
// ever reach the output, only what kind of request it was and where it went.
describe("failureDetail", () => {
  const request = {
    method: "POST",
    path: "/api/v1/chat/completions",
    schemaName: "avatar_descriptor",
    authorization: "Bearer sk-or-v1-secret",
    url: "http://127.0.0.1:1/api/v1/chat/completions",
    headers: { authorization: "Bearer sk-or-v1-secret", "x-note": "hello" },
    body: { messages: [{ content: "a very private prompt" }] },
    bodyText: '{"messages":[{"content":"a very private prompt"}]}',
  };

  test("drops every header, the Authorization value and both forms of the body, at any depth", () => {
    const text = failureDetail([{ carrying: [request] }, request]);
    expect(text).not.toContain("sk-or-v1-secret");
    expect(text).not.toContain("Bearer");
    expect(text).not.toContain("private prompt");
    expect(text).not.toContain("x-note");
    expect(text).toContain("/api/v1/chat/completions");
    expect(text).toContain("avatar_descriptor");
  });

  test("drops those keys in any letter case", () => {
    const text = failureDetail({ Authorization: "Bearer sk-secret", HEADERS: { a: "b" }, Body: "private", BodyText: "private", path: "/x" });
    expect(text).toBe('{"path":"/x"}');
  });

  test("truncates a long string and the whole text", () => {
    expect(failureDetail({ why: "x".repeat(5_000) }).length).toBeLessThanOrEqual(600);
    expect(failureDetail(["y".repeat(300)])).toContain("…");
  });

  test("leaves plain values alone", () => {
    expect(failureDetail({ a: 1, b: ["two"] })).toBe('{"a":1,"b":["two"]}');
    expect(failureDetail(undefined)).toBe("");
  });
});

// The smoke's "exactly Bearer <the fake key>" check must say what went wrong without ever printing a header value.
describe("authorizationLabel", () => {
  const base = { method: "POST", path: "/api/v1/images", body: null, schemaName: null, url: "", headers: {}, bodyText: "" };

  test("none, expected, or other: never the value", () => {
    expect(authorizationLabel({ ...base, authorization: null }, "sk-fake")).toBe("none");
    expect(authorizationLabel({ ...base, authorization: "Bearer sk-fake" }, "sk-fake")).toBe("expected");
    expect(authorizationLabel({ ...base, authorization: "Bearer sk-real-secret" }, "sk-fake")).toBe("other");
    expect(authorizationLabel({ ...base, authorization: "sk-fake" }, "sk-fake")).toBe("other");
  });
});
