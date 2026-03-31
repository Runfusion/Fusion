#!/usr/bin/env bun
/**
 * Bun compile build script for the `kb` CLI.
 *
 * Produces a single self-contained executable at packages/cli/dist/kb
 * with the dashboard client assets co-located at packages/cli/dist/client/.
 *
 * Usage:
 *   bun run build.ts                           # Build for current platform
 *   bun run build.ts --target bun-linux-x64    # Cross-compile for Linux x64
 *   bun run build.ts --all                     # Build for all supported platforms
 *
 * Prerequisites:
 *   - `pnpm build` must have been run first (dashboard client + tsc)
 *   - Bun >= 1.1 (cross-compilation support)
 */

import { join, dirname, basename } from "node:path";
import { cpSync, mkdirSync, existsSync, rmSync, readdirSync, statSync } from "node:fs";

const cliRoot = dirname(new URL(import.meta.url).pathname);
const workspaceRoot = join(cliRoot, "..", "..");
const outDir = join(cliRoot, "dist");
const dashboardClientSrc = join(workspaceRoot, "packages", "dashboard", "dist", "client");
const dashboardClientDest = join(outDir, "client");
const runtimeDir = join(outDir, "runtime");
const entryPoint = join(cliRoot, "src", "bin.ts");

// ── Native module asset paths ─────────────────────────────────────────
// node-pty prebuilds location in pnpm workspace
const nodePtyRoot = join(workspaceRoot, "node_modules", ".pnpm", "node-pty@1.1.0", "node_modules", "node-pty");

// ── Supported cross-compilation targets ───────────────────────────────
const SUPPORTED_TARGETS = [
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-darwin-x64",
  "bun-darwin-arm64",
  "bun-windows-x64",
] as const;

type BunTarget = (typeof SUPPORTED_TARGETS)[number];

/**
 * Map target platform-arch to node-pty prebuild platform-arch naming.
 * Bun target format: bun-<platform>-<arch>
 * node-pty prebuild format: <platform>-<arch> (e.g., darwin-arm64, linux-x64)
 */
function targetToPrebuildName(target: BunTarget): string {
  return target.replace(/^bun-/, "");
}

/**
 * Map a Bun target identifier to the output binary name.
 * e.g. "bun-linux-x64" → "kb-linux-x64", "bun-windows-x64" → "kb-windows-x64.exe"
 */
function binaryNameForTarget(target: BunTarget): string {
  // "bun-linux-x64" → "linux-x64"
  const suffix = target.replace(/^bun-/, "");
  const isWindows = target.includes("windows");
  return `kb-${suffix}${isWindows ? ".exe" : ""}`;
}

/**
 * Determine the default binary name for the current platform (no cross-compile).
 */
function defaultBinaryName(): string {
  return process.platform === "win32" ? "kb.exe" : "kb";
}

/**
 * Get the prebuild name for the current host platform.
 */
function hostPrebuildName(): string {
  const platform = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : process.platform === "win32" ? "win32" : "unknown";
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : "unknown";
  return `${platform}-${arch}`;
}

// ── Parse CLI arguments ───────────────────────────────────────────────
function parseArgs(): { targets: BunTarget[] | null } {
  const args = process.argv.slice(2);

  if (args.includes("--all")) {
    return { targets: [...SUPPORTED_TARGETS] };
  }

  const targetIdx = args.indexOf("--target");
  if (targetIdx !== -1) {
    const target = args[targetIdx + 1];
    if (!target) {
      console.error("ERROR: --target requires a value. Supported targets:");
      SUPPORTED_TARGETS.forEach((t) => console.error(`  ${t}`));
      process.exit(1);
    }
    if (!SUPPORTED_TARGETS.includes(target as BunTarget)) {
      console.error(`ERROR: Unsupported target '${target}'. Supported targets:`);
      SUPPORTED_TARGETS.forEach((t) => console.error(`  ${t}`));
      process.exit(1);
    }
    return { targets: [target as BunTarget] };
  }

  // Default: no cross-compilation (current platform)
  return { targets: null };
}

// ── Validate prerequisites ────────────────────────────────────────────
if (!existsSync(dashboardClientSrc)) {
  console.error(
    `ERROR: Dashboard client not built. Expected: ${dashboardClientSrc}\n` +
      `Run 'pnpm build' first to build all packages.`,
  );
  process.exit(1);
}

// ── Copy native terminal assets for a specific target ─────────────────
/**
 * Stage node-pty native assets for the given target platform.
 * Assets are placed in dist/runtime/<platform-arch>/ alongside client/.
 * 
 * For each target, we copy:
 *   - prebuilds/<platform>-<arch>/pty.node (the native binary)
 *   - prebuilds/<platform>-<arch>/spawn-helper (Unix helper, if exists)
 * 
 * This ensures the standalone binary can find these assets at runtime
 * without relying on the original node_modules structure.
 */
function copyNativeAssets(target?: BunTarget) {
  const prebuildName = target ? targetToPrebuildName(target) : hostPrebuildName();
  const srcPrebuildDir = join(nodePtyRoot, "prebuilds", prebuildName);
  
  if (!existsSync(srcPrebuildDir)) {
    console.warn(`  ⚠ No prebuilds found for ${prebuildName} at ${srcPrebuildDir}`);
    return false;
  }

  const destDir = join(runtimeDir, prebuildName);
  
  try {
    // Clean and recreate
    if (existsSync(destDir)) {
      rmSync(destDir, { recursive: true, force: true });
    }
    mkdirSync(destDir, { recursive: true });

    // Copy pty.node (required)
    const ptyNodeSrc = join(srcPrebuildDir, "pty.node");
    const ptyNodeDest = join(destDir, "pty.node");
    if (existsSync(ptyNodeSrc)) {
      cpSync(ptyNodeSrc, ptyNodeDest);
      console.log(`  → ${destDir}/pty.node`);
    } else {
      console.warn(`  ⚠ pty.node not found for ${prebuildName}`);
      return false;
    }

    // Copy spawn-helper if it exists (Unix platforms)
    const spawnHelperSrc = join(srcPrebuildDir, "spawn-helper");
    if (existsSync(spawnHelperSrc)) {
      const spawnHelperDest = join(destDir, "spawn-helper");
      cpSync(spawnHelperSrc, spawnHelperDest);
      console.log(`  → ${destDir}/spawn-helper`);
    }

    return true;
  } catch (err) {
    console.error(`  ✗ Failed to copy native assets for ${prebuildName}:`, err);
    return false;
  }
}

// ── Copy dashboard client assets alongside output ─────────────────────
// Express.static requires a real filesystem directory, so we co-locate
// the pre-built SPA next to the binary rather than embedding blobs.
function copyClientAssets() {
  try {
    if (existsSync(dashboardClientDest)) {
      rmSync(dashboardClientDest, { recursive: true, force: true });
    }
  } catch {
    // Ignore cleanup errors - directory might not exist or be accessible
  }
  console.log("Copying dashboard client assets...");
  mkdirSync(dashboardClientDest, { recursive: true });
  cpSync(dashboardClientSrc, dashboardClientDest, { recursive: true });
  console.log(`  → ${dashboardClientDest}`);
}

// ── Compile a single binary ───────────────────────────────────────────
function compileBinary(outFile: string, target: string, isCrossCompile: boolean): boolean {
  console.log(`Compiling ${outFile} (target: ${target})...`);

  // Clean previous output for this binary
  if (existsSync(outFile)) rmSync(outFile);

  // Stage native assets for this target
  const prebuildName = isCrossCompile 
    ? target.replace(/^bun-/, "") 
    : hostPrebuildName();
  copyNativeAssets(isCrossCompile ? target as BunTarget : undefined);

  // Prepare asset paths for embedding
  const nativeAssetDir = join(runtimeDir, prebuildName);
  const assetArgs: string[] = [];
  
  // NOTE: Embedding native .node files with --assets doesn't work correctly
  // because Bun extracts them to a temp location but node-pty expects them
  // at specific relative paths. Instead, we stage them in the runtime/
  // directory and copy them alongside the binary during distribution.
  // The native-patch.ts module sets up the paths to find these staged assets.
  void nativeAssetDir; // Reference to avoid unused variable warning

  const proc = Bun.spawnSync({
    cmd: [
      "bun",
      "build",
      "--compile",
      entryPoint,
      "--outfile",
      outFile,
      "--target",
      target,
      "--minify",
    ],
    cwd: workspaceRoot,
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      NODE_PATH: join(workspaceRoot, "node_modules"),
      // Tell the runtime where to find native assets
      KB_RUNTIME_DIR: join(outDir, "runtime"),
    },
  });

  if (proc.exitCode !== 0) {
    console.error(`\nBun compile failed for ${target} with exit code ${proc.exitCode}`);
    return false;
  }

  console.log(`  ✓ ${outFile}`);
  return true;
}

// ── Main ──────────────────────────────────────────────────────────────
const { targets } = parseArgs();

// Copy assets once (shared across all binaries)
copyClientAssets();

if (targets === null) {
  // Default: build for current platform → dist/kb
  const outBinary = join(outDir, defaultBinaryName());
  const ok = compileBinary(outBinary, "bun", false);
  if (!ok) process.exit(1);
  console.log(`\n✓ Built: ${outBinary}`);
  console.log(`  Assets: ${dashboardClientDest}`);
  console.log(`  Runtime: ${runtimeDir}`);
  console.log(`\nRun with: ${outBinary} --help`);
} else {
  // Cross-compilation mode
  let failed = false;
  const built: string[] = [];

  for (const target of targets) {
    const name = binaryNameForTarget(target);
    const outBinary = join(outDir, name);
    const ok = compileBinary(outBinary, target, true);
    if (!ok) {
      failed = true;
    } else {
      built.push(name);
    }
  }

  console.log(`\n${failed ? "⚠" : "✓"} Cross-compilation complete.`);
  if (built.length > 0) {
    console.log(`  Built ${built.length} binaries:`);
    built.forEach((b) => console.log(`    dist/${b}`));
  }
  console.log(`  Assets: ${dashboardClientDest}`);
  console.log(`  Runtime: ${runtimeDir}`);

  if (failed) process.exit(1);
}
