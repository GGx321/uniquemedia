/**
 * Where the text assets sit next to the built engine entry: `out-studio/engine/fonts/` and
 * `out-studio/engine/wasm/index_bg.wasm`. scripts/prepareTextAssets.ts copies them there at build time
 * and engine/main.ts resolves them from its own `import.meta.url`, so they ship inside app.asar (under
 * the integrity fuse) exactly like the face models. One definition, so the two cannot drift.
 */
export const TEXT_ASSET_DIRS = { fonts: "fonts", wasm: "wasm" } as const;
