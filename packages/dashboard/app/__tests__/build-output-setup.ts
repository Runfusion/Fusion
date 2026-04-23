import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const dashboardRoot = resolve(__dirname, "../..");

export const dashboardClientDistDir = resolve(dashboardRoot, "dist/client");
export const dashboardClientAssetsDir = resolve(dashboardClientDistDir, "assets");

/**
 * Build output verification must be deterministic: the suite owns artifact setup
 * and never skip-gates coverage based on whatever dist/ state already exists.
 */
export function ensureDashboardClientBuild() {
  execSync("pnpm build:client", {
    cwd: dashboardRoot,
    stdio: "pipe",
    timeout: 180_000,
  });

  if (!existsSync(dashboardClientDistDir) || !existsSync(dashboardClientAssetsDir)) {
    throw new Error("Dashboard client build did not produce dist/client assets");
  }
}
