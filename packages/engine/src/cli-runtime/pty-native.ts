/**
 * Shared node-pty native-asset loader.
 *
 * Centralizes the lazy-load, prebuild path resolution, dlopen fallback, and
 * native-permission repair machinery so PTY owners (the dashboard terminal
 * service and the CLI agent executor) share one implementation. The runtime
 * package is `@homebridge/node-pty-prebuilt-multiarch`, aliased as `node-pty`
 * in package.json.
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";

// Detect if we're running as a Bun-compiled binary
// @ts-expect-error - Bun global is only available in Bun runtime
const isBunBinary = typeof Bun !== "undefined" && !!Bun.embeddedFiles;

// Lazy-loaded node-pty module (only loaded when a PTY is actually used)
let ptyModule: typeof import("node-pty") | null = null;
let ptyLoadError: Error | null = null;

const require = createRequire(import.meta.url);

/**
 * Resolve the `<platform>-<arch>` directory name used for staged native
 * prebuilds next to a Bun-compiled binary.
 */
export function getNativePrebuildName(): string {
  const platform =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "linux"
        ? "linux"
        : process.platform === "win32"
          ? "win32"
          : "unknown";
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : "unknown";
  return `${platform}-${arch}`;
}

/**
 * Locate the installed node-pty native module directory in dev/workspace mode.
 *
 * NOTE: The fs.existsSync() calls in this function run during loader
 * initialization (when a PTY is first used). This is acceptable as it only
 * executes once per process lifetime, not per-request.
 */
export function findInstalledNodePtyNativeDir(): string | null {
  try {
    const packageJsonPath = require.resolve("node-pty/package.json");
    const pkgRoot = dirname(packageJsonPath);

    // @homebridge/node-pty-prebuilt-multiarch (aliased as node-pty) places the binary
    // in build/Release/pty.node after prebuild-install runs at install time.
    // Prefer this location as it is the fork's standard output path.
    const releaseDir = join(pkgRoot, "build", "Release");
    if (fs.existsSync(join(releaseDir, "pty.node"))) {
      return releaseDir;
    }

    // Fallback: check the old prebuilds/<plat-arch>/ layout (upstream node-pty style).
    const prebuildDir = join(pkgRoot, "prebuilds", getNativePrebuildName());
    if (fs.existsSync(join(prebuildDir, "pty.node"))) {
      return prebuildDir;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Locate the native assets directory staged next to a Bun-compiled binary
 * (packaged-binary mode). Looks for `runtime/<platform-arch>/pty.node`.
 */
export function findStagedNativeDir(): string | null {
  const prebuildName = getNativePrebuildName();

  // Check FUSION_RUNTIME_DIR env var first
  if (process.env.FUSION_RUNTIME_DIR) {
    const envPath = join(process.env.FUSION_RUNTIME_DIR, prebuildName);
    if (fs.existsSync(join(envPath, "pty.node"))) {
      return envPath;
    }
  }

  // Look next to the executable
  const execDir = dirname(process.execPath);
  const nextToBinary = join(execDir, "runtime", prebuildName);
  if (fs.existsSync(join(nextToBinary, "pty.node"))) {
    return nextToBinary;
  }

  return null;
}

/**
 * Best-effort repair of native-asset permissions so node-pty's `pty.node` and
 * `spawn-helper` are executable. No-op on Windows.
 */
export function ensureNodePtyNativePermissions(): void {
  if (process.platform === "win32") {
    return;
  }

  const candidateDirs = new Set<string>();
  const envNativeDir =
    process.env.NODE_PTY_SPAWN_HELPER_DIR || process.env.FUSION_NATIVE_ASSETS_PATH;
  if (envNativeDir) {
    candidateDirs.add(envNativeDir);
  }

  const stagedNativeDir = findStagedNativeDir();
  if (stagedNativeDir) {
    candidateDirs.add(stagedNativeDir);
  }

  const installedNativeDir = findInstalledNodePtyNativeDir();
  if (installedNativeDir) {
    candidateDirs.add(installedNativeDir);
  }

  for (const nativeDir of candidateDirs) {
    const helperPath = join(nativeDir, "spawn-helper");
    const nativeModulePath = join(nativeDir, "pty.node");

    try {
      fs.chmodSync(helperPath, 0o755);
    } catch {
      // Best-effort permission repair; helper may not exist in some layouts.
    }

    try {
      fs.chmodSync(nativeModulePath, 0o755);
    } catch (err) {
      // Keep diagnostics for the native module path since missing/invalid perms
      // here are more likely to prevent PTY startup.
      console.warn("[terminal] Failed to repair node-pty native permissions:", {
        nativeDir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Lazily load the node-pty module, repairing native permissions and (for
 * Bun-compiled binaries) pre-loading the native module via dlopen. The loaded
 * module is cached; a load failure is cached and re-thrown on subsequent calls.
 */
export async function loadPtyModule(): Promise<typeof import("node-pty")> {
  ensureNodePtyNativePermissions();

  if (ptyModule) {
    return ptyModule;
  }

  if (ptyLoadError) {
    throw ptyLoadError;
  }

  // For Bun-compiled binary, set up native paths before loading
  if (isBunBinary) {
    const nativeDir = findStagedNativeDir();
    if (nativeDir) {
      // Set spawn-helper directory
      if (process.platform !== "win32") {
        process.env.NODE_PTY_SPAWN_HELPER_DIR = nativeDir;
      }
      // Store reference for debugging
      process.env.FUSION_NATIVE_ASSETS_PATH = nativeDir;

      // Try to pre-load the native module using process.dlopen
      // This can help when the normal require() path fails
      const nativePath = join(nativeDir, "pty.node");
      if (fs.existsSync(nativePath)) {
        try {
          const nativeModule: { exports?: unknown } = { exports: {} };
          // process.dlopen is a Node internal API
          process.dlopen(nativeModule, nativePath);
          console.log("[terminal] Pre-loaded native module via dlopen");
        } catch (dlopenErr) {
          // dlopen failed - log but continue, normal import might still work
          console.log("[terminal] dlopen pre-load failed (continuing):", dlopenErr);
        }
      }
    }
  }

  try {
    // Standard import path - the native-patch setup should have created
    // the necessary symlink structure for node-pty to find the module
    const mod = await import("node-pty");
    ptyModule = mod;
    return ptyModule as typeof import("node-pty");
  } catch (err) {
    ptyLoadError = err instanceof Error ? err : new Error(String(err));
    throw ptyLoadError;
  }
}

/**
 * Reset the cached module / error state. Intended for tests that exercise the
 * loader across multiple scenarios.
 */
export function resetPtyModuleCacheForTests(): void {
  ptyModule = null;
  ptyLoadError = null;
}
