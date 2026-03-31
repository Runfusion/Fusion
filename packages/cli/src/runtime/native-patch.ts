/**
 * Native Module Runtime Resolution Patch
 *
 * This module sets up the directory structure needed for node-pty to find its native
 * modules when running from a Bun-compiled binary.
 *
 * When Bun compiles a binary, it creates a virtual filesystem at /$bunfs/root/
 * where bundled code runs. Node-pty looks for native modules at:
 *   /$bunfs/root/prebuilds/<platform>-<arch>/pty.node
 *
 * This module creates a real directory structure at /tmp/kb-bunfs-<pid>/ that mirrors
 * the expected structure, then attempts to create a symlink from /$bunfs/root to that
 * temp directory (on macOS/Linux) so node-pty can find the native assets.
 */

import { join, basename, dirname } from "node:path";
import { existsSync, copyFileSync, mkdirSync, symlinkSync, rmSync, lstatSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";

// Detect Bun-compiled binary
// @ts-expect-error - Bun global
const isBunBinary = typeof Bun !== "undefined" && !!Bun.embeddedFiles;

let initialized = false;
let bunfsSymlinkPath: string | null = null;

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
  if (existsSync(join(nextToBinary, "pty.node"))) {
    return nextToBinary;
  }

  // Check KB_RUNTIME_DIR env var
  if (process.env.KB_RUNTIME_DIR) {
    const envPath = join(process.env.KB_RUNTIME_DIR, prebuildName);
    if (existsSync(join(envPath, "pty.node"))) {
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
        if (target.includes("kb-bunfs-") && !existsSync(target)) {
          rmSync(bunfsRoot);
          console.log("[kb-native-patch] Cleaned up stale /$bunfs/root symlink");
        }
      }
    }
  } catch {
    // Ignore errors during cleanup
  }
}

/**
 * Set up the native module resolution structure.
 *
 * Creates:
 *   /tmp/kb-bunfs-<pid>/kb/prebuilds/<platform>-<arch>/
 *     ├── pty.node
 *     └── spawn-helper (Unix only)
 *
 * Then attempts to create a symlink at /$bunfs/root pointing to the temp directory
 * so that node-pty's relative require() can find the native module.
 */
export function setupNativeResolution(): { success: boolean; nativeDir: string | null } {
  const nativeDir = findStagedNativeDir();
  if (!nativeDir) {
    console.warn("[kb-native-patch] No native assets found, terminal will be unavailable");
    return { success: false, nativeDir: null };
  }

  // Set spawn-helper location (Unix platforms)
  if (process.platform !== "win32") {
    process.env.NODE_PTY_SPAWN_HELPER_DIR = nativeDir;
  }

  // Store reference for other code to use
  process.env.KB_NATIVE_ASSETS_PATH = nativeDir;

  // Create the fake bunfs structure
  const tmpRoot = join(tmpdir(), `kb-bunfs-${process.pid}`);
  const kbDir = join(tmpRoot, "kb");
  const prebuildsDir = join(kbDir, "prebuilds");
  const platformDir = join(prebuildsDir, basename(nativeDir));

  try {
    // Clean up any previous stale links first
    cleanupStaleBunfsLinks();

    // Create directory structure
    mkdirSync(platformDir, { recursive: true });

    // Copy native files to this location
    const ptyNodeDest = join(platformDir, "pty.node");
    copyFileSync(join(nativeDir, "pty.node"), ptyNodeDest);

    if (existsSync(join(nativeDir, "spawn-helper"))) {
      copyFileSync(join(nativeDir, "spawn-helper"), join(platformDir, "spawn-helper"));
    }

    // Store the path for potential use
    process.env.KB_FAKE_BUNFS_ROOT = tmpRoot;

    // Try to create symlink from /$bunfs/root to our temp directory
    // This allows node-pty's relative require() to find the native module
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

        // Create new symlink pointing to our temp kb directory
        // We want /$bunfs/root -> /tmp/kb-bunfs-<pid>/kb
        // So that /$bunfs/root/prebuilds/<platform>/pty.node resolves correctly
        symlinkSync(kbDir, bunfsRoot);
        bunfsSymlinkPath = bunfsRoot;
        console.log("[kb-native-patch] Created /$bunfs/root symlink for native module resolution");
      } catch (symlinkErr) {
        // Symlink creation failed (likely permission denied) - not fatal
        // The terminal service will try alternative loading methods
        console.log("[kb-native-patch] Could not create /$bunfs/root symlink (permissions), using fallback");
      }
    }

    console.log("[kb-native-patch] Native assets staged at:", tmpRoot);
    return { success: true, nativeDir };
  } catch (err) {
    console.error("[kb-native-patch] Failed to setup native resolution:", err);
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
}

/**
 * Initialize the native module resolution patch.
 * This should be called lazily (e.g., when dashboard starts), not at import time.
 */
export function initNativePatch(): { success: boolean; nativeDir: string | null } {
  if (initialized || !isBunBinary) {
    return { success: true, nativeDir: process.env.KB_NATIVE_ASSETS_PATH || null };
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
