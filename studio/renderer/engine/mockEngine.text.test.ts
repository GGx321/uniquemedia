import { describe, expect, test } from "bun:test";
import { CAPTION_ISSUES, type EngineError, type TextLayer } from "../../shared/engine";
import { makeMock, unwrap, type Mock } from "./mockEngine.testkit";

// 3d.1b: the dev mock answers `montages.textPreview` as the engine does (studio/engine/text/preview.ts): the shared technical caption
// rules, the picture's box inside the frame, a PNG a window can show, TEXT_PREVIEW_SUPERSEDED for a stale queued preview of the
// same layer, and the engine's per-layer eviction. The same stories run against the real engine in studio/engine/parity.

const MIA = "avatar-mia-0001";
const layer = (over: Partial<TextLayer> = {}): TextLayer => ({
  kind: "text",
  layerId: "layer-00000001",
  startMs: 0,
  endMs: 3000,
  value: "sunday reset",
  font: "manrope",
  style: "plaque",
  color: "#ffffff",
  x: 0.5,
  y: 0.195,
  scale: 1,
  ...over,
});
const preview = (mock: Mock, over: Partial<TextLayer> = {}) => mock.client.request("montages.textPreview", { avatarId: MIA, layer: layer(over) });

async function refused(reply: ReturnType<typeof preview>): Promise<EngineError> {
  const answer = await reply;
  if (answer.ok) throw new Error("expected a refusal");
  return answer.error;
}

/** Lets every promise that can settle without the clock settle. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe("a text preview that draws", () => {
  test("answers an id and the box in pixels, inside the 1080x1920 frame", async () => {
    const answer = await unwrap(preview(makeMock()));
    expect(answer.previewId.length).toBeGreaterThan(0);
    expect(answer.width).toBeGreaterThan(0);
    expect(answer.width).toBeLessThanOrEqual(1080);
    expect(answer.height).toBeGreaterThan(0);
    expect(answer.height).toBeLessThanOrEqual(1920);
  });

  test("the id is served as a PNG whose size is the box it answered", async () => {
    const mock = makeMock();
    const answer = await unwrap(preview(mock));
    const bytes = mock.engine.mockPreviewPng(answer.previewId);
    expect(bytes === null).toBe(false);
    if (bytes === null) return;
    expect([...bytes.slice(0, 8)]).toEqual(PNG_SIGNATURE);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(16)).toBe(answer.width);
    expect(view.getUint32(20)).toBe(answer.height);
  });

  test("an id nobody was given is not served", () => {
    expect(makeMock().engine.mockPreviewPng("preview-9999") === null).toBe(true);
  });

  test("every preview gets its own id, also for the same layer asked twice", async () => {
    const mock = makeMock();
    const first = await unwrap(preview(mock));
    const second = await unwrap(preview(mock));
    expect(first.previewId).not.toBe(second.previewId);
  });

  test("a longer caption makes a wider box, up to the frame", async () => {
    const mock = makeMock();
    const short = await unwrap(preview(mock, { value: "hi" }));
    const long = await unwrap(preview(mock, { value: "sunday reset with the whole crew" }));
    expect(long.width).toBeGreaterThan(short.width);
    expect(long.width).toBeLessThanOrEqual(1080);
  });

  test("a bigger scale makes a bigger box", async () => {
    const mock = makeMock();
    const small = await unwrap(preview(mock, { scale: 0.5 }));
    const large = await unwrap(preview(mock, { scale: 2 }));
    expect(large.height).toBeGreaterThan(small.height);
  });

  test("two lines are taller than one", async () => {
    const mock = makeMock();
    const one = await unwrap(preview(mock, { value: "one" }));
    const two = await unwrap(preview(mock, { value: "one\r\ntwo" }));
    expect(two.height).toBeGreaterThan(one.height);
  });
});

describe("a caption that breaks a technical rule", () => {
  test("Cyrillic is TEXT_INVALID with the rule charset, and the engine's wording", async () => {
    const error = await refused(preview(makeMock(), { value: "привет" }));
    expect(error.code).toBe("TEXT_INVALID");
    expect(error.captionIssue).toBe("charset");
    expect(error.detail).toBe('text rasteriser: the caption breaks the rule "charset"');
  });

  test("three lines are TEXT_INVALID: too-many-lines", async () => {
    const error = await refused(preview(makeMock(), { value: "a\nb\nc" }));
    expect(error.captionIssue).toBe("too-many-lines");
  });

  test("a lone regional indicator is emoji-missing", async () => {
    expect((await refused(preview(makeMock(), { value: "\u{1F1FA}" }))).captionIssue).toBe("emoji-missing");
  });

  test("a text-style emoji (VS15) is emoji-text-style", async () => {
    expect((await refused(preview(makeMock(), { value: "\u{2764}\u{FE0E}" }))).captionIssue).toBe("emoji-text-style");
  });

  test("a caption that breaks several rules names the first of them in the contract's order", async () => {
    const error = await refused(preview(makeMock(), { value: "привет\na\nb" }));
    expect(error.captionIssue).toBe(CAPTION_ISSUES[0]);
  });

  test("an emoji the font draws is a picture, not an issue", async () => {
    const answer = await unwrap(preview(makeMock(), { value: "hi \u{2728}" }));
    expect(answer.width).toBeGreaterThan(0);
  });

  test("a caption of only spaces breaks no rule, and has no picture: RENDER_FAILED, nothing to draw", async () => {
    const error = await refused(preview(makeMock(), { value: "   " }));
    expect(error.code).toBe("RENDER_FAILED");
    expect(error.detail).toBe("text rendering failed (RENDER_FAILED): text rasteriser: the caption has nothing to draw");
  });

  test("a payload that breaks the contract is VALIDATION before anything is drawn", async () => {
    const error = await refused(preview(makeMock(), { color: "white" }));
    expect(error.code).toBe("VALIDATION");
  });

  test("a refused caption leaves no picture to serve", async () => {
    const mock = makeMock();
    await refused(preview(mock, { value: "привет" }));
    const next = await unwrap(preview(mock));
    expect(next.previewId).toBe("preview-0001");
  });
});

describe("a stale preview", () => {
  async function held(): Promise<Mock> {
    const mock = makeMock();
    mock.engine.holdTextDrawing(true);
    return mock;
  }

  test("a preview waiting behind another of the same layer is answered TEXT_PREVIEW_SUPERSEDED at once, the newest is drawn", async () => {
    const mock = await held();
    const answers: string[] = [];
    const ask = (name: string, over: Partial<TextLayer>): Promise<void> =>
      preview(mock, over).then((a) => void answers.push(`${name}:${a.ok ? "ok" : a.error.code}`));
    const first = ask("first", { value: "first" });
    await tick();
    const second = ask("second", { value: "second" });
    await tick();
    const third = ask("third", { value: "third" });
    await tick();
    expect(answers).toEqual(["second:TEXT_PREVIEW_SUPERSEDED"]);
    mock.engine.releaseTextDrawing();
    await first;
    await tick();
    mock.engine.releaseTextDrawing();
    await Promise.all([second, third]);
    expect(answers).toEqual(["second:TEXT_PREVIEW_SUPERSEDED", "first:ok", "third:ok"]);
  });

  test("a preview that is already being drawn is never cancelled by a newer one", async () => {
    const mock = await held();
    const first = preview(mock, { value: "first" });
    await tick();
    const second = preview(mock, { value: "second" });
    await tick();
    mock.engine.releaseTextDrawing();
    expect((await first).ok).toBe(true);
    await tick();
    mock.engine.releaseTextDrawing();
    expect((await second).ok).toBe(true);
  });

  test("different layers never supersede each other", async () => {
    const mock = await held();
    const first = preview(mock, { layerId: "layer-00000001", value: "one" });
    await tick();
    const queued = preview(mock, { layerId: "layer-00000002", value: "two" });
    await tick();
    const other = preview(mock, { layerId: "layer-00000003", value: "three" });
    await tick();
    mock.engine.holdTextDrawing(false);
    const answers = await Promise.all([first, queued, other]);
    expect(answers.map((a) => a.ok)).toEqual([true, true, true]);
  });

  test("a superseded preview is answered before the picture it was waiting behind", async () => {
    const mock = await held();
    const order: string[] = [];
    const first = preview(mock, { value: "first" }).then(() => void order.push("first"));
    await tick();
    const second = preview(mock, { value: "second" }).then(() => void order.push("second"));
    await tick();
    const third = preview(mock, { value: "third" }).then(() => void order.push("third"));
    await tick();
    mock.engine.holdTextDrawing(false);
    await Promise.all([first, second, third]);
    expect(order).toEqual(["second", "first", "third"]);
  });

  test("a superseded preview has no picture, and the newest has one", async () => {
    const mock = await held();
    const first = preview(mock, { value: "first" });
    await tick();
    const dropped = preview(mock, { value: "dropped" });
    await tick();
    const newest = preview(mock, { value: "newest" });
    await tick();
    mock.engine.holdTextDrawing(false);
    const [a, b, c] = await Promise.all([first, dropped, newest]);
    expect(b.ok).toBe(false);
    expect(a.ok && mock.engine.mockPreviewPng(a.result.previewId) !== null).toBe(true);
    expect(c.ok && mock.engine.mockPreviewPng(c.result.previewId) !== null).toBe(true);
  });

  test("a refused caption holds the lane like a drawing does: the one waiting behind it is still superseded by a newer one", async () => {
    const mock = await held();
    const bad = preview(mock, { value: "привет" });
    await tick();
    const waiting = preview(mock, { value: "waiting" });
    await tick();
    const newest = preview(mock, { value: "newest" });
    await tick();
    mock.engine.holdTextDrawing(false);
    const answers = await Promise.all([bad, waiting, newest]);
    expect(answers.map((a) => (a.ok ? "ok" : a.error.code))).toEqual(["TEXT_INVALID", "TEXT_PREVIEW_SUPERSEDED", "ok"]);
  });
});

describe("the previews kept", () => {
  test("past 64, the oldest preview that is not a layer's newest goes first", async () => {
    const mock = makeMock();
    const ids: string[] = [];
    for (let i = 0; i < 64; i++) ids.push((await unwrap(preview(mock, { layerId: "layer-00000001", value: `a${i}` }))).previewId);
    const other = (await unwrap(preview(mock, { layerId: "layer-00000002", value: "b" }))).previewId;
    expect(mock.engine.mockPreviewPng(ids[0] ?? "") === null).toBe(true);
    expect(mock.engine.mockPreviewPng(ids[1] ?? "") === null).toBe(false);
    expect(mock.engine.mockPreviewPng(other) === null).toBe(false);
  });

  test("a layer's newest preview outlasts the older ones of a layer that was dragged", async () => {
    const mock = makeMock();
    const kept = (await unwrap(preview(mock, { layerId: "layer-00000002", value: "kept" }))).previewId;
    for (let i = 0; i < 80; i++) await unwrap(preview(mock, { layerId: "layer-00000001", value: `a${i}` }));
    expect(mock.engine.mockPreviewPng(kept) === null).toBe(false);
  });

  test("past four times the bound a caller inventing layers loses the oldest, even a layer's newest", async () => {
    const mock = makeMock();
    const first = (await unwrap(preview(mock, { layerId: "layer-00000000", value: "first" }))).previewId;
    for (let i = 1; i <= 256; i++) await unwrap(preview(mock, { layerId: `layer-${String(i).padStart(8, "0")}`, value: "x" }));
    expect(mock.engine.mockPreviewPng(first) === null).toBe(true);
  });
});

describe("the dev window's picture", () => {
  test("the mock client hands out the PNG as a data URL for an id it holds, and null for one it does not", async () => {
    const mock = makeMock();
    const answer = await unwrap(preview(mock));
    expect(mock.client.textPreviewUrl?.(answer.previewId)?.startsWith("data:image/png;base64,")).toBe(true);
    expect(mock.client.textPreviewUrl?.("preview-9999")).toBe(null);
  });
});
