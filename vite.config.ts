import { resolve } from "node:path";

import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(import.meta.dirname, "web"),
  plugins: [vue()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "web/src"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5174,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3220",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: resolve(import.meta.dirname, "dist/web"),
    emptyOutDir: true,
  },
});
