import path from "node:path";
import { constants } from "node:zlib";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { compression } from "vite-plugin-compression2";

const apiProxy = {
  "/api": {
    target: process.env.VITE_API_PROXY ?? "http://127.0.0.1:3000",
  },
};

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
  server: { proxy: apiProxy },
  preview: { proxy: apiProxy },
});
