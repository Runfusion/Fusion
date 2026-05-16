import { build } from "esbuild";
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { buildDashboardClient, packageRoot, workspaceRoot } from "./workspace-tools";
const dashboardClientDir = join(workspaceRoot, "packages", "dashboard", "dist", "client");
const desktopDistDir = join(packageRoot, "dist");
const desktopClientDistDir = join(desktopDistDir, "client");
const sharedExternals = [
  "electron",
  "@fusion/core",
  "@fusion/dashboard",
  "better-sqlite3",
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
      format: "esm",
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
