import { defineConfig, type Plugin } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const TOKEN_PATH = resolve(root, "data/token");
const SERVER_PORT = process.env.PI_SERVER_PORT ?? "8787";

/** Inject the token and boot config into index.html (dev). In production Fastify does the injection. */
function bootInject(): Plugin {
  return {
    name: "pi-boot-inject",
    transformIndexHtml(html: string) {
      let token = "";
      try {
        token = readFileSync(TOKEN_PATH, "utf8").trim();
      } catch {
        /* dev.mjs has not run yet; an empty token means the server rejects requests, which is correct */
      }
      const boot = JSON.stringify({ token, apiBase: "" });
      return html.replace("</head>", `  <script>window.__PI_BOOT__=${boot}</script>\n</head>`);
    },
  };
}

export default defineConfig({
  plugins: [svelte(), bootInject()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: `http://127.0.0.1:${SERVER_PORT}`, ws: true },
    },
  },
  build: { target: "es2022", outDir: "dist", emptyOutDir: true, sourcemap: false },
});
