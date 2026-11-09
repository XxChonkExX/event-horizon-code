import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import solid from "vite-plugin-solid";
import path from "node:path";

export default defineConfig({
  main: {
    entry: "src/main/index.ts",
    plugins: [externalizeDepsPlugin()],
    build: { outDir: "out/main" }
  },
  preload: {
    entry: "src/preload/index.ts",
    plugins: [externalizeDepsPlugin()],
    build: { outDir: "out/preload" }
  },
  renderer: {
    root: "src/renderer",
    plugins: [solid()],
    build: { outDir: "out/renderer" },
    resolve: { alias: { "@": path.resolve(__dirname, "src") } }
  }
});
