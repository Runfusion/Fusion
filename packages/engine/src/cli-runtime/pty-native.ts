/**
 * Shared node-pty native-asset loader.
 *
 * Centralizes the lazy-load, prebuild path resolution, dlopen fallback, and
 * native-permission repair machinery so PTY owners (the dashboard terminal
 * service and the CLI agent executor) share one implementation. The runtime
 * package is `@lydell/node-pty`, aliased as `node-pty` in package.json. Its
 * script-free optional platform packages supply the native payload.
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createLogger } from "../logger.js";

const log = createLogger("terminal");

// Lazy-loaded node-pty module (only loaded when a PTY is actually used)
let ptyModule: typeof import("node-pty") | null = null;
let ptyLoadError: Error | null = null;

const require = createRequire(import.meta.url);

/**
 * Resolve the `<platform>-<arch>` directory name used for staged native
 * prebuilds next to a Bun-compiled binary.
 */
export function getNativePrebuildName(platform = process.platform, arch = process.arch): string {
  const supportedPlatform = platform === "darwin" || platform === "linux" || platform === "win32"
    ? platform
    : "unknown";
  const supportedArch = arch === "arm64" || arch === "x64" ? arch : "unknown";
  return `${supportedPlatform}-${supportedArch}`;
}

/** Return the script-free optional dependency that supplies a supported PTY payload. */
export function nodePtyPlatformPackageName(platform = process.platform, arch = process.arch): string | null {
  const prebuildName = getNativePrebuildName(platform, arch);
  return prebuildName.includes("unknown") ? null : `@lydell/node-pty-${prebuildName}`;
}

/**
 * FNXC:Terminal 2026-09-04-03:28: The script-free Windows platform package
 * exposes ConPTY as its loadable entry rather than Unix's pty.node. Every
 * staged-runtime probe must recognize that published layout or standalone
 * Windows binaries fall through to Bun's empty bundled module.
 */
function nodePtyRequiredNativeEntry(platform = process.platform): string | null {
  if (platform === "win32") return "conpty.node";
  return platform === "darwin" || platform === "linux" ? "pty.node" : null;
}

/**
 * FNXC:Terminal 2026-09-04-01:43: Homebrew installs with lifecycle scripts disabled, so PTY
 * loading must name the missing script-free platform package rather than suggesting a compiler.
 */
export function describePtyLoadFailure(
  _err: unknown,
  platform = process.platform,
  arch = process.arch,
): string {
  const prebuildName = getNativePrebuildName(platform, arch);
  const packageName = nodePtyPlatformPackageName(platform, arch);
  if (!packageName) {
    return `Platform not supported: ${prebuildName}. No node-pty platform package is published for this platform.`;
  }
  const nativeEntry = nodePtyRequiredNativeEntry(platform) ?? "pty.node";
  return `Expected ${packageName} to provide prebuilds/${prebuildName}/${nativeEntry}. This usually means optional dependencies were omitted during installation or node_modules was copied between operating systems.`;
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
    const umbrellaEntry = require.resolve("node-pty");
    const umbrellaRoot = dirname(umbrellaEntry);
    const releaseDir = join(umbrellaRoot, "build", "Release");
    if (fs.existsSync(join(releaseDir, "pty.node"))) return releaseDir;

    const packageName = nodePtyPlatformPackageName();
    const nativeEntry = nodePtyRequiredNativeEntry();
    if (!packageName || !nativeEntry) return null;
    const platformRequire = createRequire(umbrellaEntry);
    // FNXC:Terminal 2026-09-04-01:43: The platform package exports only its root entry, so
    // resolving a package.json subpath violates exports. Resolve the root and derive its directory.
    const platformEntry = platformRequire.resolve(packageName);
    const platformRoot = dirname(dirname(platformEntry));
    const prebuildDir = join(platformRoot, "prebuilds", getNativePrebuildName());
    return fs.existsSync(join(prebuildDir, nativeEntry)) ? prebuildDir : null;
  } catch {
    return null;
  }
}

/**
 * Locate the native assets directory staged next to a Bun-compiled binary
 * (packaged-binary mode). Unix runtimes provide `pty.node`; Windows provides
 * `conpty.node` and companion ConPTY assets.
 */
export function findStagedNativeDir(platform = process.platform, arch = process.arch): string | null {
  const prebuildName = getNativePrebuildName(platform, arch);
  const nativeEntry = nodePtyRequiredNativeEntry(platform);
  if (!nativeEntry) return null;

  // Check FUSION_RUNTIME_DIR env var first
  if (process.env.FUSION_RUNTIME_DIR) {
    const envPath = join(process.env.FUSION_RUNTIME_DIR, prebuildName);
    if (fs.existsSync(join(envPath, nativeEntry))) {
      return envPath;
    }
  }

  // Look next to the executable
  const execDir = dirname(process.execPath);
  const nextToBinary = join(execDir, "runtime", prebuildName);
  if (fs.existsSync(join(nextToBinary, nativeEntry))) {
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
      log.warn("Failed to repair node-pty native permissions:", {
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

  // A standalone runtime directory takes precedence because Bun can substitute
  // its compiled `node-pty` import with an empty module.
  const nativeDir = findStagedNativeDir();
  if (nativeDir) {
    if (process.platform !== "win32") {
      process.env.NODE_PTY_SPAWN_HELPER_DIR = nativeDir;
    }
    process.env.FUSION_NATIVE_ASSETS_PATH = nativeDir;

    /*
     * FNXC:Terminal 2026-09-04-04:15:
     * Bun compiles the aliased node-pty import to an empty module, before native-patch
     * can redirect the platform request. Standalone builds therefore stage and require
     * the real umbrella package from disk; its nested platform package preserves normal
     * CommonJS resolution and must expose spawn rather than silently returning `{}`.
     */
    const stagedUmbrellaEntry = join(nativeDir, "node-pty-umbrella", "index.js");
    if (fs.existsSync(stagedUmbrellaEntry)) {
      try {
        // A runtime file URL keeps Bun from statically replacing this import
        // with the empty module it emits for the bundled alias.
        const stagedImport = await import(pathToFileURL(stagedUmbrellaEntry).href) as typeof import("node-pty") & {
          default?: typeof import("node-pty");
        };
        const mod = typeof stagedImport.spawn === "function" ? stagedImport : stagedImport.default;
        if (mod && typeof mod.spawn === "function") {
          ptyModule = mod;
          return ptyModule;
        }
        throw new Error(`Staged node-pty umbrella at ${stagedUmbrellaEntry} did not export spawn`);
      } catch (err) {
        ptyLoadError = err instanceof Error ? err : new Error(String(err));
        log.warn(describePtyLoadFailure(ptyLoadError), ptyLoadError);
        throw ptyLoadError;
      }
    }
  }

  try {
    const mod = await import("node-pty");
    if (typeof mod.spawn !== "function") {
      throw new Error("node-pty did not export spawn");
    }
    ptyModule = mod;
    return ptyModule as typeof import("node-pty");
  } catch (err) {
    ptyLoadError = err instanceof Error ? err : new Error(String(err));
    log.warn(describePtyLoadFailure(ptyLoadError), ptyLoadError);
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
