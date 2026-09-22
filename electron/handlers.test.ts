import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COVER_FILTERS,
  IMAGE_EXTENSIONS,
  PICKER_FILTERS,
  VIDEO_EXTENSIONS,
  pickCoverForHost,
  probeForHost,
  runBatchForHost,
  type BatchHost,
} from "./handlers";
import { CH } from "./ipc";
import { makeTestClip, makeTestHeif, makeTestPhoto } from "../src/node/testClip";
import type { Backends, MediaBackend } from "../src/node/mediaRoute";
import type { MediaInfo, StartOptions } from "../src/core/types";

const photoInfo: MediaInfo = {
  kind: "photo",
  durationSec: 0,
  width: 640,
  height: 480,
  hasAudio: false,
};

const videoInfo: MediaInfo = {
  kind: "video",
  durationSec: 2,
  width: 320,
  height: 240,
  hasAudio: true,
};

/** Stands in for a real executor: these tests are about what the host does with
 *  a probe, not about ffprobe, which has its own coverage. */
class StubBackend<R> implements MediaBackend<R> {
  constructor(private readonly info: MediaInfo) {}
  async probe(): Promise<MediaInfo> {
    return this.info;
  }
  async render(_input: string, _info: MediaInfo, _recipe: R, _output: string): Promise<void> {}
  async extractGrayFrames(_input: string, _count: number): Promise<Uint8Array[]> {
    return [new Uint8Array(64 * 64)];
  }
  async extractThumbnail(): Promise<string> {
    return "";
  }
  /** Part of the photo backend only; this stub serves both halves. */
  async sampleEdgeColor(): Promise<string> {
    return "0x000000";
  }
  cancel(): void {}
  async warmup(): Promise<void> {}
  async replace(): Promise<void> {}
  async discard(): Promise<void> {}
}

function stubBackends(): Backends {
  return {
    video: new StubBackend(videoInfo),
    photo: new StubBackend(photoInfo),
  };
}

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "uniq-host-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("the picker offers HEIC and HEIF, so such a file can be chosen at all", () => {
  // Drag-and-drop and the CLI both surface the "convert this file" message.
  // Leaving the extension out of the dialog greys the file out instead, which
  // tells the user nothing about why their photo is not selectable.
  expect(IMAGE_EXTENSIONS).toContain("heic");
  expect(IMAGE_EXTENSIONS).toContain("heif");
});

test("every picker filter offers only lowercase, dot-less extensions", () => {
  // Electron matches the extension case-sensitively and rejects a leading dot.
  for (const filter of PICKER_FILTERS) {
    expect(filter.extensions.length).toBeGreaterThan(0);
    for (const ext of filter.extensions) {
      expect(ext).toBe(ext.toLowerCase());
      expect(ext.startsWith(".")).toBe(false);
    }
  }
});

test("the combined filter offers exactly the video and image extensions", () => {
  // The combined entry comes first so the dialog opens showing everything the
  // app can take; it must not drift from the two lists behind it.
  expect(PICKER_FILTERS[0].extensions).toEqual([...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS]);
});

test("a probe of an unreadable format reports its own message instead of throwing", async () => {
  // Thrown out of an ipcMain handler, this message reaches the renderer wrapped
  // as `Error invoking remote method 'probe': Error: …`. Reporting it the way
  // the start handler reports its failures is what keeps the advice readable.
  const heif = join(dir, "shot.heic");
  makeTestHeif(heif);
  const reported: string[] = [];

  const info = await probeForHost(heif, stubBackends(), (m) => reported.push(m));

  expect(info).toBeNull();
  expect(reported.length).toBe(1);
  expect(reported[0]).toContain("HEIC");
  expect(reported[0]).not.toContain("invoking remote method");
});

test("a probe of a readable still returns its info and reports nothing", async () => {
  const still = join(dir, "still.jpg");
  makeTestPhoto(still);
  const reported: string[] = [];

  const info = await probeForHost(still, stubBackends(), (m) => reported.push(m));

  expect(info).toEqual(photoInfo);
  expect(reported).toEqual([]);
});

// ── the batch handler, with a fake `send` ───────────────────────────────────

/** More set bytes => larger PDQ distance from an all-zero frame. */
function frameOfDistance(d: number): Uint8Array {
  const f = new Uint8Array(64 * 64);
  for (let i = 0; i < d * 30; i++) f[i] = 255;
  return f;
}

/** Every rendered copy is far from the source and — unless told otherwise —
 *  identical to every other copy, so a 2-copy batch trips the post-pass. The
 *  thumbnail takes a real turn of the event loop, the way ffmpeg does. */
class BatchStub extends StubBackend<unknown> {
  thumbnails = 0;
  constructor(
    info: MediaInfo,
    private readonly frameFor: (path: string) => Uint8Array,
    private readonly behaviour: {
      failRenderOf?: (output: string) => boolean;
      /** How long the n-th thumbnail (1-based) takes. */
      thumbDelayMs?: (n: number) => number;
    } = {}
  ) {
    super(info);
  }
  async render(_input: string, _info: MediaInfo, _recipe: unknown, output: string): Promise<void> {
    if (this.behaviour.failRenderOf?.(output)) throw new Error(`ffmpeg exited 1: ${output}`);
  }
  async extractGrayFrames(input: string, count: number): Promise<Uint8Array[]> {
    const frame = input.endsWith("in.jpg") ? new Uint8Array(64 * 64) : this.frameFor(input);
    return Array.from({ length: count }, () => frame);
  }
  async extractThumbnail(): Promise<string> {
    const n = ++this.thumbnails;
    await new Promise((r) => setTimeout(r, this.behaviour.thumbDelayMs?.(n) ?? 5));
    return `thumb-${n}`;
  }
}

const startOpts: StartOptions = {
  strength: 1.0,
  exportFormat: "original",
  allowMirror: false,
  targetDistance: 30,
  identity: "engine",
  edgeMode: "crop",
};

interface Sent {
  channel: string;
  payload: unknown;
}

async function runStubbedBatch(
  count: number,
  frameFor: (path: string) => Uint8Array,
  behaviour: ConstructorParameters<typeof BatchStub>[2] = {},
  outDir = join(dir, "out")
): Promise<Sent[]> {
  const input = join(dir, "in.jpg");
  makeTestPhoto(input);
  const sent: Sent[] = [];
  const host: BatchHost = {
    backends: {
      video: new BatchStub(videoInfo, frameFor, behaviour),
      photo: new BatchStub(photoInfo, frameFor, behaviour),
    },
    send: (channel, payload) => sent.push({ channel, payload }),
    signal: new AbortController().signal,
    nowMs: () => 1_780_000_000_000,
    concurrency: 1,
  };
  await runBatchForHost({ input, opts: startOpts, count, outDir }, host);
  return sent;
}

const thumbOf = (payload: unknown): string =>
  typeof payload === "object" && payload !== null && "thumb" in payload && typeof payload.thumb === "string"
    ? payload.thumb
    : "";
const indexOf = (payload: unknown): number =>
  typeof payload === "object" && payload !== null && "index" in payload && typeof payload.index === "number"
    ? payload.index
    : -1;

test("the batch-done event follows the last copy-done event, thumbnail and all", async () => {
  // `onCopyDone` awaits a thumbnail and the pipeline does not await the
  // callback, so with a single copy the batch-done event used to beat the
  // card it was summing up.
  const sent = await runStubbedBatch(1, () => frameOfDistance(5));
  const channels = sent.map((s) => s.channel);
  expect(channels).toContain(CH.evtCopyDone);
  expect(channels.lastIndexOf(CH.evtCopyDone)).toBeLessThan(channels.indexOf(CH.evtBatchDone));
  expect(channels[channels.length - 1]).toBe(CH.evtBatchDone);
});

test("reports the inter-copy check to the renderer as its own event", async () => {
  // Two identical copies: the post-pass fires and regenerates copy 2. Without
  // this event the renderer shows every card done and a Stop button, for as
  // long as the regenerations take — 3 min 40 s on a real 50-copy run.
  const sent = await runStubbedBatch(2, () => frameOfDistance(5));
  const phases = sent.filter((s) => s.channel === CH.evtPostPass).map((s) => s.payload);
  expect(phases[0]).toEqual({ done: 0, total: 2 });
  expect(phases.length).toBeGreaterThan(1);
  // And the regenerated copy is reported done again, after the phase began.
  const channels = sent.map((s) => s.channel);
  const phaseStart = channels.indexOf(CH.evtPostPass);
  expect(channels.slice(phaseStart)).toContain(CH.evtCopyDone);
  expect(channels[channels.length - 1]).toBe(CH.evtBatchDone);
});

test("copy-done reports settle before the error event too", async () => {
  // Copy 1 is done and its thumbnail is in flight when copy 2's render fails.
  // The error must not overtake the card it would otherwise leave behind.
  const sent = await runStubbedBatch(2, () => frameOfDistance(5), {
    failRenderOf: (output) => output.endsWith("_2.jpg"),
  });
  const channels = sent.map((s) => s.channel);
  expect(channels).toContain(CH.evtCopyDone);
  expect(channels).toContain(CH.evtError);
  expect(channels.lastIndexOf(CH.evtCopyDone)).toBeLessThan(channels.indexOf(CH.evtError));
});

test("an output directory that cannot be created is reported, not thrown across IPC", async () => {
  // Thrown, this reaches the renderer as an unhandled rejection of `start`,
  // with the Run button stuck on Stop. `/dev/null` is a file, so nothing can
  // be created beneath it.
  const sent = await runStubbedBatch(1, () => frameOfDistance(5), {}, join("/dev/null", "out"));
  const channels = sent.map((s) => s.channel);
  expect(channels).toEqual([CH.evtError]);
});

test("two reports for one copy arrive in the order the copy was done, whatever the thumbnails take", async () => {
  // Copy 2's first thumbnail is slow; the regenerated copy's thumbnails are
  // fast. Independent promises would let the regeneration's report — and its
  // thumbnail — reach the card first, and the slow original overwrite it.
  const sent = await runStubbedBatch(2, () => frameOfDistance(5), {
    thumbDelayMs: (n) => (n <= 2 ? 20 : 1),
  });
  const forCopy2 = sent.filter((s) => s.channel === CH.evtCopyDone && indexOf(s.payload) === 1);
  expect(forCopy2.length).toBeGreaterThan(1);
  const thumbs = forCopy2.map((s) => Number(thumbOf(s.payload).replace("thumb-", "")));
  expect(thumbs).toEqual([...thumbs].sort((a, b) => a - b));
});

// ── the cover picker, and photo mode at the batch boundary ─────────────────

test("the cover picker filter offers exactly the image extensions", () => {
  // The dialog behind «Выбрать фото» takes stills only; a video chosen there
  // would be refused at Run with a message, but greying it out is kinder.
  expect(COVER_FILTERS.length).toBe(1);
  expect(COVER_FILTERS[0].extensions).toEqual(IMAGE_EXTENSIONS);
});

test("picking a still as the cover returns its path and a thumbnail to show beside it", async () => {
  const still = join(dir, "cover.jpg");
  makeTestPhoto(still, 320, 240);
  const backends: Backends = {
    video: new BatchStub(videoInfo, () => frameOfDistance(5)),
    photo: new BatchStub(photoInfo, () => frameOfDistance(5)),
  };
  const reported: string[] = [];

  const picked = await pickCoverForHost(still, backends, (m) => reported.push(m));

  expect(picked).toEqual({ path: still, thumb: "thumb-1" });
  expect(reported).toEqual([]);
});

test("picking a HEIC as the cover reports the convert-it advice and returns null", async () => {
  const heif = join(dir, "cover.heic");
  makeTestHeif(heif);
  const reported: string[] = [];

  const picked = await pickCoverForHost(heif, stubBackends(), (m) => reported.push(m));

  expect(picked).toBeNull();
  expect(reported.length).toBe(1);
  expect(reported[0]).toContain("HEIC");
  expect(reported[0]).not.toContain("invoking remote method");
});

test("picking footage as the cover reports that the first frame takes a still, and returns null", async () => {
  const clip = join(dir, "cover.mp4");
  makeTestClip(clip);
  const reported: string[] = [];

  const picked = await pickCoverForHost(clip, stubBackends(), (m) => reported.push(m));

  expect(picked).toBeNull();
  expect(reported.length).toBe(1);
  expect(reported[0].toLowerCase()).toContain("still");
  expect(reported[0]).toContain(clip);
});

test("a photo first frame with no cover is reported as an error event, and no copy is done", async () => {
  // The renderer disables Run until a cover is chosen, but the request is
  // the boundary: a payload that slipped through must be refused with the
  // same sentence, as an event — thrown, it would arrive wrapped in IPC.
  const input = join(dir, "clip-in.mp4");
  makeTestClip(input);
  const sent: Sent[] = [];
  const host: BatchHost = {
    backends: {
      video: new BatchStub(videoInfo, () => frameOfDistance(5)),
      photo: new BatchStub(photoInfo, () => frameOfDistance(5)),
    },
    send: (channel, payload) => sent.push({ channel, payload }),
    signal: new AbortController().signal,
    nowMs: () => 1_780_000_000_000,
    concurrency: 1,
  };
  await runBatchForHost(
    { input, opts: { ...startOpts, firstFrame: "photo", coverPath: null }, count: 1, outDir: join(dir, "out-nocover") },
    host
  );
  const channels = sent.map((s) => s.channel);
  expect(channels).toEqual([CH.evtError]);
  const message = sent[0].payload;
  expect(typeof message === "object" && message !== null && "message" in message ? String(message.message) : "")
    .toContain("cover");
});
