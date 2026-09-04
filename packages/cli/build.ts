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
 *   bun run build.ts --allow-missing-native    # Explicitly permit a terminal-less binary
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
import { cpSync, mkdirSync, existsSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { bunTargetToPlatformArch, nodePtyPlatformPackageName, nodePtyPrebuildRelDir, nodePtyRequiredNativeAssetName, resolveStagingOutcome } from "./src/runtime/pty-native-assets.js";

const cliRoot = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(cliRoot, "..", "..");
const outDir = join(cliRoot, "dist");
const dashboardClientSrc = join(workspaceRoot, "packages", "dashboard", "dist", "client");
const dashboardClientDest = join(outDir, "client");
const runtimeDir = join(outDir, "runtime");
const entryPoint = join(cliRoot, "src", "bin.ts");

// ── Native module asset paths ─────────────────────────────────────────
// The @lydell/node-pty umbrella is aliased as node-pty in the dashboard manifest.
const dashboardPkgDir = join(workspaceRoot, "packages", "dashboard");
const _require = createRequire(join(dashboardPkgDir, "package.json"));
const nodePtyVersion = "1.2.0-beta.15";
const allowMissingNative = process.argv.includes("--allow-missing-native");

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
 * FNXC:Terminal 2026-09-04-01:43: Standalone builds must stage the script-free
 * @lydell/node-pty platform payload, or explicitly opt out; warn-and-skip shipped dead terminals.
 */
/*
 * FNXC:Terminal 2026-09-04-04:22:
 * Bun's build-time type shim is not the script-free runtime package. Resolve the actual
 * umbrella with Node so every standalone payload retains executable JavaScript rather
 * than a declaration file that would leave the terminal permanently unavailable.
 */
function resolveInstalledNodePtyUmbrellaRoot(): string {
  // Bun applies the dashboard tsconfig path shim to `node-pty`, which resolves
  // to the ambient declaration rather than the runtime package. Ask Node's
  // ordinary package resolver for the real aliased dependency before staging.
  const resolved = Bun.spawnSync({
    cmd: [
      "node",
      "-e",
      "const { createRequire } = require('node:module'); process.stdout.write(createRequire(process.argv[1]).resolve('node-pty'));",
      join(dashboardPkgDir, "package.json"),
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (resolved.exitCode !== 0) {
    throw new Error(`Unable to resolve the installed node-pty umbrella: ${new TextDecoder().decode(resolved.stderr)}`);
  }
  return dirname(new TextDecoder().decode(resolved.stdout).trim());
}

function copyNativeAssets(target?: BunTarget): boolean {
  const targetInfo = target
    ? bunTargetToPlatformArch(target)
    : { platform: process.platform, arch: process.arch };
  if (!targetInfo) return false;
  const { platform, arch } = targetInfo;
  const packageName = nodePtyPlatformPackageName(platform, arch);
  if (!packageName) return false;
  const prebuildName = `${platform}-${arch}`;
  const destDir = join(runtimeDir, prebuildName);

  try {
    let packageEntry: string;
    try {
      const umbrellaEntry = _require.resolve("node-pty");
      packageEntry = createRequire(umbrellaEntry).resolve(packageName);
    } catch {
      const fetch = Bun.spawnSync({
        cmd: [process.execPath, join(cliRoot, "scripts", "fetch-node-pty-platform-package.mjs"), platform, arch, nodePtyVersion],
        stdout: "pipe",
        stderr: "pipe",
      });
      if (fetch.exitCode !== 0) throw new Error(new TextDecoder().decode(fetch.stderr));
      packageEntry = join(new TextDecoder().decode(fetch.stdout).trim(), "lib", "index.js");
    }

    const packageRoot = dirname(dirname(packageEntry));
    const sourceDir = join(packageRoot, nodePtyPrebuildRelDir(platform, arch));
    const requiredAsset = nodePtyRequiredNativeAssetName(platform);
    if (!requiredAsset || !existsSync(join(sourceDir, requiredAsset))) {
      throw new Error(`Missing required native entry ${requiredAsset ?? "for unsupported platform"} in ${packageName}`);
    }

    rmSync(destDir, { recursive: true, force: true });
    /*
     * FNXC:Terminal 2026-09-04-02:17:
     * The release must carry each package's actual payload without install scripts.
     * Linux omits spawn-helper and Windows exposes ConPTY rather than pty.node, so
     * copying a hand-maintained companion manifest would reject valid targets.
     *
     * FNXC:Terminal 2026-09-04-03:11:
     * The umbrella package dynamically requires the selected platform package. Foreign
     * targets are absent from the host's filtered node_modules, so stage its JavaScript
     * alongside the payload for native-patch's Bun runtime redirect instead of shipping
     * a binary whose pty.node exists but whose package entry cannot resolve.
     */
    const umbrellaRoot = resolveInstalledNodePtyUmbrellaRoot();
    cpSync(sourceDir, destDir, { recursive: true });
    cpSync(packageRoot, join(destDir, "node-pty-platform"), { recursive: true });
    // Bun replaces its compiled node-pty import with `{}`. Keep the real umbrella
    // and its selected optional dependency on disk so the runtime can require it.
    cpSync(umbrellaRoot, join(destDir, "node-pty-umbrella"), { recursive: true });
    const stagedUmbrellaRoot = join(destDir, "node-pty-umbrella");
    cpSync(
      packageRoot,
      join(stagedUmbrellaRoot, "node_modules", "@lydell", packageName.slice("@lydell/".length)),
      { recursive: true },
    );
    // Bun's disk CJS loader does not search this staged node_modules tree for
    // the umbrella's computed package name. Make the selected request relative.
    const stagedUmbrellaIndex = join(stagedUmbrellaRoot, "index.js");
    const umbrellaSource = readFileSync(stagedUmbrellaIndex, "utf8");
    writeFileSync(
      stagedUmbrellaIndex,
      umbrellaSource.replace(
        "return require(PACKAGE_NAME);",
        `return require("./node_modules/${packageName}/lib/index.js");`,
      ),
    );
    console.log(`  → ${destDir} (${packageName}, disk-loaded umbrella + platform module + native entry ${requiredAsset})`);
    return true;
  } catch (error) {
    rmSync(destDir, { recursive: true, force: true });
    console.error(`  ERROR: Failed to stage ${packageName} for ${prebuildName}:`, error);
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
    ? (() => { const info = bunTargetToPlatformArch(target); return info ? `${info.platform}-${info.arch}` : target; })()
    : hostPrebuildName();
  const ptyStaged = copyNativeAssets(isCrossCompile ? target as BunTarget : undefined);
  const stagingOutcome = resolveStagingOutcome({ staged: ptyStaged, allowMissingNative });
  if (stagingOutcome === "fail") {
    console.error(`  ERROR: PTY payload could not be staged for ${prebuildName}. Pass --allow-missing-native only to explicitly produce a terminal-less binary.`);
    return false;
  }
  if (stagingOutcome === "warn") {
    console.warn(`  WARNING: Building ${prebuildName} without its PTY payload because --allow-missing-native was passed.`);
  }
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
      /*
      FNXC:StandaloneExeBuild 2026-07-23-21:30:
      playwright-core (feature-video review artifacts) optionally requires chromium-bidi
      inside its coreBundle for BiDi transport. chromium-bidi is not a dependency of this
      workspace, so Bun's compile-time resolution fails on those requires. Mark the whole
      package external — playwright-core only reaches that require when a BiDi browser
      channel is requested, which the feature-video pipeline never does (it uses CDP).
      */
      "--external",
      "chromium-bidi",
      "--external",
      "chromium-bidi/*",
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
