import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "package.json"), "utf8")
) as { version: string };

export default defineConfig({
  main: { build: { lib: { entry: "electron/main.ts" } } },
  preload: { build: { lib: { entry: "electron/preload.ts" } } },
  renderer: {
    root: ".",
    define: { __APP_VERSION__: JSON.stringify(version) },
    build: { rollupOptions: { input: resolve(import.meta.dirname, "index.html") } },
    plugins: [react()],
  },
});
