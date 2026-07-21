import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { viteSingleFile } from "vite-plugin-singlefile";

/**
 * Vite config for the Noodle dashboard.
 *
 * Output: a SINGLE self-contained ../public/index.html with all JS + CSS
 * inlined (vite-plugin-singlefile). This is deliberate — the Node server
 * reads public/index.html as a raw string and serves it at GET /, with no
 * static-file plugin and no SPA catch-all route to maintain. Hash routing
 * (createWebHashHistory) means deep links survive a refresh against that one
 * route.
 *
 * In dev, /api is proxied to the Node server (default http://localhost:3000)
 * so cookie auth + the JSON API work against a real `noodle serve` instance.
 */
export default defineConfig({
  plugins: [vue(), viteSingleFile()],
  build: {
    outDir: "../public",
    emptyOutDir: true,
    // Single-file output — assets inlined, so chunking is irrelevant.
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        // Matches the server's default port (ServerConfigSchema, 3000). Override
        // with NOODLE_DEV_PROXY if you serve on a different port.
        target: process.env.NOODLE_DEV_PROXY ?? "http://localhost:3000",
        changeOrigin: true,
        // SSE-safe proxying. Without this, the underlying http-proxy applies a
        // default proxyTimeout and Node ends idle pooled sockets on long-lived
        // responses — which kills the run/chat/log SSE streams with
        // "socket hang up" at socketOnEnd. proxyTimeout:0 disables the proxy's
        // own inbound timeout, and the configure hook clears the timeout on
        // each proxied request so the upstream socket isn't reaped while the
        // stream is open. Production doesn't proxy (the server serves these
        // endpoints directly), so this only affects `npm run dev:client`.
        proxyTimeout: 0,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            // 0 = no idle timeout. Keeps the upstream socket alive for the
            // lifetime of the SSE response.
            proxyReq.setTimeout(0);
          });
        },
      },
    },
  },
});
