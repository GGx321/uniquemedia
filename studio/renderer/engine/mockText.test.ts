import { describe, expect, test } from "bun:test";
import type { TextLayer } from "../../shared/engine";
import { MockTextPreviews } from "./mockText";

const layer = (value: string, layerId = "layer-00000001"): TextLayer => ({ kind: "text", layerId, startMs: 0, endMs: 3000, value, font: "manrope", style: "plaque", color: "#ffffff", x: 0.5, y: 0.2, scale: 1 });
const scheduler = { schedule: (_ms: number, task: () => void) => (task(), () => undefined) };

describe("the lane when a drawing breaks in a way nobody foresaw", () => {
  test("answers INTERNAL, and the next preview is still drawn", async () => {
    let n = 0;
    let broken = true;
    const mock = new MockTextPreviews({
      scheduler,
      drawMs: 0,
      newId: () => {
        if (broken) {
          broken = false;
          throw new Error("boom");
        }
        return `preview-${String(++n).padStart(4, "0")}`;
      },
    });
    const first = await mock.preview(layer("first"));
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error.code).toBe("INTERNAL");
    const second = await mock.preview(layer("second"));
    expect(second.ok).toBe(true);
  });

  test("the failure carries no message from the exception", async () => {
    const mock = new MockTextPreviews({ scheduler, drawMs: 0, newId: () => { throw new Error("/secret/path"); } });
    const outcome = await mock.preview(layer("x"));
    expect(JSON.stringify(outcome)).not.toContain("secret");
  });
});
