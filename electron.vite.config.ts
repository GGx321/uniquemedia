import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  main: { build: { lib: { entry: "electron/main.ts" } } },
  preload: { build: { lib: { entry: "electron/preload.ts" } } },
  renderer: {
    root: ".",
    build: { rollupOptions: { input: resolve(import.meta.dirname, "index.html") } },
    plugins: [react()],
  },
});
