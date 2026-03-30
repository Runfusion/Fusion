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

import { join, dirname } from "node:path";
import { cpSync, mkdirSync, existsSync, rmSync } from "node:fs";

const cliRoot = dirname(new URL(import.meta.url).pathname);
const workspaceRoot = join(cliRoot, "..", "..");
const outDir = join(cliRoot, "dist");
const dashboardClientSrc = join(workspaceRoot, "packages", "dashboard", "dist", "client");
const dashboardClientDest = join(outDir, "client");
const entryPoint = join(cliRoot, "src", "bin.ts");

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
function compileBinary(outFile: string, target: string): boolean {
  console.log(`Compiling ${outFile} (target: ${target})...`);

  // Clean previous output for this binary
  if (existsSync(outFile)) rmSync(outFile);

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
  const ok = compileBinary(outBinary, "bun");
  if (!ok) process.exit(1);
  console.log(`\n✓ Built: ${outBinary}`);
  console.log(`  Assets: ${dashboardClientDest}`);
  console.log(`\nRun with: ${outBinary} --help`);
} else {
  // Cross-compilation mode
  let failed = false;
  const built: string[] = [];

  for (const target of targets) {
    const name = binaryNameForTarget(target);
    const outBinary = join(outDir, name);
    const ok = compileBinary(outBinary, target);
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

  if (failed) process.exit(1);
}
