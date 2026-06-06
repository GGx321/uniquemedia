export interface MediaInfo {
  durationSec: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

export type ExportFormat = "reels" | "feed" | "square";

export const EXPORT_DIMS: Record<ExportFormat, { w: number; h: number }> = {
  reels: { w: 1080, h: 1920 },
  feed: { w: 1080, h: 1350 },
  square: { w: 1080, h: 1080 },
};

export interface CopyOptions {
  strength: number; // visual-change multiplier, ~0.5..1.5, default 1.0
  exportFormat: ExportFormat;
  keepTrendAudio: boolean;
  allowMirror: boolean;
  targetDistance: number; // Hamming distance (0..256) the copy must exceed
  spoofMetadata: boolean;
}

export interface Operation {
  id: string;
  params: Record<string, number | boolean | string>;
}

export interface Recipe {
  seed: number;
  intensity: number; // 1.0 baseline; raised on auto-strengthen
  exportFormat: ExportFormat;
  keepTrendAudio: boolean;
  spoof: boolean;
  video: Operation[];
  audio: Operation[];
}

export interface VerifyResult {
  minDistance: number;
  passed: boolean;
  perFrame: number[];
}
