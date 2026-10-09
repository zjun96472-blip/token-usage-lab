import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { usageBridge } from "./scripts/vite-usage-bridge";
export default defineConfig({
  root: "src",
  plugins: [react(), usageBridge()],
  base: "./",
  build: { outDir: "../dist", emptyOutDir: true },
  server: { host: "127.0.0.1", port: 18462, strictPort: true },
  preview: { host: "127.0.0.1", port: 18462, strictPort: true },
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  clearScreen: false,
});
