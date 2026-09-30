import { describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { useNativeGlobals } from "../testing/nativeGlobals";
import type { PreviewGate } from "./text/preview";
import { RasterError } from "./text/rasterTypes";
import type { GateCaption } from "./text/worker/textGate";
import { command, failed, ok, startEngine, useEngineDir } from "./testing/engineHarness";
useNativeGlobals();

// `montages.textPreview` through the engine: the command as main sends it, parsed by the contract both ways, over a fake
// text gate (what the real worker does is pinned by worker/textCaption.real.node-test.ts and the service's own tests).

const dir = useEngineDir("studio-engine-text-preview-");
const renderTmp = () => join(dir(), "userData", "render-tmp");
const textDir = () => join(renderTmp(), "text");

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
const layer = (over: Record<string, unknown> = {}) => ({
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
const payload = (over: Record<string, unknown> = {}) => ({ avatarId: "avatar-0001", layer: layer(over) });

const picture: GateCaption = { png: PNG, width: 640, height: 130, layout: { fontSize: 56, lines: ["sunday reset"], width: 640, height: 130 }, workerMs: 2 };
const drawing: PreviewGate = { caption: async () => picture };

const start = (text: { gate: PreviewGate; loadError?: () => string | undefined } | undefined, extra: { renderTmpDir?: string } = {}) =>
  startEngine(dir(), { init: { renderTmpDir: extra.renderTmpDir ?? renderTmp() }, deps: text === undefined ? {} : { text } });

describe("montages.textPreview", () => {
  test("answers an id and the raster size, and the PNG is where the media route serves it", async () => {
    const { engine } = await start({ gate: drawing });
    const done = ok(await engine.handle(command("montages.textPreview", payload())));
    const result = done.result as { previewId: string; width: number; height: number };
    expect(result).toMatchObject({ width: 640, height: 130 });
    expect(new Uint8Array(await readFile(join(textDir(), `${result.previewId}.png`)))).toEqual(PNG);
  });

  test("hands the gate the layer's drawing fields only", async () => {
    const seen: unknown[] = [];
    const { engine } = await start({ gate: { caption: async (request) => (seen.push(request), picture) } });
    ok(await engine.handle(command("montages.textPreview", payload({ font: "caveat", style: "none", color: "#9ad9ff", scale: 1.5, value: "hi", x: 0.9, y: 0.1, startMs: 500, endMs: 900 }))));
    expect(seen).toEqual([{ value: "hi", font: "caveat", style: "none", color: "#9ad9ff", scale: 1.5 }]);
  });

  test("a caption rule is TEXT_INVALID and names the rule", async () => {
    const gate: PreviewGate = { caption: async () => Promise.reject(new RasterError("CAPTION_INVALID", "the caption breaks the rule", { captionIssue: "charset" })) };
    const { engine } = await start({ gate });
    const error = failed(await engine.handle(command("montages.textPreview", payload()))).error;
    expect(error.code).toBe("TEXT_INVALID");
    expect(error.captionIssue).toBe("charset");
  });

  test("a rasteriser timeout is RENDER_FAILED with the hint to shrink the caption or change the style, and is not retried", async () => {
    let calls = 0;
    const gate: PreviewGate = { caption: async () => (calls++, Promise.reject(new RasterError("RENDER_TIMEOUT", "the worker did not answer within 3000 ms and was terminated"))) };
    const { engine } = await start({ gate });
    const error = failed(await engine.handle(command("montages.textPreview", payload()))).error;
    expect(error.code).toBe("RENDER_FAILED");
    expect(error.detail).toContain("уменьшите размер или смените стиль");
    expect(calls).toBe(1);
  });

  test("a text worker that never loaded is RENDER_FAILED and says why", async () => {
    const gate: PreviewGate = { caption: async () => Promise.reject(new RasterError("WORKER_FAILED", "the text worker could not load: no wasm")) };
    const { engine } = await start({ gate, loadError: () => "WASM_UNAVAILABLE: no wasm" });
    const error = failed(await engine.handle(command("montages.textPreview", payload()))).error;
    expect(error.code).toBe("RENDER_FAILED");
    expect(error.detail).toContain("WASM_UNAVAILABLE: no wasm");
  });

  test("an engine started without a text gate answers RENDER_FAILED, never a made-up picture", async () => {
    const { engine } = await start(undefined);
    const error = failed(await engine.handle(command("montages.textPreview", payload()))).error;
    expect(error.code).toBe("RENDER_FAILED");
    expect(error.detail).toMatch(/text/i);
  });

  test("an engine started without a render-tmp folder answers RENDER_FAILED", async () => {
    const { engine } = await startEngine(dir(), { init: { renderTmpDir: undefined }, deps: { text: { gate: drawing } } });
    expect(failed(await engine.handle(command("montages.textPreview", payload()))).error.code).toBe("RENDER_FAILED");
  });

  test("a preview waiting behind another of the same layer is dropped as superseded, and only the newest is drawn", async () => {
    const released: (() => void)[] = [];
    const drawn: string[] = [];
    let busy = false;
    const waiting: (() => void)[] = [];
    const gate: PreviewGate = {
      caption: (request, options = {}) =>
        new Promise<GateCaption>((resolve, reject) => {
          const run = (): void => {
            busy = true;
            options.onStart?.();
            drawn.push(request.value);
            released.push(() => {
              busy = false;
              waiting.shift()?.();
              resolve(picture);
            });
          };
          options.signal?.addEventListener(
            "abort",
            () => {
              const at = waiting.indexOf(run);
              if (at >= 0) waiting.splice(at, 1);
              reject(options.signal?.reason);
            },
            { once: true },
          );
          if (busy) waiting.push(run);
          else run();
        }),
    };
    const { engine } = await start({ gate });
    const first = engine.handle(command("montages.textPreview", payload({ value: "first" })));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = engine.handle(command("montages.textPreview", payload({ value: "second" })));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const third = engine.handle(command("montages.textPreview", payload({ value: "third" })));
    expect(failed(await second).error.code).toBe("TEXT_PREVIEW_SUPERSEDED");
    released[0]?.();
    ok(await first);
    await new Promise((resolve) => setTimeout(resolve, 20));
    released[1]?.();
    ok(await third);
    expect(drawn).toEqual(["first", "third"]);
  });
});

describe("the text folder and the start-up sweep", () => {
  test("the render-tmp sweep at start leaves the text folder alone: a preview written just after start must not be swept", async () => {
    await mkdir(textDir(), { recursive: true });
    await writeFile(join(textDir(), "old-preview-1.png"), PNG);
    await mkdir(join(renderTmp(), "leftover-job"), { recursive: true });
    const { engine } = await start({ gate: drawing });
    await engine.settled();
    expect(await readdir(renderTmp())).toEqual(["text"]);
    expect(await readdir(textDir())).toEqual(["old-preview-1.png"]);
  });

  test("the first preview clears what an earlier run left in the text folder", async () => {
    await mkdir(textDir(), { recursive: true });
    await writeFile(join(textDir(), "old-preview-1.png"), PNG);
    const { engine } = await start({ gate: drawing });
    const result = ok(await engine.handle(command("montages.textPreview", payload()))).result as { previewId: string };
    expect(await readdir(textDir())).toEqual([`${result.previewId}.png`]);
  });
});
