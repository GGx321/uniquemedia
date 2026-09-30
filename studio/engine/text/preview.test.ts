import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TextLayer } from "../../shared/engine/montage";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { EngineFailure } from "../engineFailure";
import type { CaptionRequest } from "./caption/types";
import { RASTER_ERROR_CODES, RasterError, type RasterErrorCode } from "./rasterTypes";
import { createTextPreviewService, PREVIEW_HINT_RU, type PreviewGate } from "./preview";
import type { CaptionCallOptions, GateCaption } from "./worker/textGate";
useNativeGlobals();

// The preview service against a fake gate: what is written where, what a caller gets back for each way the gate can
// fail, and the rule that only QUEUED stale calls are cancelled. The real worker behind it is pinned elsewhere.

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "studio-preview-"));
  dirs.push(dir);
  return dir;
}

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
  y: 0.2,
  scale: 1,
  ...over,
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function captioned(over: Partial<GateCaption> = {}): GateCaption {
  return { png: PNG, width: 640, height: 130, layout: { fontSize: 56, lines: ["sunday reset"], width: 640, height: 130 }, workerMs: 3, ...over };
}

interface Call {
  request: CaptionRequest;
  options: CaptionCallOptions;
  settle: (value: GateCaption | Error) => void;
}

/** A gate whose calls wait until the test settles them. `lane` runs them one at a time, like the real gate. */
function scriptedGate(): { gate: PreviewGate; calls: Call[]; startNext: () => void } {
  const calls: Call[] = [];
  const queue: (() => void)[] = [];
  let busy = false;
  const startNext = (): void => {
    busy = false;
    queue.shift()?.();
  };
  const gate: PreviewGate = {
    caption(request, options = {}) {
      return new Promise<GateCaption>((resolve, reject) => {
        const call: Call = {
          request,
          options,
          settle: (value) => {
            startNext();
            if (value instanceof Error) reject(value);
            else resolve(value);
          },
        };
        const run = (): void => {
          busy = true;
          options.onStart?.();
          calls.push(call);
        };
        const onAbort = (): void => {
          const at = queue.indexOf(run);
          if (at >= 0) queue.splice(at, 1);
          reject(options.signal?.reason);
        };
        if (options.signal?.aborted === true) return reject(options.signal.reason);
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (busy) queue.push(run);
        else run();
      });
    },
  };
  return { gate, calls, startNext };
}

let counter = 0;
const newId = (): string => `preview-${String(++counter).padStart(8, "0")}`;
const log: string[] = [];

function service(gate: PreviewGate, dir: string | null, over: { loadError?: () => string | undefined; maxFiles?: number } = {}) {
  return createTextPreviewService({ gate, dir: () => dir, newId, log: (line) => log.push(line), ...over });
}

async function failureOf(promise: Promise<unknown>): Promise<EngineFailure> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof EngineFailure)) throw new Error(`expected an EngineFailure, got ${String(error)}`);
  return error;
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

describe("a preview", () => {
  test("writes the gate's PNG to <dir>/<previewId>.png and answers the id and the size", async () => {
    const dir = await scratch();
    const { gate, calls } = scriptedGate();
    const pending = service(gate, dir).preview(layer());
    await tick();
    calls[0]?.settle(captioned());
    const result = await pending;
    expect(result.width).toBe(640);
    expect(result.height).toBe(130);
    expect(result.previewId).toMatch(/^[a-z0-9-]{8,64}$/);
    expect(new Uint8Array(await readFile(join(dir, `${result.previewId}.png`)))).toEqual(PNG);
  });

  test("hands the gate the layer's drawing fields, and nothing of its timing or place", async () => {
    const dir = await scratch();
    const { gate, calls } = scriptedGate();
    const pending = service(gate, dir).preview(layer({ font: "caveat", style: "outline", color: "#ffd166", scale: 1.7, value: "hi \u{1F600}" }));
    await tick();
    expect(calls[0]?.request).toEqual({ value: "hi \u{1F600}", font: "caveat", style: "outline", color: "#ffd166", scale: 1.7 });
    calls[0]?.settle(captioned());
    await pending;
  });

  test("creates the folder when it does not exist yet", async () => {
    const dir = join(await scratch(), "render-tmp", "text");
    const { gate, calls } = scriptedGate();
    const pending = service(gate, dir).preview(layer());
    await tick();
    calls[0]?.settle(captioned());
    const { previewId } = await pending;
    expect((await stat(join(dir, `${previewId}.png`))).isFile()).toBe(true);
  });

  test("leaves no temp file behind", async () => {
    const dir = await scratch();
    const { gate, calls } = scriptedGate();
    const pending = service(gate, dir).preview(layer());
    await tick();
    calls[0]?.settle(captioned());
    await pending;
    expect((await readdir(dir)).every((name) => name.endsWith(".png"))).toBe(true);
  });

  test("gives each preview its own id", async () => {
    const dir = await scratch();
    const { gate, calls } = scriptedGate();
    const svc = service(gate, dir);
    const first = svc.preview(layer({ layerId: "layer-00000001" }));
    await tick();
    calls[0]?.settle(captioned());
    const second = svc.preview(layer({ layerId: "layer-00000002" }));
    await tick();
    calls[1]?.settle(captioned());
    expect((await first).previewId).not.toBe((await second).previewId);
  });
});

describe("the files it keeps", () => {
  test("holds at most maxFiles previews, dropping the oldest", async () => {
    const dir = await scratch();
    const { gate, calls } = scriptedGate();
    const svc = service(gate, dir, { maxFiles: 3 });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const pending = svc.preview(layer({ layerId: `layer-0000000${i}` }));
      await tick();
      calls[i]?.settle(captioned());
      ids.push((await pending).previewId);
    }
    expect((await readdir(dir)).sort()).toEqual(ids.slice(2).map((id) => `${id}.png`).sort());
  });

  test("clears what a previous run left in the folder before it writes its first", async () => {
    const dir = await scratch();
    await Bun.write(join(dir, "old-preview-1.png"), PNG);
    await Bun.write(join(dir, ".old-temp"), "x");
    const { gate, calls } = scriptedGate();
    const pending = service(gate, dir).preview(layer());
    await tick();
    calls[0]?.settle(captioned());
    const { previewId } = await pending;
    expect(await readdir(dir)).toEqual([`${previewId}.png`]);
  });
});

describe("how a failure is answered", () => {
  async function failWith(error: Error, over: { loadError?: () => string | undefined } = {}): Promise<EngineFailure> {
    const dir = await scratch();
    const { gate, calls } = scriptedGate();
    const pending = service(gate, dir, over).preview(layer());
    await tick();
    calls[0]?.settle(error);
    return failureOf(pending);
  }

  test("a caption rule is TEXT_INVALID carrying the rule", async () => {
    const failure = await failWith(new RasterError("CAPTION_INVALID", "the caption breaks the rule", { captionIssue: "too-long" }));
    expect(failure.error.code).toBe("TEXT_INVALID");
    expect(failure.error.captionIssue).toBe("too-long");
  });

  test.each([["RENDER_TIMEOUT"], ["WORKER_FAILED"], ["RENDER_FAILED"], ["SVG_TOO_LARGE"], ["RASTER_TOO_LARGE"], ["OUTPUT_TOO_LARGE"], ["BROKEN"], ["WASM_UNAVAILABLE"], ["FONT_UNAVAILABLE"], ["NOT_INITIALISED"]] satisfies [RasterErrorCode][])(
    "%s is RENDER_FAILED, and never a caption rule",
    async (code) => {
      const failure = await failWith(new RasterError(code, "it broke"));
      expect(failure.error.code).toBe("RENDER_FAILED");
      expect(failure.error.captionIssue).toBeUndefined();
    },
  );

  test("every code the worker can send is mapped: only CAPTION_INVALID is TEXT_INVALID", async () => {
    for (const code of RASTER_ERROR_CODES) {
      if (code === "CAPTION_INVALID") continue;
      expect((await failWith(new RasterError(code, "x"))).error.code).toBe("RENDER_FAILED");
    }
  });

  test("both timeouts, the gate's wall and the worker's own, carry the hint to shrink the caption or change the style", async () => {
    const wall = await failWith(new RasterError("RENDER_TIMEOUT", "the worker did not answer within 3000 ms and was terminated"));
    const inside = await failWith(new RasterError("RENDER_TIMEOUT", "the call took 3100 ms, over 3000 ms"));
    for (const failure of [wall, inside]) {
      expect(failure.error.code).toBe("RENDER_FAILED");
      expect(failure.error.detail).toContain(PREVIEW_HINT_RU);
    }
    expect(PREVIEW_HINT_RU).toBe("уменьшите размер или смените стиль");
  });

  test("a plain render failure carries no such hint", async () => {
    expect((await failWith(new RasterError("RENDER_FAILED", "resvg refused"))).error.detail).not.toContain(PREVIEW_HINT_RU);
  });

  test("a failure that is not a RasterError is INTERNAL, without its message", async () => {
    const failure = await failWith(new Error("secret path /Users/alex/x"));
    expect(failure.error.code).toBe("INTERNAL");
    expect(failure.error.detail ?? "").not.toContain("/Users/alex");
  });

  test("a gate that never loaded says why in the detail", async () => {
    const failure = await failWith(new RasterError("WORKER_FAILED", "the text worker could not load: no wasm"), { loadError: () => "WASM_UNAVAILABLE: missing" });
    expect(failure.error.code).toBe("RENDER_FAILED");
    expect(failure.error.detail).toContain("WASM_UNAVAILABLE: missing");
  });

  test("the detail is bounded to what the contract allows", async () => {
    const failure = await failWith(new RasterError("RENDER_FAILED", "x".repeat(5000)));
    expect((failure.error.detail ?? "").length).toBeLessThanOrEqual(500);
  });

  test("no folder to write to is RENDER_FAILED, and the gate is not even asked", async () => {
    const { gate, calls } = scriptedGate();
    const failure = await failureOf(service(gate, null).preview(layer()));
    expect(failure.error.code).toBe("RENDER_FAILED");
    expect(calls).toHaveLength(0);
  });

  test("a file that cannot be written is RENDER_FAILED, and names no path", async () => {
    const dir = await scratch();
    await Bun.write(join(dir, "blocker"), "a file where the folder should be");
    const { gate, calls } = scriptedGate();
    const pending = service(gate, join(dir, "blocker", "text")).preview(layer());
    await tick();
    calls[0]?.settle(captioned());
    const failure = await failureOf(pending);
    expect(failure.error.code).toBe("RENDER_FAILED");
    expect(failure.error.detail ?? "").not.toContain(dir);
  });
});

describe("stale previews", () => {
  test("a newer preview of the same layer cancels an older one that is still QUEUED, and the older is answered as superseded", async () => {
    const dir = await scratch();
    const { gate, calls } = scriptedGate();
    const svc = service(gate, dir);
    const running = svc.preview(layer({ layerId: "layer-00000009", value: "another layer" }));
    await tick();
    const stale = svc.preview(layer({ value: "typing" }));
    await tick();
    const stalled = failureOf(stale);
    const fresh = svc.preview(layer({ value: "typing more" }));
    expect((await stalled).error.code).toBe("TEXT_PREVIEW_SUPERSEDED");
    calls[0]?.settle(captioned());
    await running;
    await tick();
    expect(calls.map((c) => c.request.value)).toEqual(["another layer", "typing more"]);
    calls[1]?.settle(captioned({ width: 700 }));
    expect((await fresh).width).toBe(700);
  });

  test("a newer preview never cancels an older one that is already RUNNING: the old answer arrives, and the worker is not killed", async () => {
    const dir = await scratch();
    const { gate, calls } = scriptedGate();
    const svc = service(gate, dir);
    const first = svc.preview(layer({ value: "first" }));
    await tick();
    expect(calls).toHaveLength(1);
    const second = svc.preview(layer({ value: "second" }));
    await tick();
    expect(calls[0]?.options.signal?.aborted).toBe(false);
    calls[0]?.settle(captioned({ width: 111 }));
    expect((await first).width).toBe(111);
    await tick();
    calls[1]?.settle(captioned({ width: 222 }));
    expect((await second).width).toBe(222);
  });

  test("previews of different layers never cancel each other", async () => {
    const dir = await scratch();
    const { gate, calls } = scriptedGate();
    const svc = service(gate, dir);
    const a = svc.preview(layer({ layerId: "layer-0000000a" }));
    await tick();
    const b = svc.preview(layer({ layerId: "layer-0000000b" }));
    const c = svc.preview(layer({ layerId: "layer-0000000c" }));
    await tick();
    calls[0]?.settle(captioned());
    await tick();
    calls[1]?.settle(captioned());
    await tick();
    calls[2]?.settle(captioned());
    await Promise.all([a, b, c]);
    expect(calls).toHaveLength(3);
  });

  test("of three previews of one layer queued behind a running one, only the last runs", async () => {
    const dir = await scratch();
    const { gate, calls } = scriptedGate();
    const svc = service(gate, dir);
    const blocker = svc.preview(layer({ layerId: "layer-00000009" }));
    await tick();
    const one = failureOf(svc.preview(layer({ value: "one" })));
    await tick();
    const two = failureOf(svc.preview(layer({ value: "two" })));
    await tick();
    const three = svc.preview(layer({ value: "three" }));
    expect((await one).error.code).toBe("TEXT_PREVIEW_SUPERSEDED");
    expect((await two).error.code).toBe("TEXT_PREVIEW_SUPERSEDED");
    calls[0]?.settle(captioned());
    await blocker;
    await tick();
    expect(calls.map((c) => c.request.value)).toEqual(["sunday reset", "three"]);
    calls[1]?.settle(captioned());
    await three;
  });

  test("a superseded call writes no file", async () => {
    const dir = await scratch();
    const { gate, calls } = scriptedGate();
    const svc = service(gate, dir);
    const blocker = svc.preview(layer({ layerId: "layer-00000009" }));
    await tick();
    const stale = failureOf(svc.preview(layer({ value: "stale" })));
    await tick();
    const fresh = svc.preview(layer({ value: "fresh" }));
    await stale;
    calls[0]?.settle(captioned());
    await blocker;
    await tick();
    calls[1]?.settle(captioned());
    await fresh;
    expect(await readdir(dir)).toHaveLength(2);
  });

  test("a failed newer preview still leaves the older one superseded, and the next preview of the layer starts clean", async () => {
    const dir = await scratch();
    const { gate, calls } = scriptedGate();
    const svc = service(gate, dir);
    const bad = failureOf(svc.preview(layer({ value: "bad" })));
    await tick();
    calls[0]?.settle(new RasterError("RENDER_FAILED", "x"));
    expect((await bad).error.code).toBe("RENDER_FAILED");
    const next = svc.preview(layer({ value: "next" }));
    await tick();
    calls[1]?.settle(captioned());
    await next;
  });
});
