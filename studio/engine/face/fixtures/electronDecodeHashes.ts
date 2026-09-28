/**
 * Reference hashes of Electron's `nativeImage` decode for the 5 committed
 * face fixtures (fixtures/images/*.jpg) — the security review's own decode
 * decision (docs/studio/2026-09-24-stage-2-plan.md, T7b wiring, "The decode
 * decision, with evidence"): decoding untrusted, network-sourced image bytes
 * with native Chromium decoders in the privileged main process is not
 * acceptable, so the engine now decodes with a WASM JPEG/PNG decoder
 * instead (studio/engine/decode/). parity.test.ts asserts the WASM decode's
 * output hashes to exactly these values — proof the two decoders are
 * byte-identical on real photos, without ever running Electron at test time.
 *
 * Produced by `bun studio/scripts/generateWasmDecodeParityHashes.ts`, which
 * decodes each fixture with the real `nativeImage` (via
 * `face/testing/decodeWithElectron.ts`, the same harness parity.test.ts used
 * before this task), converts its BGRA bitmap to RGBA (the tag
 * `wasmDecode.ts`'s own output carries) and sha256-hashes the result. Run it
 * again and commit the diff whenever a fixture image under fixtures/images/
 * changes. Last generated 2026-09-28 against this checkout's Electron
 * (`node_modules/electron`, the version pinned in package.json).
 */
export interface ElectronDecodeHash {
  width: number;
  height: number;
  /** sha256 of the decoded RGBA bytes (BGRA converted to RGBA — see the header above). */
  sha256: string;
}

export const ELECTRON_DECODE_HASHES: Record<string, ElectronDecodeHash> = {
  "master.jpg": { width: 864, height: 1152, sha256: "f47ecb74f1b8d48fb5f68a4f99ce7ccb771c4cb3bcb5785dbdfd5044dd240ad8" },
  "impostor-candidate-1.jpg": { width: 864, height: 1152, sha256: "b9d407ff95dc97b1d0a1d7d483f7efe05b1e7ab0cf6995638f74629b24b1a3f5" },
  "render-worst-fitness-3.jpg": { width: 720, height: 1280, sha256: "c1e54366832de414f0c3c97e7a79bcf252f6f60757b43ee324b36677ca32f8eb" },
  "render-median-travel-2.jpg": { width: 720, height: 1280, sha256: "bf3fbd61e192a1d7795a60cd4c7b26d3c20cfc3699d55886142d312c8f214433" },
  "render-best-home-1.jpg": { width: 720, height: 1280, sha256: "3915c97270bf3404302a67bab986dd65f55bf616978a51695d0a1ab0cf61a712" },
};
