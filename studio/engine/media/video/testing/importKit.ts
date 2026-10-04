import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ffmpegPath } from "../../../../node/ffmpegBinary";
import type { MediaImportRequest } from "../../imports";
import { formatOf, SNIFF_HEAD_BYTES } from "../../sniff";
import { createVideoImporter } from "../../videoImporter";
import type { StagedMedia, WorkFile } from "../../staging";
import { CHART, CHART_PATCHES, patchRect } from "./chart";
import { FIXTURES, type VideoFixtureName } from "./fixtures/index";

// Test-only: what the importer's tests share (a request as the import job makes one, a decoded frame, the mean of a chart patch). Production
// code never imports this file.

/**
 * The real video importer with the shortest-clip bound off (`minDurationMs: 0`), for a test whose clip is a few frames long (the committed fixtures are 3 to 14 frames, under the
 * 0.5 s a clip must have, 3f.6): such a test is about something else, and an option the caller gives still wins. The bound itself is tested with the real default
 * (`videoImporter.short.test.ts`).
 */
export const createVideoImporterForShortClips = (options: Parameters<typeof createVideoImporter>[0] = {}): ReturnType<typeof createVideoImporter> => createVideoImporter({ minDurationMs: 0, ...options });

/** A staged copy of `bytes` (or of a fixture) in `dir`, as the import job's staging would have made it. */
export async function stage(dir: string, source: VideoFixtureName | Uint8Array, name = "staged.media"): Promise<StagedMedia> {
  const path = join(dir, name);
  if (typeof source === "string") await copyFile(FIXTURES[source].file, path);
  else await writeFile(path, source);
  const bytes = new Uint8Array(await readFile(path));
  const head = bytes.subarray(0, SNIFF_HEAD_BYTES);
  return {
    stagingId: name.replace(/\..*$/, ""),
    kind: "video",
    format: formatOf(head) ?? "mp4",
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    path,
    head,
    dispose: async () => undefined,
  };
}

export interface Rig {
  request: MediaImportRequest;
  controller: AbortController;
  /** Every work file the importer asked for. */
  workFiles: WorkFile[];
  released: string[];
}

/** A request for `staged` with a fresh work-file source in `dir`. */
export function requestFor(dir: string, staged: StagedMedia): Rig {
  const controller = new AbortController();
  const workFiles: WorkFile[] = [];
  const released: string[] = [];
  const request: MediaImportRequest = {
    staged,
    name: "clip.mov",
    signal: controller.signal,
    workFile: async () => {
      const path = join(dir, `work-${workFiles.length + 1}.media`);
      const file: WorkFile = { path, release: async () => void released.push(path) };
      workFiles.push(file);
      return file;
    },
  };
  return { request, controller, workFiles, released };
}

/** The first frame of a file as raw planar 8-bit 4:2:0, decoded by ffmpeg with no conversion but the pixel format (its own autorotate included). */
export function decodeFirstFrame(path: string): Uint8Array {
  const run = spawnSync(ffmpegPath(), ["-hide_banner", "-v", "error", "-nostdin", "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "yuv420p", "pipe:1"], { maxBuffer: 1 << 28 });
  if (run.status !== 0) throw new Error(`ffmpeg could not decode the frame: ${run.stderr.toString()}`);
  return new Uint8Array(run.stdout);
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Where chart patch `index` is in a picture the chart (192 x 96, as made) was turned by `rotation` degrees clockwise: the patch's inside
 * rectangle, carried through the turn. Even coordinates stay even, so the 4:2:0 chroma planes line up.
 */
export function rotatedPatchRect(index: number, rotation: 0 | 90 | 180 | 270): Rect {
  const r = patchRect(index);
  const { width, height } = CHART;
  switch (rotation) {
    case 0:
      return r;
    case 90:
      return { x0: height - r.y1, y0: r.x0, x1: height - r.y0, y1: r.x1 };
    case 180:
      return { x0: width - r.x1, y0: height - r.y1, x1: width - r.x0, y1: height - r.y0 };
    case 270:
      return { x0: r.y0, y0: width - r.x1, x1: r.y1, y1: width - r.x0 };
  }
}

/** The mean Y, Cb and Cr over `rect` of a raw 4:2:0 picture. */
export function rectMeans(raw: Uint8Array, width: number, height: number, rect: Rect): [number, number, number] {
  const mean = (plane: number, planeWidth: number, x0: number, y0: number, x1: number, y1: number): number => {
    const base = plane === 0 ? 0 : width * height + (plane - 1) * (width / 2) * (height / 2);
    let sum = 0;
    let count = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        sum += raw[base + y * planeWidth + x] ?? 0;
        count++;
      }
    }
    return sum / count;
  };
  return [
    mean(0, width, rect.x0, rect.y0, rect.x1, rect.y1),
    mean(1, width / 2, rect.x0 >> 1, rect.y0 >> 1, rect.x1 >> 1, rect.y1 >> 1),
    mean(2, width / 2, rect.x0 >> 1, rect.y0 >> 1, rect.x1 >> 1, rect.y1 >> 1),
  ];
}

/** Every patch's mean in a picture the chart was turned by `rotation` degrees. */
export function chartMeans(raw: Uint8Array, width: number, height: number, rotation: 0 | 90 | 180 | 270 = 0): [number, number, number][] {
  return CHART_PATCHES.map((_, index) => rectMeans(raw, width, height, rotatedPatchRect(index, rotation)));
}

/** The largest distance of any code of `got` from `want`, and where. */
export function worstDistance(got: readonly (readonly number[])[], want: readonly (readonly number[])[]): { distance: number; patch: number; plane: number } {
  let worst = { distance: 0, patch: -1, plane: -1 };
  got.forEach((means, patch) =>
    means.forEach((value, plane) => {
      const distance = Math.abs(value - (want[patch]?.[plane] ?? Number.NaN));
      if (!(distance <= worst.distance)) worst = { distance, patch, plane };
    }),
  );
  return worst;
}

/** Whether the text `needle` occurs in `haystack` (for proving a string of the source did not reach the output). */
export function contains(haystack: Uint8Array, needle: string): boolean {
  const text = Buffer.from(haystack).toString("latin1");
  return text.includes(needle);
}
