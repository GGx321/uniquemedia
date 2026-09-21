import type { IdentityMode, MediaInfo, Recipe } from "./types";
import type { DeviceProfile } from "./deviceProfile";

/**
 * Host-provided FFmpeg backend. core depends only on this interface so the same
 * engine runs under Electron (spawn), a Node server, or ffmpeg.wasm.
 */
export interface RenderExecutor<R = Recipe> {
  probe(input: string): Promise<MediaInfo>;
  render(
    input: string,
    info: MediaInfo,
    recipe: R,
    output: string,
    onProgress?: (fraction: number) => void
  ): Promise<void>;
  /** Returns `count` evenly-spaced frames as 64x64 grayscale buffers (4096 bytes each). */
  extractGrayFrames(input: string, count: number): Promise<Uint8Array[]>;
  /**
   * Gives an already-rendered file the identity the batch asked for. Called for
   * EVERY shipped render, whatever the mode: the executor alone knows what a
   * mode means for its medium (`engine` is a no-op for both today; `clean`
   * strips a JPEG's JFIF and comment but patches a MOV's sample entry), and a
   * pipeline that skipped "the mode that does nothing" would be deciding that
   * on the executor's behalf. `profile` is the device the copy would claim if
   * the mode asks for one; it is derived from the copy's slot, not the render.
   */
  applyIdentity?(output: string, identity: IdentityMode, profile: DeviceProfile): Promise<void>;
}
