import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const cliRoot = join(__dirname, "..", "..");
export const workspaceRoot = join(cliRoot, "..", "..");
export const bundlePath = join(cliRoot, "dist", "bin.js");
export const clientIndexPath = join(cliRoot, "dist", "client", "index.html");
const cursorPluginManifestPath = join(cliRoot, "dist", "plugins", "fusion-plugin-cursor-runtime", "manifest.json");
const roadmapPluginBundledPath = join(cliRoot, "dist", "plugins", "fusion-plugin-roadmap", "bundled.js");
const reportsPluginBundledPath = join(cliRoot, "dist", "plugins", "fusion-plugin-reports", "bundled.js");
const cliPrintingPressPluginBundledPath = join(
  cliRoot,
  "dist",
  "plugins",
  "fusion-plugin-cli-printing-press",
  "bundled.js",
);
const whatsappChatPluginBundledPath = join(cliRoot, "dist", "plugins", "fusion-plugin-whatsapp-chat", "bundled.js");
const compoundEngineeringSkillPath = join(
  cliRoot,
  "dist",
  "plugins",
  "fusion-plugin-compound-engineering",
  "skills",
  "ce-brainstorm",
  "SKILL.md",
);
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

export const requiredBuildAssetPaths = [
  bundlePath,
  clientIndexPath,
  cursorPluginManifestPath,
  roadmapPluginBundledPath,
  reportsPluginBundledPath,
  cliPrintingPressPluginBundledPath,
  whatsappChatPluginBundledPath,
  compoundEngineeringSkillPath,
  openclawMcpSchemaServerPath,
  droidPluginMcpServerPath,
] as const;

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
  if (!requiredBuildAssetPaths.every(existsSync)) {
    return false;
  }

  return !readFileSync(clientIndexPath, "utf-8").includes(dashboardClientStubMarker);
}

function buildRealDashboardAssets(): void {
  runBuildCommand(`node ${join(workspaceRoot, "scripts", "ensure-test-artifacts.mjs")}`, workspaceRoot);
  runBuildCommand("pnpm --filter @fusion/dashboard build:client", workspaceRoot);
  /*
   * FNXC:BundledPlugins 2026-07-15-09:08:
   * bundle-output tests assert the published CLI packaging surface, including staged bundled plugins and skill assets. Local `pnpm build` may use fast package mode, so bootstrap with `build:package` to force FUSION_CLI_FULL_PACKAGE and avoid reading stale raw-src plugin output from dist/.
   */
  runBuildCommand("pnpm build:package", cliRoot);

  if (hasBuiltDashboardAssets()) {
    return;
  }

  // Fallback for environments where build:client alone does not refresh the
  // dashboard dist/client bundle consumed by the CLI copy step.
  runBuildCommand("pnpm --filter @fusion/dashboard build", workspaceRoot);
  runBuildCommand("pnpm build:package", cliRoot);
}

/**
 * This suite verifies real copied dashboard client assets in CLI dist output.
 * It must build those assets explicitly instead of skip-gating on ambient dist/.
 *
 * FNXC:TestInfrastructure 2026-07-16-09:10:
 * Parallel Vitest workers share this lock while bundle-output and built-extension
 * suites build CLI assets. A lock records its PID and acquisition time: waiters
 * never reclaim a live or fresh owner, but recover a dead/invalid owner only
 * after the stale threshold, preventing a crashed holder from wedging the lane.
 */
const buildLockDir = join(tmpdir(), "fusion-cli-build-assets.lock");
const BUILD_LOCK_TIMEOUT_MS = 300_000;
export const BUILD_LOCK_STALE_MS = 60_000;
const BUILD_LOCK_OWNER_FILE = "owner.json";
const BUILD_LOCK_RECLAIM_SUFFIX = ".reclaim";

interface BuildLockOwner {
  pid: number;
  acquiredAt: number;
}

export interface BuildCliAssetsOptions {
  /** Test-only isolated lock directory; production uses the cross-worker temp lock. */
  lockDir?: string;
  hasAssets?: () => boolean;
  build?: () => void | Promise<void>;
  now?: () => number;
  isProcessAlive?: (pid: number) => boolean;
  statMtimeMs?: (path: string) => number;
  waitTick?: () => void | Promise<void>;
}

function readLockOwner(lockDir: string): BuildLockOwner | null {
  try {
    const parsed = JSON.parse(readFileSync(join(lockDir, BUILD_LOCK_OWNER_FILE), "utf8")) as Partial<BuildLockOwner>;
    return typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid) && parsed.pid > 0
      && typeof parsed.acquiredAt === "number" && Number.isFinite(parsed.acquiredAt)
      ? { pid: parsed.pid, acquiredAt: parsed.acquiredAt }
      : null;
  } catch {
    return null;
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
  }
}

async function defaultWaitTick(): Promise<void> {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
}

/**
 * Build the dashboard and CLI package exactly once across Vitest workers.
 * The optional options bag is a test-only seam for deterministic owner/waiter
 * and stale-lock coverage; default behavior uses the shared real build lock.
 */
export async function buildCliWithRealDashboardAssets(options: BuildCliAssetsOptions = {}): Promise<void> {
  const lockDir = options.lockDir ?? buildLockDir;
  const hasAssets = options.hasAssets ?? hasBuiltDashboardAssets;
  const build = options.build ?? buildRealDashboardAssets;
  const now = options.now ?? Date.now;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const statMtimeMs = options.statMtimeMs ?? ((path: string) => statSync(path).mtimeMs);
  const waitTick = options.waitTick ?? defaultWaitTick;
  const deadline = now() + BUILD_LOCK_TIMEOUT_MS;

  if (hasAssets()) return;

  const reclaimDir = `${lockDir}${BUILD_LOCK_RECLAIM_SUFFIX}`;
  while (true) {
    /*
     * FNXC:TestInfrastructure 2026-07-16-09:25:
     * The reclaim guard serializes stale-owner rechecks with acquisition, so a
     * newly-created owner cannot be mistaken for and deleted as the stale one.
     */
    if (existsSync(reclaimDir)) {
      if (now() >= deadline) {
        throw new Error(
          `buildCliWithRealDashboardAssets: timed out after ${BUILD_LOCK_TIMEOUT_MS}ms waiting for stale-lock reclamation at ${lockDir}.`,
        );
      }
      await waitTick();
      continue;
    }

    let acquiredLock = false;
    try {
      mkdirSync(lockDir);
      acquiredLock = true;
      const ownerPath = join(lockDir, BUILD_LOCK_OWNER_FILE);
      const ownerTempPath = join(lockDir, `.owner-${process.pid}-${now()}.tmp`);
      writeFileSync(ownerTempPath, JSON.stringify({ pid: process.pid, acquiredAt: now() }), "utf8");
      renameSync(ownerTempPath, ownerPath);
      try {
        await build();
        return;
      } finally {
        rmSync(lockDir, { recursive: true, force: true });
      }
    } catch (error) {
      /*
       * FNXC:TestInfrastructure 2026-07-16-09:25:
       * Only EEXIST from mkdir is normal contention. Build and owner-metadata
       * failures must surface immediately rather than become waiter timeouts.
       */
      if (acquiredLock || !(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) {
        if (acquiredLock) rmSync(lockDir, { recursive: true, force: true });
        throw error;
      }
    }

    if (hasAssets()) return;

    const owner = readLockOwner(lockDir);
    let ageMs: number;
    try {
      ageMs = now() - (owner?.acquiredAt ?? statMtimeMs(lockDir));
    } catch {
      // FNXC:TestInfrastructure 2026-07-16-09:25: A winner can remove the directory between existsSync and statSync.
      continue;
    }
    const stale = ageMs > BUILD_LOCK_STALE_MS && (!owner || !isProcessAlive(owner.pid));
    if (stale) {
      try {
        mkdirSync(reclaimDir);
      } catch {
        // FNXC:TestInfrastructure 2026-07-16-09:25: Another waiter is already rechecking the stale candidate.
        continue;
      }
      try {
        /*
         * FNXC:TestInfrastructure 2026-07-16-09:25:
         * Re-read under the reclaim guard because an acquirer can win just
         * before it is created; that fresh owner must never be removed.
         */
        const currentOwner = readLockOwner(lockDir);
        const currentAge = now() - (currentOwner?.acquiredAt ?? statMtimeMs(lockDir));
        if (currentAge > BUILD_LOCK_STALE_MS && (!currentOwner || !isProcessAlive(currentOwner.pid))) {
          rmSync(lockDir, { recursive: true, force: true });
        }
      } catch {
        // FNXC:TestInfrastructure 2026-07-16-09:25: The owner may have finished while we acquired the guard; retry normally.
      } finally {
        rmSync(reclaimDir, { recursive: true, force: true });
      }
      continue;
    }

    if (now() >= deadline) {
      throw new Error(
        `buildCliWithRealDashboardAssets: timed out after ${BUILD_LOCK_TIMEOUT_MS}ms waiting for another worker's build lock at ${lockDir}.`,
      );
    }
    await waitTick();
    if (hasAssets()) return;
  }
}

export function readClientIndexHtml() {
  return readFileSync(clientIndexPath, "utf-8");
}
