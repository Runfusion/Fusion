import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const cliRoot = join(__dirname, "..", "..");
export const workspaceRoot = join(cliRoot, "..", "..");
export const bundlePath = join(cliRoot, "dist", "bin.js");
export const clientIndexPath = join(cliRoot, "dist", "client", "index.html");
const cursorPluginManifestPath = join(cliRoot, "dist", "plugins", "fusion-plugin-cursor-runtime", "manifest.json");
const roadmapPluginBundledPath = join(cliRoot, "dist", "plugins", "fusion-plugin-roadmap", "bundled.js");
export const openclawMcpSchemaServerPath = join(
  cliRoot,
  "dist",
  "plugins",
  "fusion-plugin-openclaw-runtime",
  "mcp-schema-server.cjs",
);
export const droidPluginMcpServerPath = join(
  cliRoot,
  "dist",
  "plugins",
  "fusion-plugin-droid-runtime",
  "mcp-schema-server.cjs",
);

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

export function hasBuiltDashboardAssets(): boolean {
  if (
    !existsSync(bundlePath) ||
    !existsSync(clientIndexPath) ||
    !existsSync(cursorPluginManifestPath) ||
    !existsSync(roadmapPluginBundledPath) ||
    !existsSync(openclawMcpSchemaServerPath) ||
    !existsSync(droidPluginMcpServerPath)
  ) {
    return false;
  }

  return !readFileSync(clientIndexPath, "utf-8").includes(dashboardClientStubMarker);
}

/**
 * This suite verifies real copied dashboard client assets in CLI dist output.
 * It must build those assets explicitly instead of skip-gating on ambient dist/.
 *
 * FNXC:TestInfrastructure 2026-07-13-12:20:
 * bundle-output.test.ts and extension-integration.test.ts both call this helper,
 * and Vitest runs test files in parallel (pool: "forks", fileParallelism: true).
 * Without a cross-worker lock, two workers can simultaneously trigger vite/tsup
 * builds that clean and write dist/client concurrently, causing ENOENT on
 * content-hashed chunk files. The lock uses atomic mkdirSync — the winner builds,
 * losers poll until the lock disappears then re-check hasBuiltDashboardAssets().
 */
const buildLockDir = join(tmpdir(), "fusion-cli-build-assets.lock");
const BUILD_LOCK_TIMEOUT_MS = 300_000;

export function buildCliWithRealDashboardAssets() {
  if (hasBuiltDashboardAssets()) {
    return;
  }

  // Try to acquire the lock atomically. mkdirSync throws EEXIST if the dir exists.
  let acquiredLock = false;
  try {
    mkdirSync(buildLockDir);
    acquiredLock = true;
  } catch {
    // Another worker holds the lock — wait for it.
  }

  if (!acquiredLock) {
    const deadline = Date.now() + BUILD_LOCK_TIMEOUT_MS;
    while (existsSync(buildLockDir) && Date.now() < deadline) {
      // Synchronous sleep without spawning a child process.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
    // The other worker should have finished building. Re-check assets.
    if (hasBuiltDashboardAssets()) {
      return;
    }
    // Lock is still held after timeout — do NOT build without owning the lock
    // (that reintroduces the concurrent-build race). Throw so the test fails loudly.
    if (existsSync(buildLockDir)) {
      throw new Error(
        `buildCliWithRealDashboardAssets: timed out after ${BUILD_LOCK_TIMEOUT_MS}ms waiting for another worker's build lock at ${buildLockDir}. ` +
        `If the other worker crashed, remove the lock dir manually and rerun.`,
      );
    }
    // Lock disappeared but assets weren't built — try to acquire for our own build.
    try { mkdirSync(buildLockDir); acquiredLock = true; } catch {
      throw new Error(`buildCliWithRealDashboardAssets: could not acquire build lock at ${buildLockDir} after previous holder exited.`);
    }
  }

  try {
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
  } finally {
    if (acquiredLock) {
      rmSync(buildLockDir, { recursive: true, force: true });
    }
  }
}

export function readClientIndexHtml() {
  return readFileSync(clientIndexPath, "utf-8");
}
