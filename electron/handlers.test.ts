import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMAGE_EXTENSIONS, PICKER_FILTERS, VIDEO_EXTENSIONS, probeForHost } from "./handlers";
import { makeTestHeif, makeTestPhoto } from "../src/node/testClip";
import type { Backends, MediaBackend } from "../src/node/mediaRoute";
import type { MediaInfo } from "../src/core/types";

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
  async render(): Promise<void> {}
  async extractGrayFrames(): Promise<Uint8Array[]> {
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
