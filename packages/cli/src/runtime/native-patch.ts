/**
 * Native Module Runtime Resolution Patch
 * 
 * This module creates the directory structure that Bun's compiled binary
 * expects for resolving relative paths to native modules.
 * 
 * When Bun compiles a binary, it creates a virtual filesystem at /$bunfs/root/
 * where the bundled code runs from. Node-pty tries to load its native module
 * using paths relative to this virtual location.
 * 
 * We create a real directory structure at /tmp/kb-bunfs-root/kb/ that mirrors
 * the virtual structure, and set up symlinks so the native module can be found.
 */

import { join, dirname, basename } from "node:path";
import { existsSync, copyFileSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// Detect Bun-compiled binary
// @ts-expect-error - Bun global
const isBunBinary = typeof Bun !== "undefined" && !!Bun.embeddedFiles;

let initialized = false;

// The virtual root that Bun uses
const BUNFS_ROOT = "/$bunfs/root";

function findStagedNativeDir(): string | null {
  const platform = process.platform === "darwin" ? "darwin" : 
                   process.platform === "linux" ? "linux" : 
                   process.platform === "win32" ? "win32" : "unknown";
  const arch = process.arch === "arm64" ? "arm64" : 
               process.arch === "x64" ? "x64" : "unknown";
  const prebuildName = `${platform}-${arch}`;

  const execDir = dirname(process.execPath);
  const nextToBinary = join(execDir, "runtime", prebuildName);
  if (existsSync(join(nextToBinary, "pty.node"))) {
    return nextToBinary;
  }

  if (process.env.KB_RUNTIME_DIR) {
    const envPath = join(process.env.KB_RUNTIME_DIR, prebuildName);
    if (existsSync(join(envPath, "pty.node"))) {
      return envPath;
    }
  }

  return null;
}

/**
 * Create a symlink structure that helps node-pty find its native module.
 * 
 * The idea: Create a temp directory structure that looks like:
 *   /tmp/kb-bunfs-root/kb/prebuilds/darwin-arm64/pty.node -> <staged>/pty.node
 * 
 * Then we try to influence the module loader to look here.
 */
function setupNativeResolution(): void {
  const nativeDir = findStagedNativeDir();
  if (!nativeDir) {
    console.warn("[kb-native-patch] No native assets found, terminal will be unavailable");
    return;
  }

  // Set spawn-helper location
  if (process.platform !== "win32") {
    process.env.NODE_PTY_SPAWN_HELPER_DIR = nativeDir;
  }

  // Store reference
  process.env.KB_NATIVE_ASSETS_PATH = nativeDir;

  // Create the fake bunfs structure
  const tmpRoot = join(tmpdir(), `kb-bunfs-${process.pid}`);
  const kbDir = join(tmpRoot, "kb");
  const prebuildsDir = join(kbDir, "prebuilds");
  const platformDir = join(prebuildsDir, basename(nativeDir));

  try {
    mkdirSync(platformDir, { recursive: true });
    
    // Copy native files to this location
    copyFileSync(join(nativeDir, "pty.node"), join(platformDir, "pty.node"));
    if (existsSync(join(nativeDir, "spawn-helper"))) {
      copyFileSync(join(nativeDir, "spawn-helper"), join(platformDir, "spawn-helper"));
    }

    // Store the path for potential use
    process.env.KB_FAKE_BUNFS_ROOT = tmpRoot;
    
    // We can't actually create /$bunfs/root as it's a virtual path
    // But we can try to influence NODE_PATH
    const nodeModulesAtRoot = join(tmpRoot, "node_modules");
    mkdirSync(nodeModulesAtRoot, { recursive: true });
    
    // Prepend to NODE_PATH
    const current = process.env.NODE_PATH || "";
    const sep = process.platform === "win32" ? ";" : ":";
    process.env.NODE_PATH = tmpRoot + sep + current;
    
    console.log("[kb-native-patch] Set up native resolution at:", tmpRoot);
  } catch (err) {
    console.error("[kb-native-patch] Failed to setup resolution:", err);
  }
}

export function initNativePatch(): void {
  if (initialized || !isBunBinary) {
    return;
  }

  setupNativeResolution();
  initialized = true;
}

export function isTerminalAvailable(): boolean {
  if (!isBunBinary) return true;
  return findStagedNativeDir() !== null;
}

export function getNativeDir(): string | null {
  return findStagedNativeDir();
}

initNativePatch();
