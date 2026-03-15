import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig(() => ({
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src")
    }
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: [resolve(__dirname, "src/tests/setup.ts")],
    css: true,
  },
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_", "ENABLE_", "TEST_", "COMPARATOR_"],
  server: {
    port: 1420,
    strictPort: true
  },
  preview: {
    port: 1420,
    strictPort: true
  },
  build: {
    target: process.env.TAURI_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("@tanstack")) {
              return "react-query";
            }
            if (id.includes("react-router")) {
              return "router";
            }
            if (id.includes("lucide-react")) {
              return "icons";
            }
            return "vendor";
          }
        }
      }
    }
  }
}));
