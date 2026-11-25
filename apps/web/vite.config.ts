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
      essEntry(),
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
      rollupOptions: {
        input: {
          main: path.resolve(import.meta.dirname, "index.html"),
          ess: path.resolve(import.meta.dirname, "ess/index.html"),
        },
      },
    },
    server: { proxy: apiProxy },
    preview: { proxy: apiProxy },
  };
});

function essEntry() {
  const rewrite = (req: { url?: string }, _res: unknown, next: () => void) => {
    const url = req.url ?? "";
    const pathOnly = url.split("?")[0] ?? "";
    if (pathOnly === "/ess" || pathOnly === "/ess/") {
      const query = url.includes("?") ? url.slice(url.indexOf("?")) : "";
      req.url = `/ess/index.html${query}`;
    }
    next();
  };
  return {
    name: "ess-entry",
    configureServer(server: { middlewares: { use: (fn: typeof rewrite) => void } }) {
      server.middlewares.use(rewrite);
    },
    configurePreviewServer(server: { middlewares: { use: (fn: typeof rewrite) => void } }) {
      server.middlewares.use(rewrite);
    },
  };
}
