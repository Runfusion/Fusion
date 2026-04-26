#!/usr/bin/env bun
/**
 * Bun compile build script for the `fn` CLI.
 *
 * Produces a single self-contained executable at packages/cli/dist/fn
 * with the dashboard client assets co-located at packages/cli/dist/client/.
 *
 * Usage:
 *   bun run build.ts                           # Build for current platform
 *   bun run build.ts --target bun-linux-x64    # Cross-compile for Linux x64
 *   bun run build.ts --all                     # Build for all supported platforms
 *
 * Prerequisites:
 *   - Bun >= 1.1 (cross-compilation support)
 *
 * Notes:
 *   - If dashboard client assets are missing, this script generates a
 *     minimal dist/client/index.html stub so clean-checkout tests can run.
 */

import { join, dirname } from "node:path";
import { cpSync, mkdirSync, existsSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";

const cliRoot = dirname(new URL(import.meta.url).pathname);
const workspaceRoot = join(cliRoot, "..", "..");
const outDir = join(cliRoot, "dist");
const dashboardClientSrc = join(workspaceRoot, "packages", "dashboard", "dist", "client");
const dashboardClientDest = join(outDir, "client");
const runtimeDir = join(outDir, "runtime");
const entryPoint = join(cliRoot, "src", "bin.ts");

// ── Native module asset paths ─────────────────────────────────────────
// Resolve the @homebridge/node-pty-prebuilt-multiarch install root dynamically.
// The package is aliased as "node-pty" in package.json of @fusion/dashboard.
// We must create the require from the dashboard package location so Node resolves
// node-pty via the dashboard's node_modules (where the alias is installed).
const dashboardPkgDir = join(workspaceRoot, "packages", "dashboard");
const _require = createRequire(join(dashboardPkgDir, "package.json"));
let nodePtyRoot: string;
try {
  const pkgJsonPath = _require.resolve("node-pty/package.json");
  nodePtyRoot = dirname(pkgJsonPath);
  console.log(`  node-pty resolved to: ${nodePtyRoot}`);
} catch {
  // Fallback: check pnpm's shared node_modules
  const fallback = join(workspaceRoot, "node_modules", ".pnpm", "node_modules", "node-pty");
  if (existsSync(fallback)) {
    nodePtyRoot = fallback;
    console.log(`  node-pty fallback resolved to: ${nodePtyRoot}`);
  } else {
    // Last resort: rely on pnpm symlink structure
    nodePtyRoot = join(dashboardPkgDir, "node_modules", "node-pty");
    console.log(`  node-pty last-resort resolved to: ${nodePtyRoot}`);
  }
}

/**
 * Pick the highest ABI .node file from a prebuilds/<plat-arch>/ directory
 * that is <= the host Node.js ABI, returning its full path (or null).
 * The fork names files like: node.abi115.node, node.abi115.musl.node
 * We want the non-musl version (glibc) for cross-compile targets.
 */
function pickHighestAbiNode(prebuildDir: string, targetAbi: number): string | null {
  let files: string[];
  try {
    files = readdirSync(prebuildDir);
  } catch {
    return null;
  }
  // Match node.abi<N>.node (non-musl)
  const abiRe = /^node\.abi(\d+)\.node$/;
  let best: { abi: number; file: string } | null = null;
  for (const f of files) {
    const m = abiRe.exec(f);
    if (!m) continue;
    const abi = parseInt(m[1], 10);
    if (abi <= targetAbi && (!best || abi > best.abi)) {
      best = { abi, file: f };
    }
  }
  return best ? join(prebuildDir, best.file) : null;
}

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
 * e.g. "bun-linux-x64" → "fn-linux-x64", "bun-windows-x64" → "fn-windows-x64.exe"
 */
function binaryNameForTarget(target: BunTarget): string {
  // "bun-linux-x64" → "linux-x64"
  const suffix = target.replace(/^bun-/, "");
  const isWindows = target.includes("windows");
  return `fn-${suffix}${isWindows ? ".exe" : ""}`;
}

/**
 * Determine the default binary name for the current platform (no cross-compile).
 */
function defaultBinaryName(): string {
  return process.platform === "win32" ? "fn.exe" : "fn";
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

// ── Client asset staging ──────────────────────────────────────────────
type ClientAssetMode = "real" | "stub";

const CLIENT_STUB_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Fusion Dashboard</title>
  </head>
  <body>
    <main>
      <h1>Fusion Dashboard</h1>
      <p>Dashboard assets not built — run \`pnpm build\` to generate full client assets.</p>
    </main>
  </body>
</html>
`;

function ensureClientAssets(): ClientAssetMode {
  try {
    if (existsSync(dashboardClientDest)) {
      rmSync(dashboardClientDest, { recursive: true, force: true });
    }
  } catch {
    // Ignore cleanup errors - directory might not exist or be accessible
  }

  mkdirSync(outDir, { recursive: true });

  if (existsSync(dashboardClientSrc)) {
    console.log("Copying dashboard client assets...");
    cpSync(dashboardClientSrc, dashboardClientDest, { recursive: true });
    console.log(`  → ${dashboardClientDest}`);
    return "real";
  }

  mkdirSync(dashboardClientDest, { recursive: true });
  writeFileSync(join(dashboardClientDest, "index.html"), CLIENT_STUB_HTML, "utf-8");
  console.warn(
    `WARNING: Dashboard client assets not found at ${dashboardClientSrc}. Generated minimal stub at ${join(dashboardClientDest, "index.html")}.`,
  );
  return "stub";
}

// ── Copy native terminal assets for a specific target ─────────────────
/**
 * Stage @homebridge/node-pty-prebuilt-multiarch native assets for the given target.
 * Assets are placed in dist/runtime/<platform-arch>/ alongside client/.
 *
 * The fork ships two layouts:
 *   - build/Release/pty.node   — placed here by `prebuild-install` at install time
 *                                (present on the HOST platform only)
 *   - prebuilds/linux-<arch>/node.abi<N>.node — bundled inside the npm tarball
 *                                (present for Linux targets on any host)
 *
 * Strategy per target:
 *   - Host (no --target flag):     use build/Release/pty.node + build/Release/spawn-helper
 *   - bun-linux-x64/arm64:        use prebuilds/linux-<arch>/node.abi<N>.node (highest ≤ host ABI)
 *   - bun-darwin-x64/arm64:       prebuilds not bundled; warn and skip (cross-compile unsupported)
 *   - bun-windows-x64:            prebuilds not bundled; warn and skip
 */
function copyNativeAssets(target?: BunTarget): boolean {
  const prebuildName = target ? targetToPrebuildName(target) : hostPrebuildName();
  const destDir = join(runtimeDir, prebuildName);

  try {
    // Clean and recreate dest
    if (existsSync(destDir)) {
      rmSync(destDir, { recursive: true, force: true });
    }
    mkdirSync(destDir, { recursive: true });

    // ── Determine source pty.node ─────────────────────────────────────
    let ptyNodeSrc: string | null = null;
    let spawnHelperSrc: string | null = null;

    if (!target) {
      // HOST build: use the prebuild-install output in build/Release/
      const releaseDir = join(nodePtyRoot, "build", "Release");
      const candidate = join(releaseDir, "pty.node");
      if (existsSync(candidate)) {
        ptyNodeSrc = candidate;
        const helper = join(releaseDir, "spawn-helper");
        if (existsSync(helper)) spawnHelperSrc = helper;
      } else {
        // Fallback: maybe prebuilds/<plat-arch>/ exists (older fork layout or manually extracted)
        const prebuildDir = join(nodePtyRoot, "prebuilds", prebuildName);
        const hostAbi = parseInt(process.versions.modules, 10);
        ptyNodeSrc = pickHighestAbiNode(prebuildDir, hostAbi);
        if (!ptyNodeSrc && existsSync(join(prebuildDir, "pty.node"))) {
          // Some layouts ship pty.node directly (shouldn't happen with this fork, but guard)
          ptyNodeSrc = join(prebuildDir, "pty.node");
        }
        const helper = join(prebuildDir, "spawn-helper");
        if (existsSync(helper)) spawnHelperSrc = helper;
      }
    } else if (target.startsWith("bun-linux-")) {
      // Linux cross-compile: use the pre-bundled prebuilds/ in the npm tarball
      const [, , arch] = target.split("-") as [string, string, string]; // bun-linux-<arch>
      // Bun's arm64 → arm64, but armv7 is "arm" in prebuilds
      const linuxArch = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : arch;
      const prebuildDir = join(nodePtyRoot, "prebuilds", `linux-${linuxArch}`);
      const hostAbi = parseInt(process.versions.modules, 10);
      ptyNodeSrc = pickHighestAbiNode(prebuildDir, hostAbi);
      if (ptyNodeSrc) {
        const helper = join(prebuildDir, "spawn-helper");
        if (existsSync(helper)) spawnHelperSrc = helper;
      }
    } else {
      // darwin or windows cross-compile: prebuilds are NOT bundled in the tarball.
      // They are only present in build/Release/ after prebuild-install runs on that host.
      // Warn and skip rather than erroring — the binary will start but terminal won't work.
      console.warn(
        `  WARNING: Cross-compiling for ${target} from ${hostPrebuildName()}. ` +
        `The @homebridge/node-pty-prebuilt-multiarch package only bundles Linux prebuilds in the npm tarball. ` +
        `Darwin/Windows prebuilds are downloaded by prebuild-install at install time on the target host. ` +
        `Terminal functionality will be unavailable in this cross-compiled build.`
      );
      return false;
    }

    if (!ptyNodeSrc) {
      console.warn(`  WARNING: No pty.node found for target ${prebuildName}. Terminal will be unavailable.`);
      console.warn(`    Looked in: ${join(nodePtyRoot, "build", "Release")} and ${join(nodePtyRoot, "prebuilds", prebuildName)}`);
      return false;
    }

    // Copy pty.node (renamed to stable "pty.node" so native-patch.ts can find it)
    const ptyNodeDest = join(destDir, "pty.node");
    cpSync(ptyNodeSrc, ptyNodeDest);
    console.log(`  → ${destDir}/pty.node  (from ${ptyNodeSrc})`);

    // Copy spawn-helper if available (Unix platforms)
    if (spawnHelperSrc) {
      cpSync(spawnHelperSrc, join(destDir, "spawn-helper"));
      console.log(`  → ${destDir}/spawn-helper`);
    }

    return true;
  } catch (err) {
    console.error(`  ERROR: Failed to copy native assets for ${prebuildName}:`, err);
    return false;
  }
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
      "--conditions=source",
    ],
    cwd: workspaceRoot,
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      NODE_PATH: join(workspaceRoot, "node_modules"),
      // Tell the runtime where to find native assets
      FUSION_RUNTIME_DIR: join(outDir, "runtime"),
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

// Stage assets once (shared across all binaries)
const clientAssetMode = ensureClientAssets();

if (targets === null) {
  // Default: build for current platform → dist/fn
  const outBinary = join(outDir, defaultBinaryName());
  const ok = compileBinary(outBinary, "bun", false);
  if (!ok) process.exit(1);
  console.log(`\n✓ Built: ${outBinary}`);
  console.log(`  Assets: ${dashboardClientDest} (${clientAssetMode})`);
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
  console.log(`  Assets: ${dashboardClientDest} (${clientAssetMode})`);
  console.log(`  Runtime: ${runtimeDir}`);

  if (failed) process.exit(1);
}
