import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const cliRoot = join(__dirname, "..", "..");
export const workspaceRoot = join(cliRoot, "..", "..");
export const bundlePath = join(cliRoot, "dist", "bin.js");
export const clientIndexPath = join(cliRoot, "dist", "client", "index.html");

export const dashboardClientStubMarker = "Dashboard assets not built";

function runBuildCommand(command: string, cwd: string) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && existsSync(npmExecPath)) {
    execFileSync(process.execPath, [npmExecPath, ...command.split(" ")], {
      cwd,
      stdio: "pipe",
      timeout: 240_000,
    });
    return;
  }

  execSync(command, {
    cwd,
    stdio: "pipe",
    timeout: 240_000,
  });
}

function hasBuiltDashboardAssets(): boolean {
  if (!existsSync(bundlePath) || !existsSync(clientIndexPath)) {
    return false;
  }

  return !readFileSync(clientIndexPath, "utf-8").includes(dashboardClientStubMarker);
}

/**
 * This suite verifies real copied dashboard client assets in CLI dist output.
 * It must build those assets explicitly instead of skip-gating on ambient dist/.
 */
export function buildCliWithRealDashboardAssets() {
  if (hasBuiltDashboardAssets()) {
    return;
  }

  runBuildCommand(`node ${join(workspaceRoot, "scripts", "ensure-test-artifacts.mjs")}`, workspaceRoot);
  runBuildCommand("pnpm --filter @fusion/dashboard build:client", workspaceRoot);
  runBuildCommand("pnpm build", cliRoot);

  if (hasBuiltDashboardAssets()) {
    return;
  }

  // Fallback for environments where build:client alone does not refresh the
  // dashboard dist/client bundle consumed by the CLI copy step.
  runBuildCommand("pnpm --filter @fusion/dashboard build", workspaceRoot);
  runBuildCommand("pnpm build", cliRoot);
}

export function readClientIndexHtml() {
  return readFileSync(clientIndexPath, "utf-8");
}
