import { describe, expect, test } from "bun:test";
import type { TextLayer } from "../../shared/engine";
import type { TextPreviewOutcome } from "./textPreview";
import { isEngineRefusal, NO_PREVIEW, OUTSIDE_RETRIES, type PictureAnswer, type PreviewAnswer, previewLook, refusedNow, TextPreviewQueue } from "./textPreviewQueue";

// 3d.4: ONE per-layer queue of `montages.textPreview` asks in the window, shared by everything that shows a caption: the preview
// (every text layer's picture) and the properties panel (the caption's verdict, 3d.5). The engine keeps one queue per layer too and
// answers a waiting ask TEXT_PREVIEW_SUPERSEDED when a newer ask of the same layer arrives. Here a consumer never waits for ITS ask:
// each reads the layer's state, which the newest answer decides; an ask of the look already asked for is not sent again; and
// nothing is left pending for ever. Review round 1: at most ONE ask per layer is out at a time and only the newest look waits behind
// it, so typing sends one ask while the engine draws, then the last text, never an ask per key (and the window's own asks never
// supersede each other in the engine).

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

  test("with nothing out, a new look is asked for at once; the older answer still shows meanwhile, the state says a newer one is coming", async () => {
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

  test("different layers never touch each other: each has its own ask out", async () => {
    const { queue, asks, answer } = engine();
    queue.request(layer());
    queue.request(layer({ layerId: "layer-002" }));
    expect(asks).toHaveLength(2);
    await answer(1, picture("preview-0002"));
    expect(queue.get("layer-002").shown?.answer).toEqual(picture("preview-0002"));
    expect(queue.get("layer-001").shown).toBe(null);
  });
});

describe("one ask out per layer, the newest look waiting behind it", () => {
  test("typing while an ask is out sends nothing more until it answers, then only the newest text", async () => {
    const { queue, asks, answer } = engine();
    queue.request(layer({ value: "s" }));
    for (const value of ["su", "sun", "sund", "sunday"]) queue.request(layer({ value }));
    expect(asks.map((a) => a.layer.value)).toEqual(["s"]);
    expect(pending(queue)).toBe(true);
    await answer(0, picture("preview-0001"));
    expect(asks.map((a) => a.layer.value)).toEqual(["s", "sunday"]);
    // The answer to the old text is shown meanwhile, marked pending.
    expect(queue.get("layer-001").shown?.answer).toEqual(picture("preview-0001"));
    expect(pending(queue)).toBe(true);
    await answer(1, picture("preview-0002"));
    expect(pending(queue)).toBe(false);
    expect(queue.get("layer-001").shown?.look).toBe(previewLook(layer({ value: "sunday" })));
  });

  test("going back to the look that is out cancels the waiting one: its answer is the newest, nothing more is sent", async () => {
    const { queue, asks, answer } = engine();
    queue.request(layer());
    queue.request(layer({ value: "b" }));
    queue.request(layer());
    await answer(0, picture("preview-0001"));
    expect(asks.map((a) => a.layer.value)).toEqual(["sunday reset"]);
    expect(pending(queue)).toBe(false);
  });

  test("a failed answer still sends the newest look waiting behind it", async () => {
    const { queue, asks, answer } = engine();
    queue.request(layer());
    queue.request(layer({ value: "b" }));
    await answer(0, { kind: "failed", error: { code: "RENDER_FAILED", detail: "timeout" } });
    expect(asks.map((a) => a.layer.value)).toEqual(["sunday reset", "b"]);
  });

  test("a rejected ask (the promise failed) ends as failed, never pending, and the waiting look is sent", async () => {
    const { queue, asks, fail } = engine();
    queue.request(layer());
    queue.request(layer({ value: "b" }));
    await fail(0, new Error("the bridge went away"));
    expect(queue.get("layer-001").shown?.answer).toEqual({ kind: "failed", error: { code: "INTERNAL", detail: "the text preview could not be asked for" } });
    expect(asks.map((a) => a.layer.value)).toEqual(["sunday reset", "b"]);
  });
});

describe("superseded from outside (another window asked for the layer)", () => {
  test("the newest ask superseded is asked again, so nobody waits for ever", async () => {
    const { queue, asks, answer } = engine();
    queue.request(layer());
    await answer(0, SUPERSEDED);
    expect(asks.map((a) => a.layer.value)).toEqual(["sunday reset", "sunday reset"]);
    expect(pending(queue)).toBe(true);
    await answer(1, picture("preview-0002"));
    expect(queue.get("layer-001").shown?.answer).toEqual(picture("preview-0002"));
    expect(pending(queue)).toBe(false);
  });

  test(`asked again exactly ${OUTSIDE_RETRIES} times, then settled as failed, never pending`, async () => {
    expect(OUTSIDE_RETRIES).toBe(3);
    const { queue, asks, answer } = engine();
    queue.request(layer());
    for (let i = 0; i <= OUTSIDE_RETRIES; i++) await answer(i, SUPERSEDED);
    expect(asks).toHaveLength(OUTSIDE_RETRIES + 1);
    expect(pending(queue)).toBe(false);
    expect(queue.get("layer-001").shown?.answer.kind).toBe("failed");
  });

  test("a new look starts its retries afresh", async () => {
    const { queue, asks, answer } = engine();
    queue.request(layer());
    await answer(0, SUPERSEDED);
    await answer(1, SUPERSEDED);
    queue.request(layer({ value: "b" }));
    // The "b" waits behind the third ask of the old look; when that one is superseded too, "b" is sent, with all of its retries.
    await answer(2, SUPERSEDED);
    for (let i = 3; i < 3 + OUTSIDE_RETRIES; i++) await answer(i, SUPERSEDED);
    expect(asks.filter((a) => a.layer.value === "b")).toHaveLength(OUTSIDE_RETRIES + 1);
    expect(pending(queue)).toBe(true);
  });

  test("superseded with a newer look waiting, the newer look is sent instead of the old one again", async () => {
    const { queue, asks, answer } = engine();
    queue.request(layer());
    queue.request(layer({ value: "b" }));
    await answer(0, SUPERSEDED);
    expect(asks.map((a) => a.layer.value)).toEqual(["sunday reset", "b"]);
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

describe("what counts as the engine refusing a caption (the preview's «refused» mark)", () => {
  test("a caption rule (TEXT_INVALID) and a drawing that failed (RENDER_FAILED) are the engine's refusals", () => {
    expect(isEngineRefusal(charset)).toBe(true);
    expect(isEngineRefusal({ kind: "failed", error: { code: "RENDER_FAILED", detail: "timeout" } })).toBe(true);
  });

  test("a picture, a transport failure and giving up after outside supersedes are not", async () => {
    expect(isEngineRefusal(picture("preview-0001"))).toBe(false);
    expect(isEngineRefusal({ kind: "failed", error: { code: "INTERNAL", detail: "the text preview could not be asked for" } })).toBe(false);
    const { queue, answer } = engine();
    queue.request(layer());
    for (let i = 0; i <= OUTSIDE_RETRIES; i++) await answer(i, SUPERSEDED);
    const gaveUp = queue.get("layer-001").shown?.answer;
    expect(gaveUp === undefined ? true : isEngineRefusal(gaveUp)).toBe(false);
  });
});

describe("refusedNow: the preview marks the picture only when the engine refused the caption as it is now", () => {
  test("a refusal of the newest look marks it; a refusal of an older look, a picture or giving up does not", async () => {
    const { queue, answer } = engine();
    queue.request(layer({ value: "привет" }));
    await answer(0, charset);
    expect(refusedNow(queue.get("layer-001"), previewLook(layer({ value: "привет" })))).toBe(true);
    expect(refusedNow(queue.get("layer-001"), previewLook(layer({ value: "hello" })))).toBe(false);
    queue.request(layer({ value: "hello" }));
    await answer(1, picture("preview-0002"));
    expect(refusedNow(queue.get("layer-001"), previewLook(layer({ value: "hello" })))).toBe(false);
    queue.request(layer({ value: "elsewhere" }));
    for (let i = 2; i <= 2 + OUTSIDE_RETRIES; i++) await answer(i, SUPERSEDED);
    expect(queue.get("layer-001").shown?.answer.kind).toBe("failed");
    expect(refusedNow(queue.get("layer-001"), previewLook(layer({ value: "elsewhere" })))).toBe(false);
    expect(refusedNow(NO_PREVIEW, previewLook(layer()))).toBe(false);
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
