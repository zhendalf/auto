import { defineConfig } from "vite";
import type { ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { autoTokenPlugin, devSupervisorPort } from "./vite-plugin-auto-token.ts";

const supervisor = `http://127.0.0.1:${devSupervisorPort()}`;

// Forward to the supervisor as if the request came from the supervisor's own
// origin, so its Host/Origin allowlist accepts it without ever listing the
// Vite port (5173) in production. The page itself carries the token (see
// vite-plugin-auto-token.ts) and sends it as `Authorization: Bearer`, so the
// proxy adds nothing to the request's credentials.
const toSupervisor: ProxyOptions = {
  target: supervisor,
  changeOrigin: true, // Host: 127.0.0.1:<AUTO_PORT>
  ws: false,
  configure(proxy) {
    proxy.on("proxyReq", (proxyReq) => {
      proxyReq.setHeader("origin", supervisor);
    });
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss(), autoTokenPlugin()],
  server: {
    port: 5173,
    // The dev page embeds the API token, so no other origin may read it: by
    // default Vite answers any localhost origin with an
    // `Access-Control-Allow-Origin` header for it.
    cors: false,
    proxy: {
      "/api": toSupervisor,
      "/events": toSupervisor,
      "/healthz": toSupervisor,
    },
  },
  build: {
    outDir: "dist",
    // Source maps were most of the published package; the UI is not debugged in prod.
    sourcemap: false,
    assetsDir: "assets",
  },
});
