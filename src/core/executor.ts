import type { MediaInfo, Recipe } from "./types";
import type { DeviceProfile } from "./deviceProfile";

/**
 * Host-provided FFmpeg backend. core depends only on this interface so the same
 * engine runs under Electron (spawn), a Node server, or ffmpeg.wasm.
 */
export interface RenderExecutor {
  probe(input: string): Promise<MediaInfo>;
  render(
    input: string,
    info: MediaInfo,
    recipe: Recipe,
    output: string,
    onProgress?: (fraction: number) => void
  ): Promise<void>;
  /** Returns `count` evenly-spaced frames as 64x64 grayscale buffers (4096 bytes each). */
  extractGrayFrames(input: string, count: number): Promise<Uint8Array[]>;
  /** Writes iPhone-style QuickTime metadata tags to an already-rendered file. */
  applyDeviceMetadata?(output: string, profile: DeviceProfile): Promise<void>;
}
