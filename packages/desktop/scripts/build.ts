import { build } from "esbuild";
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { buildDashboardClient, packageRoot, workspaceRoot } from "./workspace-tools";
const dashboardClientDir = join(workspaceRoot, "packages", "dashboard", "dist", "client");
const desktopDistDir = join(packageRoot, "dist");
const desktopClientDistDir = join(desktopDistDir, "client");
// FNXC:DesktopBuild 2026-06-25-09:45:
// Every workspace @fusion/* package and native (.node) module must stay external
// to the Electron main/preload bundles — they resolve from node_modules at runtime.
// @fusion/engine was missing here, so esbuild followed local-runtime.ts's dynamic
// `import("@fusion/engine")` and tried to bundle engine's transitive node-pty
// (@homebridge/node-pty-prebuilt-multiarch) native binaries, failing with
// "No loader is configured for .node files" and breaking every desktop release build.
/*
 * FNXC:SqliteFinalRemoval 2026-06-24-16:10:
 * Removed better-sqlite3 from externals — the data path no longer uses
 * better-sqlite3 (SQLite is accessed via node:sqlite/bun:sqlite in the adapter,
 * and PostgreSQL is the production backend).
 */
const sharedExternals = [
  "electron",
  "@fusion/core",
  "@fusion/dashboard",
  "@fusion/engine",
];
const mainExternals = sharedExternals;
const preloadExternals = sharedExternals;

async function ensureDashboardBuild(): Promise<void> {
  console.log("[desktop:build] Building dashboard client...");
  await buildDashboardClient();

  try {
    await stat(dashboardClientDir);
  } catch {
    throw new Error(`Dashboard client assets not found: ${dashboardClientDir}`);
  }
}

async function buildElectronEntrypoints(): Promise<void> {
  console.log("[desktop:build] Bundling Electron main/preload with esbuild...");

  await Promise.all([
    build({
      entryPoints: [join(packageRoot, "src", "main.ts")],
      outfile: join(desktopDistDir, "main.js"),
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      sourcemap: true,
      external: mainExternals,
      logLevel: "info",
    }),
    build({
      entryPoints: [join(packageRoot, "src", "preload.ts")],
      outfile: join(desktopDistDir, "preload.js"),
      bundle: true,
      // Preload scripts must be CommonJS — Electron loads them via the
      // sandboxed Node context, not as ESM. With format:"esm" the
      // contextBridge calls silently no-op and window.fusionShell /
      // window.fusionAPI stay undefined, which made the dashboard fall
      // through to "can't reach the Fusion backend" and the launch gate
      // always bypass.
      format: "cjs",
      platform: "node",
      target: "node22",
      sourcemap: true,
      packages: "external",
      external: preloadExternals,
      logLevel: "info",
    }),
  ]);
}

async function copyDashboardClient(): Promise<void> {
  console.log("[desktop:build] Copying dashboard client into desktop dist/client...");
  await cp(dashboardClientDir, desktopClientDistDir, { recursive: true });
}

async function main(): Promise<void> {
  await rm(desktopDistDir, { recursive: true, force: true });
  await mkdir(desktopDistDir, { recursive: true });

  await ensureDashboardBuild();
  await buildElectronEntrypoints();
  await copyDashboardClient();

  console.log("[desktop:build] Desktop build complete");
}

void main().catch((error) => {
  console.error("[desktop:build] Build failed", error);
  process.exitCode = 1;
});
