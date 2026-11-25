import path from "node:path";
import { constants } from "node:zlib";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { compression } from "vite-plugin-compression2";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    compression({
      algorithms: ["gzip", "brotliCompress"],
      threshold: 0,
      compressionOptions: {
        brotliCompress: {
          params: {
            [constants.BROTLI_PARAM_QUALITY]: 11,
          },
        },
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  build: {
    manifest: true,
    sourcemap: false,
  },
});
