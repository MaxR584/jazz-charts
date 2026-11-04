import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: "http://localhost:3001", changeOrigin: true },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      "/api": { target: "http://localhost:3001", changeOrigin: true },
    },
  },
  build: {
    chunkSizeWarningLimit: 2000, // OSMD (incl. VexFlow) is ~1.3 MB minified
  },
});
