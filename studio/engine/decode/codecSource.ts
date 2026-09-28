/**
 * Pinned identities of the two WASM codec binaries the engine's own image
 * decoder (wasmDecode.ts) loads from disk (never `fetch`, never the
 * network): mozjpeg's decoder (via `@jsquash/jpeg`) and squoosh's PNG
 * decoder (via `@jsquash/png`). Both ship inside the npm package itself
 * (`node_modules/@jsquash/*`, committed to `bun.lock`, bundled into
 * `app.asar` by electron-builder.studio.yml's own `files` list) — unlike
 * the face models (face/modelSource.ts), there is no separate fetch-and-cache
 * step; the file is already on disk the moment `bun install`/packaging put
 * it there. The sha256 check at load time (wasmDecode.ts, mirroring
 * `verifyModelBytes`'s own use for the face models) is defense in depth
 * against a supply-chain swap of the installed bytes, not a download
 * integrity check: it proves the exact bytes this task measured for parity
 * (studio/engine/face/parity.test.ts) are the exact bytes running in
 * production.
 *
 * Hashes recorded by hand against the installed package versions below
 * (`sha256sum` over each package's own codec .wasm file, 2026-09-28). A
 * package upgrade needs a new pinned entry here, deliberately — the same
 * "update this by hand, not silently" shape modelSource.ts uses.
 */
export interface CodecWasmSource {
  /** The path segments from the package root to the .wasm file. */
  path: readonly string[];
  sha256: string;
  approxBytes: number;
}

export const CODEC_WASM_SOURCES = {
  jpeg: {
    // @jsquash/jpeg@1.6.0 (Apache-2.0; the codec itself is libjpeg-turbo/mozjpeg, BSD/zlib/IJG — see codec/LICENSE.codec.md).
    path: ["@jsquash", "jpeg", "codec", "dec", "mozjpeg_dec.wasm"],
    sha256: "a7c4b12169817e779ff4af137981393ae924944e167ad1bd95747c9199162d3e",
    approxBytes: 166_470,
  },
  png: {
    // @jsquash/png@3.1.1 (Apache-2.0; the codec itself is Google's squoosh PNG codec, BSD-3-Clause — see codec/LICENSE.codec.md).
    path: ["@jsquash", "png", "codec", "pkg", "squoosh_png_bg.wasm"],
    sha256: "263d6e658808a74b72a1a99c5cc1d619237e70c150db6e41d5d84d3d117ab9be",
    approxBytes: 181_088,
  },
} as const satisfies Record<string, CodecWasmSource>;

export type CodecWasmKey = keyof typeof CODEC_WASM_SOURCES;
