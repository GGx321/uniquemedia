import type { MediaInfo, StartOptions } from "../src/core/types";

/** What the cover dialog hands the renderer: the path the batch will send
 *  back as `coverPath`, and a thumbnail (a data URL) to show beside its name. */
export interface CoverPick {
  path: string;
  thumb: string;
}

export const CH = {
  pickFile: "pick-file",
  pickCover: "pick-cover",
  probe: "probe",
  chooseOutDir: "choose-out-dir",
  start: "start",
  cancel: "cancel",
  openFile: "open-file",
  reveal: "reveal-in-folder",
  // events (main -> renderer):
  evtProgress: "evt:batch-progress",
  evtCopyDone: "evt:copy-done",
  evtPostPass: "evt:post-pass",
  evtBatchDone: "evt:batch-done",
  evtError: "evt:error",
} as const;

export interface Api {
  pickFile(): Promise<string | null>;
  /** An image-only open dialog for the photo first frame. Null when cancelled
   *  — or when the chosen file is not a still the app can open, in which case
   *  the main process has already said why through `onError`. */
  pickCover(): Promise<CoverPick | null>;
  /** Resolve the absolute path of a dropped File (Electron webUtils). */
  getDroppedPath(file: File): string;
  /** Null when the file could not be identified: the main process has already
   *  reported the reason through `onError`, unwrapped. */
  probe(path: string): Promise<MediaInfo | null>;
  chooseOutDir(): Promise<string | null>;
  start(req: { input: string; opts: StartOptions; count: number; outDir: string }): Promise<void>;
  cancel(): Promise<void>;
  openFile(path: string): Promise<void>;
  revealInFolder(path: string): Promise<void>;
  onBatchProgress(cb: (p: { index: number; count: number; fraction: number }) => void): void;
  /** Fires again for a copy the inter-copy post-pass regenerated. */
  onCopyDone(cb: (c: { index: number; path: string; thumb: string; verify: { minDistance: number; passed: boolean } }) => void): void;
  /** The inter-copy check after the last copy: `done` of `total` settled. */
  onPostPass(cb: (p: { done: number; total: number }) => void): void;
  onBatchDone(cb: (s: { passed: number; total: number }) => void): void;
  onError(cb: (e: { message: string }) => void): void;
}
