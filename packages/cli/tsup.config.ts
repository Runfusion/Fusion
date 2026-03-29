import { defineConfig } from "tsup";
import { cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dashboardClientSrc = join(__dirname, "..", "dashboard", "dist", "client");
const dashboardClientDest = join(__dirname, "dist", "client");

export default defineConfig({
  entry: ["src/bin.ts", "src/extension.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  noExternal: [/^@kb\//],
  splitting: false,
  clean: true,
  onSuccess: async () => {
    if (existsSync(dashboardClientSrc)) {
      cpSync(dashboardClientSrc, dashboardClientDest, { recursive: true });
      console.log("Copied dashboard client assets to dist/client/");
    } else {
      console.warn("WARNING: Dashboard client assets not found at", dashboardClientSrc);
    }
  },
});
