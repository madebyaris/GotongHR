import path from "node:path";
import { constants } from "node:zlib";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { compression } from "vite-plugin-compression2";

export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, import.meta.dirname, "VITE_");
  const apiProxy = {
    "/api": {
      target: process.env.VITE_API_PROXY ?? fileEnv.VITE_API_PROXY ?? "http://127.0.0.1:3000",
    },
  };
  return {
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
  };
});
