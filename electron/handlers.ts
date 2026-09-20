import { routeForInput, type Backends } from "../src/node/mediaRoute";
import type { MediaInfo } from "../src/core/types";

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
