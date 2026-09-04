/**
 * Native Module Runtime Resolution Patch
 *
 * This module sets up the directory structure needed for node-pty to find its native
 * modules when running from a Bun-compiled binary.
 *
 * When Bun compiles a binary, it creates a virtual filesystem at /$bunfs/root/
 * where bundled code runs. @lydell/node-pty looks for native modules at:
 *   /$bunfs/root/prebuilds/<platform>-<arch>/pty.node
 *
 * This module creates a real directory structure at /tmp/fn-bunfs-<pid>/ that mirrors
 * the expected structure, then attempts to create a symlink from /$bunfs/root to that
 * temp directory (on macOS/Linux) so node-pty can find the native assets.
 */

import { join, basename, dirname, normalize, relative } from "node:path";
import { existsSync, cpSync, mkdirSync, symlinkSync, rmSync, lstatSync, readlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { nodePtyPlatformPackageName, nodePtyRequiredNativeAssetName } from "./pty-native-assets.js";

const require = createRequire(import.meta.url);

type NodeModuleLoader = (request: string, parent: { filename?: string } | undefined, isMain: boolean) => unknown;
type NodeModuleWithLoader = { _load?: NodeModuleLoader };
const nodeModule = require("node:module") as NodeModuleWithLoader;

// Detect Bun-compiled binary
// @ts-expect-error - Bun global
const isBunBinary = typeof Bun !== "undefined" && !!Bun.embeddedFiles;

let initialized = false;
let bunfsSymlinkPath: string | null = null;
let originalNativeModuleLoad: NodeModuleLoader | null = null;

function findStagedNativeDir(): string | null {
  const platform = process.platform === "darwin" ? "darwin" :
                   process.platform === "linux" ? "linux" :
                   process.platform === "win32" ? "win32" : "unknown";
  const arch = process.arch === "arm64" ? "arm64" :
               process.arch === "x64" ? "x64" : "unknown";
  const prebuildName = `${platform}-${arch}`;

  // Look next to the executable first
  const execDir = dirname(process.execPath);
  const nextToBinary = join(execDir, "runtime", prebuildName);
  const requiredAsset = nodePtyRequiredNativeAssetName(platform);
  if (requiredAsset && existsSync(join(nextToBinary, requiredAsset))) {
    return nextToBinary;
  }

  // Check FUSION_RUNTIME_DIR env var
  if (process.env.FUSION_RUNTIME_DIR) {
    const envPath = join(process.env.FUSION_RUNTIME_DIR, prebuildName);
    if (requiredAsset && existsSync(join(envPath, requiredAsset))) {
      return envPath;
    }
  }

  return null;
}

/**
 * Clean up any stale /$bunfs/root symlinks from previous runs.
 * This handles cases where a previous process crashed and left a dangling symlink.
 */
function cleanupStaleBunfsLinks(): void {
  if (process.platform === "win32") return; // Windows doesn't use symlinks for this

  const bunfsRoot = "/$bunfs/root";
  try {
    if (existsSync(bunfsRoot)) {
      const stats = lstatSync(bunfsRoot);
      if (stats.isSymbolicLink()) {
        const target = readlinkSync(bunfsRoot);
        // If the target is a temp dir that no longer exists, remove the stale link
        if (target.includes("fn-bunfs-") && !existsSync(target)) {
          rmSync(bunfsRoot);
          console.log("[fn-native-patch] Cleaned up stale /$bunfs/root symlink");
        }
      }
    }
  } catch {
    // Ignore errors during cleanup
  }
}

/**
 * Redirect a bundled Windows node-pty relative native probe to a staged file.
 *
 * Bun's virtual `/$bunfs/root` cannot be replaced by a filesystem junction on
 * Windows. The platform package calls CommonJS `require()` with this relative
 * probe, so redirecting that one probe to the staged directory preserves its
 * normal `conpty.node` loading and adjacent DLL lookup.
 */
export function resolveBundledWindowsNativeRequest(
  request: string,
  parentFilename: string | undefined,
  nativeDir: string,
): string | null {
  if (!parentFilename?.replace(/\\/g, "/").includes("/$bunfs/root/")) return null;

  const normalizedRequest = request.replace(/\\/g, "/");
  const expectedPrefix = `./prebuilds/${basename(nativeDir)}/`;
  if (!normalizedRequest.startsWith(expectedPrefix)) return null;

  const requestedAsset = normalizedRequest.slice(expectedPrefix.length);
  const candidate = normalize(join(nativeDir, requestedAsset));
  const candidateRelative = relative(nativeDir, candidate);
  return requestedAsset && candidateRelative !== ".." && !candidateRelative.startsWith(`..${process.platform === "win32" ? "\\\\" : "/"}`)
    ? candidate
    : null;
}

/*
 * FNXC:Terminal 2026-09-04-02:29:
 * Standalone Windows binaries cannot expose staged files by replacing Bun's
 * virtual root. Homebrew-style script-free delivery therefore redirects the
 * bundled node-pty ConPTY probe to the complete staged platform directory,
 * where conpty.node can find its companion DLLs.
 */
export function createWindowsNativeModuleRedirect(nativeDir: string, originalLoad: NodeModuleLoader): NodeModuleLoader {
  return (request, parent, isMain) => {
    const redirected = resolveBundledWindowsNativeRequest(request, parent?.filename, nativeDir);
    return originalLoad.call(nodeModule, redirected ?? request, parent, isMain);
  };
}

/**
 * Resolve the dynamic platform-package request made by the bundled umbrella module.
 *
 * A cross-target package is intentionally absent from the build host's filtered
 * node_modules. The build stages its full package root under the runtime payload,
 * allowing the normal CommonJS loader to execute its JS from disk and preserve its
 * relative native probes.
 */
export function resolveBundledPlatformPackageRequest(
  request: string,
  parentFilename: string | undefined,
  nativeDir: string,
  platform = process.platform,
  arch = process.arch,
): string | null {
  if (!parentFilename?.replace(/\\/g, "/").includes("/$bunfs/root/")) return null;

  const packageName = nodePtyPlatformPackageName(platform, arch);
  if (request !== packageName) return null;
  return join(nativeDir, "node-pty-platform", "lib", "index.js");
}

/*
 * FNXC:Terminal 2026-09-04-03:11:
 * Standalone cross-target binaries must redirect @lydell/node-pty's dynamic platform
 * require to the staged package module. Copying only pty.node left foreign binaries
 * unable to select their platform package before any native loader could run.
 */
export function createNativeModuleRedirect(
  nativeDir: string,
  originalLoad: NodeModuleLoader,
  platform = process.platform,
  arch = process.arch,
): NodeModuleLoader {
  return (request, parent, isMain) => {
    const platformPackage = resolveBundledPlatformPackageRequest(request, parent?.filename, nativeDir, platform, arch);
    const nativeProbe = platformPackage ? null : resolveBundledWindowsNativeRequest(request, parent?.filename, nativeDir);
    return originalLoad.call(nodeModule, platformPackage ?? nativeProbe ?? request, parent, isMain);
  };
}

function installNativeModuleRedirect(nativeDir: string): void {
  if (originalNativeModuleLoad || !nodeModule._load) return;

  const originalLoad = nodeModule._load;
  nodeModule._load = createNativeModuleRedirect(nativeDir, originalLoad);
  originalNativeModuleLoad = originalLoad;
}

/**
 * Set up the native module resolution structure.
 *
 * Creates:
 *   /tmp/fn-bunfs-<pid>/fn/prebuilds/<platform>-<arch>/
 *     └── every file published in prebuilds/<platform>-<arch>/
 *
 * FNXC:Terminal 2026-09-04-02:17: Homebrew disables lifecycle scripts, so the
 * script-free platform payload must be mirrored into Bun's native probe directory
 * without a local rebuild. Copy its complete prebuild directory: Linux legitimately
 * omits spawn-helper while Windows exposes ConPTY instead of pty.node.
 *
 * Then attempts to create a symlink at /$bunfs/root pointing to the temp directory
 * so that node-pty's relative require() can find the native module.
 */
export function setupNativeResolution(): { success: boolean; nativeDir: string | null } {
  const nativeDir = findStagedNativeDir();
  if (!nativeDir) {
    console.warn("[fn-native-patch] No native assets found, terminal will be unavailable");
    return { success: false, nativeDir: null };
  }

  // Set spawn-helper location (Unix platforms)
  if (process.platform !== "win32") {
    process.env.NODE_PTY_SPAWN_HELPER_DIR = nativeDir;
  }

  // Store reference for other code to use
  process.env.FUSION_NATIVE_ASSETS_PATH = nativeDir;

  // Create the fake bunfs structure
  const tmpRoot = join(tmpdir(), `fn-bunfs-${process.pid}`);
  const fnDir = join(tmpRoot, "fn");
  const prebuildsDir = join(fnDir, "prebuilds");
  const platformDir = join(prebuildsDir, basename(nativeDir));

  try {
    // Clean up any previous stale links first
    cleanupStaleBunfsLinks();

    // Create directory structure
    mkdirSync(platformDir, { recursive: true });

    // Preserve every published companion instead of predicting the platform
    // payload shape; node-pty's relative probes own that package-specific detail.
    cpSync(nativeDir, platformDir, { recursive: true });

    // Store the path for potential use
    process.env.FUSION_FAKE_BUNFS_ROOT = tmpRoot;

    // The bundled umbrella dynamically requires its selected platform package.
    // Redirect that request for every target; Windows also redirects raw ConPTY probes.
    installNativeModuleRedirect(nativeDir);

    // Try to create symlink from /$bunfs/root to our temp directory
    // This allows node-pty's relative require() to find the native module.
    if (process.platform !== "win32") {
      const bunfsRoot = "/$bunfs/root";
      try {
        // Remove any existing symlink first (in case it was left by a crashed process)
        if (existsSync(bunfsRoot)) {
          const stats = lstatSync(bunfsRoot);
          if (stats.isSymbolicLink()) {
            rmSync(bunfsRoot);
          }
        }

        // Create new symlink pointing to our temp fn directory
        // We want /$bunfs/root -> /tmp/fn-bunfs-<pid>/fn
        // So that /$bunfs/root/prebuilds/<platform>/pty.node resolves correctly
        symlinkSync(fnDir, bunfsRoot);
        bunfsSymlinkPath = bunfsRoot;
        console.log("[fn-native-patch] Created /$bunfs/root symlink for native module resolution");
      } catch {
        // Symlink creation failed (likely permission denied) - not fatal
        // The terminal service will try alternative loading methods
        console.log("[fn-native-patch] Could not create /$bunfs/root symlink (permissions), using fallback");
      }
    }

    console.log("[fn-native-patch] Native assets staged at:", tmpRoot);
    return { success: true, nativeDir };
  } catch (err) {
    console.error("[fn-native-patch] Failed to setup native resolution:", err);
    return { success: false, nativeDir: null };
  }
}

/**
 * Clean up the symlink we created (call this on process exit).
 */
export function cleanupNativeResolution(): void {
  if (bunfsSymlinkPath && process.platform !== "win32") {
    try {
      if (existsSync(bunfsSymlinkPath)) {
        const stats = lstatSync(bunfsSymlinkPath);
        if (stats.isSymbolicLink()) {
          rmSync(bunfsSymlinkPath);
        }
      }
    } catch {
      // Ignore cleanup errors
    }
  }
  bunfsSymlinkPath = null;

  if (originalNativeModuleLoad) {
    nodeModule._load = originalNativeModuleLoad;
    originalNativeModuleLoad = null;
  }
}

/**
 * Initialize the native module resolution patch.
 * This should be called lazily (e.g., when dashboard starts), not at import time.
 */
export function initNativePatch(): { success: boolean; nativeDir: string | null } {
  if (initialized || !isBunBinary) {
    return { success: true, nativeDir: process.env.FUSION_NATIVE_ASSETS_PATH || null };
  }

  const result = setupNativeResolution();
  initialized = true;

  // Register cleanup on exit
  process.on("exit", cleanupNativeResolution);
  process.on("SIGINT", () => {
    cleanupNativeResolution();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanupNativeResolution();
    process.exit(0);
  });

  return result;
}

/**
 * Check if terminal functionality is available (native assets found).
 */
export function isTerminalAvailable(): boolean {
  if (!isBunBinary) return true;
  return findStagedNativeDir() !== null;
}

/**
 * Get the path to the staged native assets directory.
 */
export function getNativeDir(): string | null {
  return findStagedNativeDir();
}

// Note: We do NOT auto-initialize at import time anymore.
// Callers should explicitly call initNativePatch() when needed.
