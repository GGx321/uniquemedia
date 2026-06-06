import type { CopyOptions, MediaInfo } from "../core/types";

export type CopyStatus = "pending" | "rendering" | "done" | "error";

export interface UiCopy {
  index: number;
  name: string;
  status: CopyStatus;
  fraction?: number;
  thumb?: string;
  verify?: { minDistance: number; passed: boolean };
  error?: string;
}

export interface StartRequest {
  input: string;
  opts: CopyOptions;
  count: number;
  outDir: string;
}

export type { CopyOptions, MediaInfo };
