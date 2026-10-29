import { describe, expect, test } from "bun:test";
import { type EngineError, type TextLayer } from "../../shared/engine";
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


describe("a text preview that draws", () => {
  test("answers an id and the box in pixels, inside the 1080x1920 frame", async () => {
    const answer = await unwrap(preview(makeMock()));
    expect(answer.previewId.length).toBeGreaterThan(0);
    expect(answer.width).toBeGreaterThan(0);
    expect(answer.width).toBeLessThanOrEqual(1080);
    expect(answer.height).toBeGreaterThan(0);
    expect(answer.height).toBeLessThanOrEqual(1920);
  });

});

describe("a caption that breaks a technical rule", () => {
  test("Cyrillic is TEXT_INVALID with the rule charset, and the engine's wording", async () => {
    const error = await refused(preview(makeMock(), { value: "привет" }));
    expect(error.code).toBe("TEXT_INVALID");
    expect(error.captionIssue).toBe("charset");
    expect(error.detail).toBe('text rasteriser: the caption breaks the rule "charset"');
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

});

