import { build } from "esbuild";
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { buildCore, buildDashboard, buildDashboardClient, buildEngine, desktopDeployDir, packageRoot, stageDesktopDeploy, workspaceRoot } from "./workspace-tools";
const dashboardRoot = join(workspaceRoot, "packages", "dashboard");
const dashboardClientDir = join(dashboardRoot, "dist", "client");
const dashboardRegistryManifestSource = join(dashboardRoot, "src", "registry-manifest.json");
const dashboardRegistryManifestDist = join(dashboardRoot, "dist", "registry-manifest.json");
const desktopDistDir = join(packageRoot, "dist");
const desktopClientDistDir = join(desktopDistDir, "client");
// FNXC:DesktopBuild 2026-06-25-09:45:
// Every workspace @fusion/* package and native (.node) module must stay external
// to the Electron main/preload bundles — they resolve from node_modules at runtime.
// @fusion/engine was missing here, so esbuild followed local-runtime.ts's dynamic
// `import("@fusion/engine")` and tried to bundle engine's transitive node-pty
// (@homebridge/node-pty-prebuilt-multiarch) native binaries, failing with
// "No loader is configured for .node files" and breaking every desktop release build.
const sharedExternals = [
  "electron",
  "@fusion/core",
  "@fusion/dashboard",
  "@fusion/engine",
  "better-sqlite3",
];
const mainExternals = sharedExternals;
const preloadExternals = sharedExternals;

async function ensureDashboardBuild(): Promise<void> {
  // FNXC:DesktopBuild 2026-07-01-11:35:
  // Windows release packaging invokes only `@fusion/desktop build` before electron-builder.
  // Build the dashboard server dist and copy registry-manifest.json here so the packaged
  // embedded runtime never depends on a separate `@fusion/dashboard build` workflow step.
  console.log("[desktop:build] Building dashboard server runtime...");
  await buildDashboard();
  await cp(dashboardRegistryManifestSource, dashboardRegistryManifestDist);

  console.log("[desktop:build] Building dashboard client for file:// desktop loading...");
  await buildDashboardClient();

  try {
    await stat(dashboardClientDir);
  } catch {
    throw new Error(`Dashboard client assets not found: ${dashboardClientDir}`);
  }

  try {
    await stat(dashboardRegistryManifestDist);
  } catch {
    throw new Error(`Dashboard registry manifest not found: ${dashboardRegistryManifestDist}`);
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
      // FNXC:DesktopBuild 2026-07-01-07:31:
      // Windows Electron main output is ESM, but electron-updater loads CJS deps
      // such as fs-extra/graceful-fs that dynamically require built-ins. Keep all
      // npm packages external so Node/Electron evaluates those CJS modules natively
      // instead of esbuild emitting a __require("fs") trap in dist/main.js.
      packages: "external",
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

// FNXC:DesktopBuild 2026-07-01-19:45:
// Compile the workspace @fusion/* packages the embedded "Local" runtime imports
// at runtime (@fusion/core, @fusion/engine) so `@fusion/desktop build` alone
// produces a complete, packageable tree — no separate root `pnpm build` required.
// engine/dist and core/dist are tsc-emitted + gitignored; without this the
// desktop-windows.yml workflow_dispatch build shipped an empty engine/dist and
// the packaged app crashed on Local mode with ERR_MODULE_NOT_FOUND for
// ...app.asar/node_modules/@fusion/engine. Core must build before engine
// (engine depends on @fusion/core). Dashboard + its runtime plugins + plugin-sdk
// are already built by ensureDashboardBuild().
async function ensureEmbeddedRuntimeBuild(): Promise<void> {
  console.log("[desktop:build] Building @fusion/core and @fusion/engine runtime dist...");
  await buildCore();
  await buildEngine();
}

// FNXC:DesktopPackaging 2026-07-03-15:25:
// Guard the packaged Electron closure so a missing preload/main/renderer asset
// fails the build instead of shipping and crashing on a user's machine (field
// report Issue 5: preload was missing from the packaged unpacked layout).
// `preload.js` in particular is silent when absent — the contextBridge never
// installs window.fusionShell/fusionAPI and the app dead-ends on "can't reach
// the Fusion backend". Assert the required files in BOTH the source `dist/`
// (esbuild output) and the staged `deploy/dist/` (what electron-builder packs
// into app.asar), since only the latter reflects what ships.
const REQUIRED_PACKAGED_ASSETS = ["main.js", "preload.js", join("client", "index.html")];

async function verifyPackagedArtifacts(): Promise<void> {
  console.log("[desktop:build] Verifying required packaged assets are present...");
  const stagedDistDir = join(desktopDeployDir, "dist");
  const roots: Array<{ label: string; dir: string }> = [
    { label: "dist", dir: desktopDistDir },
    { label: "deploy/dist", dir: stagedDistDir },
  ];
  const missing: string[] = [];
  for (const { label, dir } of roots) {
    for (const asset of REQUIRED_PACKAGED_ASSETS) {
      try {
        await stat(join(dir, asset));
      } catch {
        missing.push(`${label}/${asset}`);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Desktop packaging is missing required Electron assets: ${missing.join(", ")}. ` +
        `Refusing to ship an incomplete app.asar.`,
    );
  }
}

async function main(): Promise<void> {
  await rm(desktopDistDir, { recursive: true, force: true });
  await mkdir(desktopDistDir, { recursive: true });

  await ensureEmbeddedRuntimeBuild();
  await ensureDashboardBuild();
  await buildElectronEntrypoints();
  await copyDashboardClient();

  // FNXC:DesktopPackaging 2026-07-01-21:15:
  // Stage the complete flat production closure last (after all dist exists) so
  // electron-builder can package it via --projectDir instead of its pnpm collector,
  // which drops `deduped` subtrees and left the embedded runtime missing deps.
  await stageDesktopDeploy();

  await verifyPackagedArtifacts();

  console.log("[desktop:build] Desktop build complete");
}

void main().catch((error) => {
  console.error("[desktop:build] Build failed", error);
  process.exitCode = 1;
});
