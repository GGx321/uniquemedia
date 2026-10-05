import { describe, expect, test } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import type { TextLayer } from "../../../shared/engine";
import type { TextPreviewOutcome } from "../../engine/textPreview";
import { TextPreviewQueue } from "../../engine/textPreviewQueue";
import { textLayer } from "./testkit";
import { useRefusedCaptions } from "./textPreviews";

// «Рендер» waits for the verdict the caption panel shows: a refusal of the layer's CURRENT look (a cluster the real emoji font lacks, which no
// local rule can know) is read from the draft's one queue, and a refusal of an older value is stale.

const PICTURE: TextPreviewOutcome = { kind: "picture", previewId: "preview-0001", width: 400, height: 90, url: null };
const REFUSED: TextPreviewOutcome = { kind: "invalid", captionIssue: "emoji-missing", error: { code: "TEXT_INVALID", captionIssue: "emoji-missing" } };

/** A queue whose engine refuses the value "tofu" and draws everything else. */
const queueOf = (): TextPreviewQueue => new TextPreviewQueue(async (layer) => (layer.value === "tofu" ? REFUSED : PICTURE));
const layerWith = (value: string): TextLayer => ({ ...textLayer(0, 0, 1_000), value });

describe("useRefusedCaptions", () => {
  test("lists a layer once the engine's preview refused its caption", async () => {
    const queue = queueOf();
    const layer = layerWith("tofu");
    queue.request(layer);
    const { result } = renderHook(() => useRefusedCaptions(queue, [layer]));
    await waitFor(() => expect([...result.current]).toEqual([layer.layerId]));
  });

  test("lists nothing for a caption the engine drew", async () => {
    const queue = queueOf();
    const layer = layerWith("fine");
    queue.request(layer);
    const { result } = renderHook(() => useRefusedCaptions(queue, [layer]));
    await waitFor(() => expect(queue.get(layer.layerId).shown).not.toBeNull());
    expect(result.current.size).toBe(0);
  });

  test("follows a layer added later: the refusal that arrives after the rerender is seen", async () => {
    const queue = queueOf();
    const first = layerWith("fine");
    const added = { ...layerWith("tofu"), layerId: "layer-002" };
    queue.request(first);
    const { result, rerender } = renderHook(({ layers }) => useRefusedCaptions(queue, layers), { initialProps: { layers: [first] } });
    await waitFor(() => expect(queue.get(first.layerId).shown).not.toBeNull());
    rerender({ layers: [first, added] });
    queue.request(added);
    await waitFor(() => expect([...result.current]).toEqual([added.layerId]));
  });

  test("drops the layer when its value is edited: the refusal of the older value is stale", async () => {
    const queue = queueOf();
    const refused = layerWith("tofu");
    queue.request(refused);
    const { result, rerender } = renderHook(({ layers }) => useRefusedCaptions(queue, layers), { initialProps: { layers: [refused] } });
    await waitFor(() => expect(result.current.size).toBe(1));
    rerender({ layers: [layerWith("fine now")] });
    expect(result.current.size).toBe(0);
  });
});
