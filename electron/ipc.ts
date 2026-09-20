import type { MediaInfo, StartOptions } from "../src/core/types";

export const CH = {
  pickFile: "pick-file",
  probe: "probe",
  chooseOutDir: "choose-out-dir",
  start: "start",
  cancel: "cancel",
  openFile: "open-file",
  reveal: "reveal-in-folder",
  // events (main -> renderer):
  evtProgress: "evt:batch-progress",
  evtCopyDone: "evt:copy-done",
  evtBatchDone: "evt:batch-done",
  evtError: "evt:error",
} as const;

export interface Api {
  pickFile(): Promise<string | null>;
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
  onCopyDone(cb: (c: { index: number; path: string; thumb: string; verify: { minDistance: number; passed: boolean } }) => void): void;
  onBatchDone(cb: (s: { passed: number; total: number }) => void): void;
  onError(cb: (e: { message: string }) => void): void;
}
