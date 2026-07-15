#!/usr/bin/env node
/*
 * FNXC:DesktopEmbeddedPostgres 2026-07-15-00:20:
 * Linux AppImage release verification for embedded Postgres packaging.
 * v0.60.0 shipped without embedded-postgres / main-bootstrap / omp-runtime inside the
 * AppImage, so Local mode could never boot on Linux. Existence of the .AppImage file
 * alone is insufficient — assert the packaged Electron tree after electron-builder.
 *
 * Prefer inspecting electron-builder's linux-*-unpacked directories (no squashfs tools
 * required). Optionally also list AppImage contents when unsquashfs is available.
 *
 * Usage:
 *   node scripts/verify-desktop-linux-pg-packaging.mjs
 *   node scripts/verify-desktop-linux-pg-packaging.mjs --dist packages/desktop/dist-electron
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// FNXC:DesktopEmbeddedPostgres 2026-07-15-10:45:
// Use fileURLToPath(import.meta.url) + path.dirname — eslint no-undef rejects
// bare `URL` in .mjs (not in env globals for this script).
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const require = createRequire(import.meta.url);

/*
 * FNXC:DesktopEmbeddedPostgres 2026-07-15-00:30:
 * Greptile P1: omp-runtime can appear as package metadata without a built dist.
 * Dashboard Local mode imports the package's import condition, which resolves to
 * dist/index.js (and probe.js for runtime probes). Require those entrypoints.
 */
const OMP_RUNTIME_ASAR_ENTRYPOINTS = [
  "/node_modules/@fusion-plugin-examples/omp-runtime/dist/index.js",
  "/node_modules/@fusion-plugin-examples/omp-runtime/dist/probe.js",
];

function parseArgs(argv) {
  let distDir = join(repoRoot, "packages", "desktop", "dist-electron");
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--dist" && argv[i + 1]) {
      distDir = resolve(argv[++i]);
    }
  }
  return { distDir };
}

function fail(message) {
  console.error(`[verify-desktop-linux-pg] ${message}`);
  process.exitCode = 1;
}

function ok(message) {
  console.log(`[verify-desktop-linux-pg] ${message}`);
}

function findAsar() {
  // @electron/asar is a transitive dep of electron-builder. Under pnpm it is
  // often not importable via createRequire from the monorepo root, so fall back
  // to scanning the virtual store after the normal resolve paths.
  const resolvePaths = [
    join(repoRoot, "packages", "desktop"),
    repoRoot,
    process.cwd(),
  ];
  for (const base of resolvePaths) {
    try {
      return require.resolve("@electron/asar/bin/asar.js", { paths: [base] });
    } catch {
      // try next base
    }
  }
  try {
    return require.resolve("@electron/asar/bin/asar.js");
  } catch {
    // continue to pnpm store scan
  }

  for (const storeRoot of [
    join(repoRoot, "node_modules", ".pnpm"),
    join(repoRoot, "packages", "desktop", "node_modules", ".pnpm"),
  ]) {
    if (!existsSync(storeRoot)) continue;
    for (const entry of readdirSync(storeRoot)) {
      if (!entry.startsWith("@electron+asar@")) continue;
      const candidate = join(
        storeRoot,
        entry,
        "node_modules",
        "@electron",
        "asar",
        "bin",
        "asar.js",
      );
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * electron-builder writes one unpacked directory per arch under dist-electron.
 * Accept both historical and current naming patterns.
 */
function discoverUnpackedDirs(distDir) {
  if (!existsSync(distDir)) return [];
  return readdirSync(distDir)
    .filter((name) => {
      if (!name.includes("unpacked")) return false;
      const full = join(distDir, name);
      try {
        return statSync(full).isDirectory();
      } catch {
        return false;
      }
    })
    .map((name) => join(distDir, name))
    .filter((full) => {
      // Linux targets only (skip mac-unpacked / win-unpacked when mixed).
      const base = full.split(/[/\\]/).pop() ?? "";
      return base.startsWith("linux") || base.includes("linux");
    });
}

function resourcesRoot(unpackedDir) {
  // electron-builder linux layout: <unpacked>/resources/app.asar
  const direct = join(unpackedDir, "resources");
  if (existsSync(join(direct, "app.asar"))) return direct;
  return null;
}

/**
 * FNXC:DesktopEmbeddedPostgres 2026-07-15-00:30:
 * Greptile P1: postgres/initdb can be present while postinstall soname links from
 * hydrate-symlinks.js (pg-symlinks.json) are missing. Linux then fails at runtime
 * with missing libicui18n.so.60 (etc.). Assert every recorded target path exists
 * (symlink or regular file) under the platform native root.
 */
function assertPlatformSonameLinks(unpackedDir, platformRoot, platform) {
  const nativeRoot = join(platformRoot, platform, "native");
  const markerPath = join(nativeRoot, "pg-symlinks.json");
  if (!existsSync(markerPath)) {
    fail(`${unpackedDir}: ${platform} missing native/pg-symlinks.json (cannot verify soname links)`);
    return;
  }

  let entries;
  try {
    entries = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch (err) {
    fail(
      `${unpackedDir}: ${platform} native/pg-symlinks.json is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    fail(`${unpackedDir}: ${platform} native/pg-symlinks.json has no link entries`);
    return;
  }

  const packageRoot = join(platformRoot, platform);
  let missing = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const sourceRel = typeof entry.source === "string" ? entry.source : "";
    const targetRel = typeof entry.target === "string" ? entry.target : "";
    if (!sourceRel || !targetRel) continue;

    // Paths in pg-symlinks.json are relative to the platform package root
    // (e.g. "native/lib/libicui18n.so.60.2" -> "native/lib/libicui18n.so.60").
    const sourcePath = join(packageRoot, sourceRel);
    const targetPath = join(packageRoot, targetRel);

    if (!pathExists(sourcePath)) {
      fail(`${unpackedDir}: ${platform} missing soname source ${sourceRel}`);
      missing += 1;
      continue;
    }
    if (!pathExists(targetPath)) {
      fail(
        `${unpackedDir}: ${platform} missing soname link target ${targetRel} ` +
          `(hydrate-symlinks postinstall did not materialize ABI names; ` +
          `embedded Postgres will fail with shared-library load errors)`,
      );
      missing += 1;
    }
  }
  if (missing === 0) {
    ok(`${unpackedDir}: ${platform} soname links present (${entries.length} pg-symlinks entries)`);
  }
}

/** True if path exists as a real file, directory, or non-dangling symlink. */
function pathExists(p) {
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) {
      // Dangling links must fail — existsSync follows and returns false for those.
      return existsSync(p);
    }
    return true;
  } catch {
    return false;
  }
}

function listIncludesAsarPath(list, entry) {
  // asar list prints paths with a leading slash.
  return list.includes(entry) || list.includes(entry.replace(/^\//, ""));
}

function assertUnpackedTree(unpackedDir, asarBin) {
  const resources = resourcesRoot(unpackedDir);
  if (!resources) {
    fail(`${unpackedDir}: missing resources/app.asar`);
    return;
  }

  const asarPath = join(resources, "app.asar");
  const unpackedNm = join(resources, "app.asar.unpacked", "node_modules");
  const embeddedRoot = join(unpackedNm, "embedded-postgres");
  const platformRoot = join(unpackedNm, "@embedded-postgres");

  if (!existsSync(embeddedRoot)) {
    fail(`${unpackedDir}: app.asar.unpacked is missing embedded-postgres (asarUnpack/files allowlist broken)`);
  } else {
    ok(`${unpackedDir}: embedded-postgres present under app.asar.unpacked`);
  }

  if (!existsSync(platformRoot)) {
    fail(`${unpackedDir}: app.asar.unpacked is missing @embedded-postgres/*`);
  } else {
    const platforms = readdirSync(platformRoot).filter((n) => n.startsWith("linux-"));
    if (platforms.length === 0) {
      fail(`${unpackedDir}: no @embedded-postgres/linux-* packages in asar.unpacked (got: ${readdirSync(platformRoot).join(", ") || "none"})`);
    } else {
      ok(`${unpackedDir}: platform packages: ${platforms.join(", ")}`);
      for (const platform of platforms) {
        for (const bin of ["initdb", "pg_ctl", "postgres"]) {
          const binPath = join(platformRoot, platform, "native", "bin", bin);
          if (!existsSync(binPath)) {
            fail(`${unpackedDir}: missing ${platform}/native/bin/${bin}`);
          }
        }
        assertPlatformSonameLinks(unpackedDir, platformRoot, platform);
      }
    }
  }

  // package.json main must be the CJS bootstrap that patches spawn before ESM main.
  if (!asarBin) {
    fail("Could not resolve @electron/asar; cannot read packaged package.json main");
    return;
  }
  const listed = spawnSync(process.execPath, [asarBin, "list", asarPath], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (listed.status !== 0) {
    fail(`asar list failed for ${asarPath}: ${listed.stderr || listed.stdout}`);
    return;
  }
  const list = listed.stdout;
  if (!list.includes("main-bootstrap.cjs") && !list.includes("/dist/main-bootstrap.cjs")) {
    fail(`${unpackedDir}: app.asar is missing dist/main-bootstrap.cjs`);
  } else {
    ok(`${unpackedDir}: main-bootstrap.cjs present in app.asar`);
  }

  // Require the runnable dist entrypoints, not a bare "omp-runtime" substring.
  const missingOmp = OMP_RUNTIME_ASAR_ENTRYPOINTS.filter((entry) => !listIncludesAsarPath(list, entry));
  if (missingOmp.length > 0) {
    fail(
      `${unpackedDir}: app.asar missing omp-runtime dist entrypoint(s): ${missingOmp.join(", ")} ` +
        `(package metadata alone is insufficient; Local mode fails with ERR_MODULE_NOT_FOUND after PG boot)`,
    );
  } else {
    ok(`${unpackedDir}: omp-runtime dist entrypoints present in app.asar`);
  }

  // extract-file writes package.json into cwd — use a private temp dir under resources.
  const extractCwd = join(resources, ".fusion-pg-verify-tmp");
  try {
    rmSync(extractCwd, { recursive: true, force: true });
    mkdirSync(extractCwd, { recursive: true });
    const extracted = spawnSync(
      process.execPath,
      [asarBin, "extract-file", asarPath, "package.json"],
      { encoding: "utf8", cwd: extractCwd },
    );
    const pkgPath = join(extractCwd, "package.json");
    if (extracted.status !== 0 || !existsSync(pkgPath)) {
      fail(
        `${unpackedDir}: failed to extract package.json from app.asar (${extracted.stderr || extracted.stdout})`,
      );
      return;
    }
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (pkg.main !== "dist/main-bootstrap.cjs") {
      fail(
        `${unpackedDir}: package.json main is ${JSON.stringify(pkg.main)}; expected "dist/main-bootstrap.cjs"`,
      );
    } else {
      ok(`${unpackedDir}: package.json main is dist/main-bootstrap.cjs`);
    }
  } catch (err) {
    fail(`${unpackedDir}: package.json main check error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    rmSync(extractCwd, { recursive: true, force: true });
  }
}

function main() {
  const { distDir } = parseArgs(process.argv.slice(2));
  ok(`inspecting ${distDir}`);

  const unpacked = discoverUnpackedDirs(distDir);
  if (unpacked.length === 0) {
    fail(
      `No linux-*-unpacked directories under ${distDir}. ` +
        "Run electron-builder --linux first (or pass --dist to the packaging output).",
    );
    return;
  }

  const asarBin = findAsar();
  for (const dir of unpacked) {
    assertUnpackedTree(dir, asarBin);
  }

  if (process.exitCode && process.exitCode !== 0) {
    fail("Linux desktop embedded Postgres packaging verification FAILED");
    return;
  }
  ok("Linux desktop embedded Postgres packaging verification passed");
}

main();
