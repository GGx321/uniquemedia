import { join, basename } from "node:path";
import { mkdirSync } from "node:fs";
import {
  outputName,
  routeForInput,
  uniquifyRoute,
  type Backends,
  type MediaRoute,
} from "../src/node/mediaRoute";
import { assertStillCover } from "../src/node/mediaRoute";
import type { MediaInfo, StartOptions } from "../src/core/types";
import { CH, type CoverPick } from "./ipc";

/**
 * The half of the desktop host that has nothing to do with Electron: what the
 * file picker offers, and what happens when identifying a file fails. It lives
 * apart from `main.ts` so it can be exercised without an Electron runtime —
 * `main.ts` imports `app`, `dialog` and `ipcMain` at module scope and cannot be
 * loaded by a test at all.
 */

export const VIDEO_EXTENSIONS = ["mp4", "mov", "mkv", "webm", "avi"];

/**
 * `heic`/`heif` are here although the bundled ffmpeg cannot open either. The
 * app has a good answer for such a file — "convert it to JPEG or PNG" — and
 * drag-and-drop and the CLI both give it. Omitting the extension from the
 * dialog does not spare the user the failure; it greys the file out with no
 * explanation at all, which is the one outcome that teaches them nothing.
 */
export const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "heic", "heif"];

export interface PickerFilter {
  name: string;
  extensions: string[];
}

/** The combined entry comes first so the dialog opens showing everything the
 *  app can take; the narrower two are there for someone who wants to filter. */
export const PICKER_FILTERS: PickerFilter[] = [
  { name: "Медиа", extensions: [...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS] },
  { name: "Видео", extensions: VIDEO_EXTENSIONS },
  { name: "Изображения", extensions: IMAGE_EXTENSIONS },
];

/** The dialog behind «Выбрать фото»: stills only. */
export const COVER_FILTERS: PickerFilter[] = [{ name: "Изображения", extensions: IMAGE_EXTENSIONS }];

/**
 * Takes the file the cover dialog returned and turns it into what the panel
 * shows: the path, and a thumbnail read by the still backend.
 *
 * Checked here, at pick time, rather than only at Run: a cover that is not a
 * still — a HEIC this build cannot open, a clip chosen through drag-and-drop
 * — gets its sentence the moment it is chosen, through `report`, and the
 * panel is left with no cover rather than one it will be refused for later.
 * Same null-plus-report contract as `probeForHost`, for the same reason.
 */
export async function pickCoverForHost(
  path: string,
  backends: Backends,
  report: (message: string) => void
): Promise<CoverPick | null> {
  try {
    await assertStillCover(path);
    return { path, thumb: await backends.photo.extractThumbnail(path) };
  } catch (err) {
    report(err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Identifies `input` and probes it through the route its own bytes select.
 *
 * Returns null rather than throwing on failure, and hands the message to
 * `report`. An error thrown inside an `ipcMain.handle` callback reaches the
 * renderer as `Error invoking remote method 'probe': Error: …`, which buries
 * the one actionable sentence — how to convert a HEIC, say — inside IPC
 * plumbing the user has no use for. The batch handler already reports its
 * failures this way; this is the same contract for the same reason.
 */
export async function probeForHost(
  input: string,
  backends: Backends,
  report: (message: string) => void
): Promise<MediaInfo | null> {
  try {
    const route = await routeForInput(input, backends);
    return await route.executor.probe(input);
  } catch (err) {
    report(err instanceof Error ? err.message : String(err));
    return null;
  }
}

export interface StartRequest {
  input: string;
  opts: StartOptions;
  count: number;
  outDir: string;
}

/** What `runBatchForHost` needs from the Electron process, handed in so the
 *  batch can be driven — and its event order pinned — with none of Electron
 *  loaded. */
export interface BatchHost {
  backends: Backends;
  /** `win.webContents.send` in production; a recorder in a test. */
  send: (channel: string, payload: unknown) => void;
  signal: AbortSignal;
  nowMs: () => number;
  concurrency: number;
  /** Told the route as soon as it is chosen (and `null` once the batch is
   *  over), so Stop can target the executor that is actually running. */
  onRoute?: (route: MediaRoute | null) => void;
}

/**
 * Runs one batch for the desktop host and reports it as renderer events.
 * Every outcome, including failure, arrives as an event: an error thrown out
 * of an `ipcMain.handle` callback reaches the renderer wrapped in IPC
 * plumbing, which is why nothing is thrown from here.
 */
export async function runBatchForHost(req: StartRequest, host: BatchHost): Promise<void> {
  const { input, opts, count, outDir } = req;
  const { send } = host;
  const stem = basename(input).replace(/\.[^.]+$/, "");
  // Each copy-done report awaits a thumbnail, and the pipeline does not await
  // the callback — so they are collected, per copy, and settled before the
  // batch is summed up (or its failure reported), or the closing event beats
  // the last card. Per copy, because a regenerated copy is reported twice and
  // the second report's thumbnail must not overtake the first's.
  const reports = new Map<number, Promise<void>>();
  try {
    mkdirSync(outDir, { recursive: true });
    // The kind is decided from the file's own bytes, not from whatever the
    // renderer believed when it probed.
    const route = await routeForInput(input, host.backends);
    host.onRoute?.(route);
    const now = host.nowMs();
    const results = await uniquifyRoute(route, input, opts, count, {
      seedBase: now % 1e6,
      // The clock the spoofed capture dates are measured back from. Omitting it
      // is what dated every GUI copy to 1969; the CLI passed it from day one.
      nowMs: now,
      concurrency: host.concurrency,
      outputPath: (i) => join(outDir, outputName(stem, i, route)),
      signal: host.signal,
      onProgress: (index, _attempt, fraction) =>
        send(CH.evtProgress, { index, count, fraction }),
      onPostPass: (done, total) => send(CH.evtPostPass, { done, total }),
      onCopyDone: (r) => {
        const previous = reports.get(r.index) ?? Promise.resolve();
        const report = previous
          .then(() => route.executor.extractThumbnail(r.outputPath))
          .catch(() => "")
          .then((thumb) =>
            send(CH.evtCopyDone, { index: r.index, path: r.outputPath, thumb, verify: r.verify })
          );
        reports.set(r.index, report);
      },
    });
    await Promise.allSettled(reports.values());
    const passed = results.filter((r) => r.verify.passed).length;
    send(CH.evtBatchDone, { passed, total: count });
  } catch (err) {
    await Promise.allSettled(reports.values());
    send(CH.evtError, { message: err instanceof Error ? err.message : String(err) });
  } finally {
    host.onRoute?.(null);
  }
}
