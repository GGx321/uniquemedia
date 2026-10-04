import { describe, expect, test } from "bun:test";
import type { TextLayer } from "../../shared/engine";
import type { TextPreviewOutcome } from "./textPreview";
import { NO_PREVIEW, type PictureAnswer, type PreviewAnswer, previewLook, TextPreviewQueue } from "./textPreviewQueue";

// 3d.4: ONE per-layer queue of `montages.textPreview` asks in the window, shared by everything that shows a caption: the preview
// (every text layer's picture) and the properties panel (the caption's verdict, 3d.5). The engine keeps one queue per layer too and
// answers a waiting ask TEXT_PREVIEW_SUPERSEDED when a newer ask of the same layer arrives. With two consumers asking on their own,
// one's ask could supersede the other's, and the other would wait for ever for an answer to an ask nobody draws (the 3d.5 note).
// Here a consumer never waits for ITS ask: each reads the layer's state, which the newest answer decides; an ask the same look is
// already asked for is not sent again; a superseded answer is dropped silently; and nothing is left pending for ever.

const layer = (over: Partial<TextLayer> = {}): TextLayer => ({
  kind: "text",
  layerId: "layer-001",
  startMs: 0,
  endMs: 3_000,
  value: "sunday reset",
  font: "manrope",
  style: "plaque",
  color: "#ffffff",
  x: 0.5,
  y: 0.2,
  scale: 1,
  ...over,
});

const picture = (previewId: string, width = 400, height = 90): PictureAnswer => ({ kind: "picture", previewId, width, height, url: `data:${previewId}` });
const SUPERSEDED: TextPreviewOutcome = { kind: "superseded" };
const charset: PreviewAnswer = { kind: "invalid", captionIssue: "charset", error: { code: "TEXT_INVALID", captionIssue: "charset" } };

/** An engine answered by hand: every ask waits until the test answers it. */
function engine() {
  const asks: { layer: TextLayer; answer: (outcome: TextPreviewOutcome) => void; fail: (error: unknown) => void }[] = [];
  const queue = new TextPreviewQueue(
    (asked) =>
      new Promise<TextPreviewOutcome>((resolve, reject) => {
        asks.push({ layer: asked, answer: resolve, fail: reject });
      }),
  );
  async function answer(index: number, outcome: TextPreviewOutcome): Promise<void> {
    const ask = asks[index];
    if (ask === undefined) throw new Error(`no ask ${index}`);
    ask.answer(outcome);
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }
  async function fail(index: number, error: unknown): Promise<void> {
    asks[index]?.fail(error);
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }
  return { queue, asks, answer, fail };
}

const pending = (q: TextPreviewQueue, layerId = "layer-001"): boolean => {
  const state = q.get(layerId);
  return state.asked > (state.shown?.ask ?? 0);
};

describe("what decides a picture (the look)", () => {
  test("the text, the font, the style, the colour and the size; never the place or the time", () => {
    const base = previewLook(layer());
    expect(previewLook(layer({ x: 0.1, y: 0.9, startMs: 500, endMs: 900 }))).toBe(base);
    for (const change of [{ value: "other" }, { font: "caveat" as const }, { style: "none" as const }, { color: "#111111" }, { scale: 1.5 }]) {
      expect(previewLook(layer(change))).not.toBe(base);
    }
  });
});

describe("one ask serves every consumer", () => {
  test("a layer nobody asked about has no preview", () => {
    expect(engine().queue.get("layer-001")).toEqual(NO_PREVIEW);
  });

  test("the preview and the panel asking for the same look send ONE ask, and both read its answer", async () => {
    const { queue, asks, answer } = engine();
    queue.request(layer());
    queue.request(layer({ x: 0.3 }));
    expect(asks).toHaveLength(1);
    expect(pending(queue)).toBe(true);
    await answer(0, picture("preview-0001"));
    expect(queue.get("layer-001").shown?.answer).toEqual(picture("preview-0001"));
    expect(pending(queue)).toBe(false);
  });

  test("a new look is asked for; while it is out the older answer still shows, and the state says a newer one is coming", async () => {
    const { queue, asks, answer } = engine();
    queue.request(layer());
    await answer(0, picture("preview-0001"));
    queue.request(layer({ value: "sunday reset ☀️" }));
    expect(asks).toHaveLength(2);
    expect(queue.get("layer-001").shown?.answer).toEqual(picture("preview-0001"));
    expect(pending(queue)).toBe(true);
    await answer(1, picture("preview-0002"));
    expect(queue.get("layer-001").shown).toEqual({ ask: 2, look: previewLook(layer({ value: "sunday reset ☀️" })), answer: picture("preview-0002") });
  });

  test("going back to a look asked for before asks again (only the newest ask's look is shared)", () => {
    const { queue, asks } = engine();
    queue.request(layer());
    queue.request(layer({ value: "b" }));
    queue.request(layer());
    expect(asks.map((a) => a.layer.value)).toEqual(["sunday reset", "b", "sunday reset"]);
  });

  test("different layers never touch each other", async () => {
    const { queue, asks, answer } = engine();
    queue.request(layer());
    queue.request(layer({ layerId: "layer-002" }));
    expect(asks).toHaveLength(2);
    await answer(1, picture("preview-0002"));
    expect(queue.get("layer-002").shown?.answer).toEqual(picture("preview-0002"));
    expect(queue.get("layer-001").shown).toBe(null);
  });
});

describe("superseded answers and stale answers", () => {
  test("an older ask the engine superseded is dropped silently: nothing changes, nothing is asked again", async () => {
    const { queue, asks, answer } = engine();
    queue.request(layer({ value: "a" }));
    queue.request(layer({ value: "ab" }));
    const before = queue.get("layer-001");
    await answer(0, SUPERSEDED);
    expect(queue.get("layer-001")).toBe(before);
    expect(asks).toHaveLength(2);
    await answer(1, picture("preview-0002"));
    expect(pending(queue)).toBe(false);
  });

  test("an answer older than the one shown is dropped (the newer look was judged already)", async () => {
    const { queue, answer } = engine();
    queue.request(layer({ value: "a" }));
    queue.request(layer({ value: "ab" }));
    await answer(1, picture("preview-0002"));
    await answer(0, charset);
    expect(queue.get("layer-001").shown?.answer).toEqual(picture("preview-0002"));
  });

  test("an older ask answered while the newest is still out is shown, marked pending", async () => {
    const { queue, answer } = engine();
    queue.request(layer({ value: "a" }));
    queue.request(layer({ value: "ab" }));
    await answer(0, charset);
    expect(queue.get("layer-001").shown?.answer).toEqual(charset);
    expect(pending(queue)).toBe(true);
  });

  test("the NEWEST ask superseded from outside (another window asked for the layer) is asked again, so nobody waits for ever", async () => {
    const { queue, asks, answer } = engine();
    queue.request(layer());
    await answer(0, SUPERSEDED);
    expect(asks).toHaveLength(2);
    expect(asks[1]?.layer.value).toBe("sunday reset");
    expect(pending(queue)).toBe(true);
    await answer(1, picture("preview-0002"));
    expect(queue.get("layer-001").shown?.answer).toEqual(picture("preview-0002"));
    expect(pending(queue)).toBe(false);
  });

  test("superseded again and again from outside, it gives up after a few asks with an answer, never pending for ever", async () => {
    const { queue, asks, answer } = engine();
    queue.request(layer());
    for (let i = 0; i < 10 && pending(queue); i++) await answer(i, SUPERSEDED);
    expect(asks.length).toBeLessThanOrEqual(4);
    expect(pending(queue)).toBe(false);
    expect(queue.get("layer-001").shown?.answer.kind).toBe("failed");
  });

  test("an ask whose answer never parsed (the promise failed) ends as failed, never pending", async () => {
    const { queue, fail } = engine();
    queue.request(layer());
    await fail(0, new Error("the bridge went away"));
    expect(pending(queue)).toBe(false);
    expect(queue.get("layer-001").shown?.answer).toEqual({ kind: "failed", error: { code: "INTERNAL", detail: "the text preview could not be asked for" } });
  });
});

describe("the picture", () => {
  test("is the newest picture drawn: a later refusal keeps it (the preview shows the last good caption, marked)", async () => {
    const { queue, answer } = engine();
    queue.request(layer());
    await answer(0, picture("preview-0001"));
    queue.request(layer({ value: "привет" }));
    await answer(1, charset);
    const state = queue.get("layer-001");
    expect(state.picture).toEqual({ ask: 1, look: previewLook(layer()), answer: picture("preview-0001") });
    expect(state.shown?.answer).toEqual(charset);
  });

  test("reload asks again for the newest look even though it was answered (the engine evicted the picture)", async () => {
    const { queue, asks, answer } = engine();
    queue.request(layer());
    await answer(0, picture("preview-0001"));
    queue.reload("layer-001");
    expect(asks).toHaveLength(2);
    await answer(1, picture("preview-0009"));
    expect(queue.get("layer-001").picture?.answer).toEqual(picture("preview-0009"));
  });

  test("reload of a layer never asked about asks nothing", () => {
    const { queue, asks } = engine();
    queue.reload("layer-001");
    expect(asks).toHaveLength(0);
  });
});

describe("listeners", () => {
  test("a layer's listeners hear its changes only; an unsubscribed one hears nothing", async () => {
    const { queue, answer } = engine();
    const heard: string[] = [];
    const stop = queue.subscribe("layer-001", () => heard.push("one"));
    queue.subscribe("layer-002", () => heard.push("two"));
    queue.request(layer());
    await answer(0, picture("preview-0001"));
    expect(heard).toEqual(["one", "one"]);
    stop();
    queue.request(layer({ value: "x" }));
    expect(heard).toEqual(["one", "one"]);
  });
});
