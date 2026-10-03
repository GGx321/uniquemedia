import { describe, expect, test } from "bun:test";
import type { TextLayer } from "../../shared/engine";
import { textPreviewUrl } from "../lib/media";
import type { EngineClient } from "./client";
import { makeMock } from "./mockEngine.testkit";
import { requestTextPreview } from "./textPreview";

// 3d.1b: how the editor's text tab asks for a preview and what it makes of the answer. TEXT_PREVIEW_SUPERSEDED is not an error to the
// window (the engine dropped a stale preview of the layer a newer one replaced): it is told apart from a failure, so nothing
// shows it. Run on the mock; the engine's own refusals are the same codes (studio/engine/parity).

const AVATAR = "avatar-mia-0001";
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
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("requestTextPreview", () => {
  test("a drawn preview is a picture with its id, its box and an address the window can show", async () => {
    const mock = makeMock();
    const outcome = await requestTextPreview(mock.client, AVATAR, layer());
    expect(outcome.kind).toBe("picture");
    if (outcome.kind !== "picture") return;
    expect(outcome.width).toBeGreaterThan(0);
    expect(outcome.height).toBeGreaterThan(0);
    expect(outcome.url?.startsWith("data:image/png;base64,")).toBe(true);
  });

  test("a preview that a newer one of the layer replaced is superseded, not a failure", async () => {
    const mock = makeMock();
    mock.engine.holdTextDrawing(true);
    const first = requestTextPreview(mock.client, AVATAR, layer({ value: "first" }));
    await tick();
    const stale = requestTextPreview(mock.client, AVATAR, layer({ value: "stale" }));
    await tick();
    const newest = requestTextPreview(mock.client, AVATAR, layer({ value: "newest" }));
    await tick();
    mock.engine.holdTextDrawing(false);
    expect((await stale).kind).toBe("superseded");
    expect((await first).kind).toBe("picture");
    expect((await newest).kind).toBe("picture");
  });

  test("a caption that breaks a rule is invalid, with the rule", async () => {
    const outcome = await requestTextPreview(makeMock().client, AVATAR, layer({ value: "привет" }));
    expect(outcome.kind).toBe("invalid");
    if (outcome.kind === "invalid") expect(outcome.captionIssue).toBe("charset");
  });

  test("a caption with nothing to draw is a failure, with the engine's error", async () => {
    const outcome = await requestTextPreview(makeMock().client, AVATAR, layer({ value: "  " }));
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.error.code).toBe("RENDER_FAILED");
  });

  test("any other refusal is a failure, with the engine's error", async () => {
    const mock = makeMock();
    mock.engine.failNext("montages.textPreview", { code: "RENDER_FAILED", detail: "text rendering ran out of time" });
    const outcome = await requestTextPreview(mock.client, AVATAR, layer());
    expect(outcome.kind).toBe("failed");
  });
});

describe("textPreviewUrl", () => {
  const real = (kind: EngineClient["kind"]): Pick<EngineClient, "kind" | "textPreviewUrl"> => ({ kind });

  test("the real engine's picture is served by main as studio-media://text/<previewId>", () => {
    expect(textPreviewUrl(real("window"), "preview-0001")).toBe("studio-media://text/preview-0001");
  });

  test("an id that breaks the contract has no address", () => {
    expect(textPreviewUrl(real("window"), "../photo")).toBe(null);
  });

  test("the mock's picture is whatever the mock client says", async () => {
    const mock = makeMock();
    const outcome = await requestTextPreview(mock.client, AVATAR, layer());
    if (outcome.kind !== "picture") throw new Error("expected a picture");
    expect(textPreviewUrl(mock.client, outcome.previewId)).toBe(outcome.url);
    expect(textPreviewUrl(mock.client, "preview-9999")).toBe(null);
  });
});
