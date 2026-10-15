import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CommandMessage, ownIdeaLabel } from "../shared/engine";
import { clipsDir, create, jobEnd, jobIdOf, phasesOf, until } from "./clips/testing/engineClipKit";
import { motionNetwork, resultOf, userDataOf } from "./clips/testing/motionNet";
import { CANARY, GOOD_TEXTS, IDEA, ideaReply, motionWorld } from "./clips/testing/motionWorld";
import { filesUnder, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();
setDefaultTimeout(60_000);

// Stage 5, 5b.2, S5.WC3 (plan s5b2 I5.67): the owner's free text never reaches the video provider, a clip record or the journal. His idea lives in the translator's chat request (as JSON data in the user message)
// and in the engine's memory while the call runs; the photo's store and the clip record keep its label (his words cut to 40 characters) and the English text; the journal keeps neither the label nor the idea; no log
// line holds a label or a text; a saved raw body of an unusable answer holds `[owner idea omitted: N chars]` where the idea was; every video request is printable ASCII.

const dir = useEngineDir("studio-engine-clip-motions-trust-");
const LABEL = ownIdeaLabel(IDEA);

let warnings: string[] = [];
let warn: ReturnType<typeof spyOn<Console, "warn">>;
beforeEach(() => {
  warnings = [];
  warn = spyOn(console, "warn").mockImplementation((...args: unknown[]) => void warnings.push(args.map(String).join(" ")));
});
afterEach(() => {
  warn.mockRestore();
});

async function everyFileUnder(root: string): Promise<{ path: string; text: string }[]> {
  const files = await filesUnder(root);
  return Promise.all(files.map(async (path) => ({ path, text: Buffer.from(await readFile(join(root, path))).toString("latin1") })));
}

describe("the idea's words, from the translation to the finished clip", () => {
  async function ownClip() {
    const net = motionNetwork({ chat: () => ideaReply(GOOD_TEXTS[0] ?? ""), clip: { kling: { held: true } } });
    const w = await motionWorld(dir(), { net });
    expect(resultOf(await w.translate())).toMatchObject({ outcome: "ok", item: { id: "o-1", label: LABEL } });
    const jobId = jobIdOf(await create(w.started, { avatarId: w.avatarId, photoId: w.photoId, motionId: "o-1" }));
    await until(() => phasesOf(w.started, jobId).includes("rendering"), "rendering");
    return { w, net, jobId };
  }

  test("the idea is in the translator's chat request, in the user message only, and the label is his first words", async () => {
    const { w, net, jobId } = await ownClip();
    expect(net.chats).toHaveLength(1);
    const request = net.chats[0];
    expect(request?.body.split(CANARY)).toHaveLength(2);
    expect(userDataOf(request ?? net.chats[0]!).idea).toBe(IDEA);
    expect(LABEL.length).toBeLessThanOrEqual(40);
    expect(LABEL).not.toContain(CANARY);
    net.release("kling");
    await jobEnd(w.started, jobId);
  });

  test("the journal of the clip in flight holds the English text and no label and no idea", async () => {
    const { w, net, jobId } = await ownClip();
    const journal = await readFile(join(clipsDir(w.libraryDir, w.avatarId), `${jobId}.journal.jsonl`), "utf8");
    const requested = JSON.parse(journal.split("\n")[0] ?? "{}") as { type: string; motion: Record<string, unknown> };
    expect(requested).toMatchObject({ type: "requested", motion: { source: "own", text: GOOD_TEXTS[0] } });
    expect("label" in requested.motion).toBe(false);
    expect(journal).not.toContain(CANARY);
    expect(journal).not.toContain(LABEL);
    net.release("kling");
    await jobEnd(w.started, jobId);
  });

  test("the video provider gets the English text in printable ASCII: no label, no idea, no Cyrillic", async () => {
    const { w, net, jobId } = await ownClip();
    net.release("kling");
    await jobEnd(w.started, jobId);
    const posts = net.posts();
    expect(posts.length).toBeGreaterThan(0);
    for (const post of posts) {
      const body = JSON.parse(post.body ?? "{}") as { prompt: string };
      expect(body.prompt).toMatch(/^[\x20-\x7e]+$/);
      expect(body.prompt).toContain(GOOD_TEXTS[0] ?? "?");
      expect(post.body ?? "").not.toContain(CANARY);
      expect(post.body ?? "").not.toMatch(/[Ѐ-ӿ]/);
    }
  });

  test("the record and the store keep the label and the English text; nothing keeps the idea", async () => {
    const { w, net, jobId } = await ownClip();
    net.release("kling");
    await jobEnd(w.started, jobId);
    const record = JSON.parse(await readFile(join(clipsDir(w.libraryDir, w.avatarId), `${jobId}.json`), "utf8")) as { motion: unknown };
    expect(record.motion).toEqual({ source: "own", label: LABEL, text: GOOD_TEXTS[0] });
    const store = await readFile(w.storePath(), "utf8");
    expect(store).toContain(LABEL);
    for (const file of await everyFileUnder(w.dir)) expect([file.path, file.text.includes(CANARY)]).toEqual([file.path, false]);
  });

  test("no file of the engine's folders (library, ledger, raw bodies) holds the idea, the journal's removal included", async () => {
    const { w, net, jobId } = await ownClip();
    net.release("kling");
    await jobEnd(w.started, jobId);
    const files = await everyFileUnder(w.dir);
    expect(files.length).toBeGreaterThan(5);
    expect(files.filter((f) => f.text.includes(CANARY))).toEqual([]);
    expect(files.filter((f) => f.text.includes("поворачивает"))).toEqual([]);
  });

  test("no log line holds the idea or his label", async () => {
    const { w, net, jobId } = await ownClip();
    net.release("kling");
    await jobEnd(w.started, jobId);
    const logs = warnings.join("\n");
    expect(logs).not.toContain(CANARY);
    expect(logs).not.toContain("поворачивает");
    expect(logs).not.toContain(LABEL);
  });

  test("no event the window hears holds the idea (a job tile may show the label)", async () => {
    const { w, net, jobId } = await ownClip();
    net.release("kling");
    await jobEnd(w.started, jobId);
    expect(JSON.stringify(w.started.posted)).not.toContain(CANARY);
  });
});

describe("a saved raw body", () => {
  test("an unusable paid answer that echoes the idea is saved with `[owner idea omitted: N chars]` in its place", async () => {
    const w = await motionWorld(dir(), {
      chat: () => ({ status: 200, body: { usage: { cost: 0.001 }, echo: `the idea was: ${IDEA}`, escaped: JSON.stringify({ idea: IDEA }), unicode: IDEA.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`) } }),
    });
    expect(resultOf(await w.translate())).toEqual({ outcome: "none", costMicros: 1_000 });
    const raws = await everyFileUnder(join(dir(), "userData", "raw"));
    expect(raws.length).toBeGreaterThan(0);
    for (const raw of raws) {
      expect(raw.text).not.toContain(CANARY);
      expect(raw.text).not.toContain("поворачивает");
      expect(raw.text).toContain(`[owner idea omitted: ${IDEA.length} chars]`);
    }
  });

  test("a raw body of the vision writer is saved as it always was (there is no idea to omit)", async () => {
    const w = await motionWorld(dir(), { chat: () => ({ status: 200, body: { usage: { cost: 0.001 }, note: "no choices here" } }) });
    expect(resultOf(await w.suggest())).toEqual({ outcome: "none", costMicros: 1_000 });
    const raws = await everyFileUnder(join(dir(), "userData", "raw"));
    expect(raws.length).toBeGreaterThan(0);
  });
});

describe("what a clip command carries", () => {
  const FORBIDDEN = ["text", "motion", "motionText", "idea", "prompt", "label", "english"];

  function propertyNames(schema: unknown, found = new Set<string>()): Set<string> {
    if (Array.isArray(schema)) for (const item of schema) propertyNames(item, found);
    else if (typeof schema === "object" && schema !== null) {
      for (const [key, value] of Object.entries(schema)) {
        if (key === "properties" && typeof value === "object" && value !== null) for (const name of Object.keys(value)) found.add(name);
        propertyNames(value, found);
      }
    }
    return found;
  }

  test("no clip command payload has a motion text field: `clips.create` and `clips.createBatch` name motion ids only", () => {
    const clipCommands = CommandMessage.options.filter((option) => option.shape.type.value.startsWith("clips.") && option.shape.type.value !== "clips.translateIdea");
    expect(clipCommands.length).toBeGreaterThan(8);
    for (const option of clipCommands) {
      const names = propertyNames(z.toJSONSchema(option.shape.payload, { unrepresentable: "any", io: "input" }));
      const bad = FORBIDDEN.filter((name) => names.has(name));
      expect([option.shape.type.value, bad]).toEqual([option.shape.type.value, []]);
    }
  });

  test("the only command that carries the owner's words is `clips.translateIdea`, as `text`", () => {
    const carriers = CommandMessage.options
      .filter((option) => propertyNames(z.toJSONSchema(option.shape.payload, { unrepresentable: "any", io: "input" })).has("text") && option.shape.type.value.startsWith("clips."))
      .map((option) => option.shape.type.value);
    expect(carriers).toEqual(["clips.translateIdea"]);
  });

  test("the motion id of a clip command is `scene`, g-<slug>, v-<n> or o-<n>, never text", () => {
    const create = CommandMessage.options.find((option) => option.shape.type.value === "clips.create");
    expect(create?.shape.payload.safeParse({ avatarId: "avatar-aaaa-0001", photoId: "photo-0001", motionId: "she slowly smiles", model: "kling", quality: "std", seconds: 5, fallback: "auto", acceptedWorstMicros: 1 }).success).toBe(false);
    expect(create?.shape.payload.safeParse({ avatarId: "avatar-aaaa-0001", photoId: "photo-0001", motionId: "o-12", model: "kling", quality: "std", seconds: 5, fallback: "auto", acceptedWorstMicros: 1 }).success).toBe(true);
  });
});

void readdir;
