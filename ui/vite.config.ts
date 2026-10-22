import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));
// `npm run dev:ui` proxies the API to a board server started by pi in the same folder.
const backend = `http://127.0.0.1:${process.env.PI_SWARM_PORT ?? "3010"}`;

export default defineConfig({
  root,
  // Absolute asset URLs: the server answers deep links like /s/3/agents with index.html.
  base: "/",
  plugins: [react()],
  build: {
    outDir: "../ui_dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": backend,
      "/events": backend,
    },
  },
  test: {
    maxWorkers: 4,
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
