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
 *   - Ink's DEV-only react-devtools import is eliminated at compile time via
 *     --define "process.env.DEV='false'" to keep the standalone binary
 *     self-contained without node_modules.
 */

import { join, dirname } from "node:path";
import { cpSync, mkdirSync, existsSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const cliRoot = dirname(fileURLToPath(import.meta.url));
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
 * e.g. "bun-linux-x64" → "fn-cli-linux-x64", "bun-windows-x64" → "fn-cli-windows-x64.exe"
 *
 * FNXC:Release 2026-07-04-00:00:
 * GitHub Release CLI assets use the `fn-cli-` base name (not `fn-`) so the
 * downloadable binary doesn't collide with other well-known `fn` tools on a
 * user's PATH. The local dev binary (defaultBinaryName) intentionally stays
 * `fn`/`fn.exe` — this rename only affects cross-compiled release assets.
 */
function binaryNameForTarget(target: BunTarget): string {
  // "bun-linux-x64" → "linux-x64"
  const suffix = target.replace(/^bun-/, "");
  const isWindows = target.includes("windows");
  return `fn-cli-${suffix}${isWindows ? ".exe" : ""}`;
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

/*
FNXC:StandaloneExeMigrations 2026-07-17-13:40:
The compiled binary cannot read module-relative assets out of /$bunfs, so the
PostgreSQL migrations must ship as real files next to the binary. Stage
packages/core/src/postgres/migrations (same source tsup.config.ts stages into
dist/migrations for the npm package) into the exe output dir; core's
schema-applier resolves them execPath-relative at runtime.
*/
const pgMigrationsSrc = join(workspaceRoot, "packages", "core", "src", "postgres", "migrations");
const pgMigrationsDest = join(outDir, "migrations");

function stageMigrations(): void {
  if (!existsSync(pgMigrationsSrc)) {
    console.warn(
      `WARNING: PostgreSQL migrations source not found at ${pgMigrationsSrc}; the standalone binary will fail to apply schema migrations.`,
    );
    return;
  }
  if (existsSync(pgMigrationsDest)) {
    rmSync(pgMigrationsDest, { recursive: true, force: true });
  }
  cpSync(pgMigrationsSrc, pgMigrationsDest, { recursive: true });
  console.log(`  → ${pgMigrationsDest}`);
}

// ── Embedded PostgreSQL runtime staging ───────────────────────────────
/*
FNXC:StandaloneExeEmbeddedPg 2026-07-17-14:20:
core's embedded-lifecycle loads `embedded-postgres` via createRequire at
runtime (deliberately outside the bundler graph). Inside the compiled binary
that resolution fails: bun --compile binaries perform NO node_modules
bare-specifier resolution at runtime — not even through a createRequire
anchored at a real on-disk directory (verified empirically: requiring an
absolute path works, but any bare import like "pg" from that file then fails).
A staged node_modules tree therefore cannot work. Instead, stage a fully
self-contained esbuild CJS bundle of embedded-postgres (pg, async-exit-hook,
and the matching @embedded-postgres/<platform> entry inlined) at
  dist/runtime/<platform>/embedded-postgres/dist/index.cjs
plus the native initdb/pg_ctl/postgres payload at
  dist/runtime/<platform>/embedded-postgres/native/
The platform package resolves its binaries via import.meta.url ("../native/
bin/..."), so import.meta.url is defined to the bundle's own file URL and the
native tree is staged one level up — the same relative layout the package
expects. embedded-lifecycle probes this execPath-relative dir (or
FUSION_EMBEDDED_PG_RUNTIME_DIR) only when normal resolution fails.
pnpm-workspace.yaml supportedArchitectures limits local installs to the host
OS, so targets whose platform payload is absent on the build host get a
warning and no embedded payload (DATABASE_URL mode is unaffected), mirroring
the spirit of verifyEmbeddedPostgresPayloads in
packages/desktop/scripts/workspace-tools.ts.
*/
const coreRequire = createRequire(join(workspaceRoot, "packages", "core", "package.json"));

const ALL_EMBEDDED_PG_PLATFORM_PACKAGES = [
  "@embedded-postgres/darwin-arm64",
  "@embedded-postgres/darwin-x64",
  "@embedded-postgres/linux-arm64",
  "@embedded-postgres/linux-x64",
  "@embedded-postgres/linux-arm",
  "@embedded-postgres/linux-ia32",
  "@embedded-postgres/linux-ppc64",
  "@embedded-postgres/windows-x64",
] as const;

/** Map a runtime prebuild name (e.g. "darwin-arm64", "windows-x64") to the platform package. */
function embeddedPgPlatformPackageFor(prebuildName: string): string | null {
  const [plat, arch] = prebuildName.split("-");
  const os = plat === "windows" || plat === "win32" ? "windows" : plat;
  const name = `@embedded-postgres/${os}-${arch}`;
  return (ALL_EMBEDDED_PG_PLATFORM_PACKAGES as readonly string[]).includes(name) ? name : null;
}

function stageEmbeddedPostgresRuntime(target?: BunTarget): boolean {
  const prebuildName = target ? targetToPrebuildName(target) : hostPrebuildName();
  const destRoot = join(runtimeDir, prebuildName, "embedded-postgres");
  try {
    if (existsSync(destRoot)) {
      rmSync(destRoot, { recursive: true, force: true });
    }
    mkdirSync(join(destRoot, "dist"), { recursive: true });

    let embeddedPgJsonPath: string;
    try {
      embeddedPgJsonPath = coreRequire.resolve("embedded-postgres/package.json");
    } catch {
      console.warn(
        `  WARNING: embedded-postgres is not resolvable from @fusion/core; the ${prebuildName} binary will not support the default embedded database mode.`,
      );
      return false;
    }
    const embeddedPgRoot = dirname(embeddedPgJsonPath);
    const embeddedPgEntry = join(embeddedPgRoot, "dist", "index.js");
    const embeddedPgRequire = createRequire(embeddedPgJsonPath);

    // Resolve the target's native payload (an optionalDependency of
    // embedded-postgres, resolved from its own location). Absent payloads are
    // a warning, not a failure — pnpm only installs the host OS's packages.
    const platformPkg = embeddedPgPlatformPackageFor(prebuildName);
    let nativeSrc: string | null = null;
    if (platformPkg) {
      try {
        const platformEntry = embeddedPgRequire.resolve(platformPkg);
        const candidate = join(dirname(platformEntry), "..", "native");
        if (existsSync(join(candidate, "bin"))) nativeSrc = candidate;
      } catch {
        nativeSrc = null;
      }
    }
    if (!platformPkg || !nativeSrc) {
      console.warn(
        `  WARNING: embedded-postgres native payload (${platformPkg ?? "unmapped platform"}) is not installed on this host for target ${prebuildName}. ` +
          `Embedded database mode will be unavailable in this build (DATABASE_URL mode is unaffected).`,
      );
    }

    // Bundle embedded-postgres + deps into one self-contained CJS file. The
    // target's platform package is inlined; the other platforms' dynamic
    // imports stay external (their branches never execute at runtime).
    const esbuildBin = join(workspaceRoot, "node_modules", ".bin", process.platform === "win32" ? "esbuild.cmd" : "esbuild");
    if (!existsSync(esbuildBin)) {
      console.warn(`  WARNING: esbuild not found at ${esbuildBin}; cannot stage embedded-postgres runtime.`);
      return false;
    }
    const externals = ALL_EMBEDDED_PG_PLATFORM_PACKAGES.filter(
      (name) => !(nativeSrc && name === platformPkg),
    );
    const outFile = join(destRoot, "dist", "index.cjs");
    const esbuildArgs = [
      embeddedPgEntry,
      "--bundle",
      "--platform=node",
      "--format=cjs",
      `--outfile=${outFile}`,
      // The inlined platform package computes native binary paths from
      // import.meta.url; point it at the bundle's own real file location.
      "--define:import.meta.url=__fusionEmbeddedPgBundleUrl",
      "--banner:js=const __fusionEmbeddedPgBundleUrl = require('node:url').pathToFileURL(__filename).href;",
      "--external:pg-native",
      ...externals.map((name) => `--external:${name}`),
      "--log-level=warning",
    ];
    const bundleProc = Bun.spawnSync({ cmd: [esbuildBin, ...esbuildArgs], cwd: workspaceRoot, stdout: "inherit", stderr: "inherit" });
    if (bundleProc.exitCode !== 0) {
      console.error(`  ERROR: esbuild bundling of embedded-postgres failed for ${prebuildName} (exit ${bundleProc.exitCode}).`);
      return false;
    }

    if (nativeSrc) {
      // Preserve symlinks (macOS dylib ABI-compat links) and executable bits.
      cpSync(nativeSrc, join(destRoot, "native"), { recursive: true });
    }
    console.log(`  → ${destRoot} (embedded-postgres runtime bundle${nativeSrc ? " + native payload" : ", JS only"})`);
    return nativeSrc !== null;
  } catch (err) {
    console.error(`  ERROR: Failed to stage embedded-postgres runtime for ${prebuildName}:`, err);
    return false;
  }
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
  // FNXC:StandaloneExeEmbeddedPg 2026-07-17-13:40:
  // Must run AFTER copyNativeAssets — that function recreates runtime/<plat>/
  // and would wipe a previously staged embedded-postgres tree.
  stageEmbeddedPostgresRuntime(isCrossCompile ? target as BunTarget : undefined);

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
      // Ink conditionally loads devtools when process.env.DEV === "true".
      // Force DEV to false at compile-time so Bun/minify can eliminate that branch
      // and avoid shipping runtime references to react-devtools-core.
      "--define",
      "process.env.DEV='false'",
      // cpu-features: native .node binding from ssh2 (transitive via dockerode); ssh2 falls back to pure JS when unavailable
      "--external",
      "cpu-features",
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
// FNXC:StandaloneExeMigrations 2026-07-17-13:40:
// PostgreSQL migrations ship next to the binary (platform-independent, staged once).
stageMigrations();

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
