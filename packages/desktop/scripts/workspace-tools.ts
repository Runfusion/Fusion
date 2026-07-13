import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const packageRoot = resolve(__dirname, "..");
export const workspaceRoot = resolve(packageRoot, "..", "..");

function resolveBin(command: string, cwd: string): string {
  const suffix = process.platform === "win32" ? ".cmd" : "";
  const localBin = resolve(cwd, "node_modules", ".bin", `${command}${suffix}`);
  if (existsSync(localBin)) {
    return localBin;
  }

  return resolve(workspaceRoot, "node_modules", ".bin", `${command}${suffix}`);
}

export function runWorkspaceBin(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(resolveBin(command, cwd), args, {
      cwd,
      stdio: "inherit",
      env: process.env,
      // On Windows the resolved bin is a .cmd shim; Node refuses to spawn
      // .cmd/.bat without a shell (EINVAL) since CVE-2024-27980. resolveBin
      // produces an absolute, space-free path, so shell quoting is safe here.
      shell: process.platform === "win32",
    });

    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      rejectPromise(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`));
    });
  });
}

export async function buildCore(): Promise<void> {
  await runWorkspaceBin("tsc", [], resolve(workspaceRoot, "packages", "core"));
}

// FNXC:DesktopBuild 2026-07-01-19:45:
// The packaged desktop "Local" runtime dynamically imports @fusion/engine
// (local-runtime.ts createDashboardServerDefault). Engine's runtime code is
// tsc-emitted into packages/engine/dist and gitignored, so a workflow that runs
// only `@fusion/desktop build` (e.g. desktop-windows.yml, which lacked the root
// `pnpm build`) shipped an empty engine/dist. The packaged app then crashed on
// Local mode with `ERR_MODULE_NOT_FOUND ...app.asar/node_modules/@fusion/engine`.
// Engine depends on @fusion/core, so callers must build core first.
export async function buildEngine(): Promise<void> {
  await runWorkspaceBin("tsc", [], resolve(workspaceRoot, "packages", "engine"));
}

async function buildPackage(relativePath: string): Promise<void> {
  await runWorkspaceBin("tsc", [], resolve(workspaceRoot, relativePath));
}

// FNXC:DesktopBuild 2026-07-01-21:10:
// Every example plugin whose compiled entry the dashboard SERVER statically
// imports must have dist built, because the packaged desktop runs the dashboard
// under plain Node (Electron main) which cannot load a plugin's `.ts` source.
// The plugins' `import` export condition points at ./dist/*.js (with a `source`
// condition kept for the bun-compiled CLI), so a missing dist => the packaged
// app crashes on Local mode when @fusion/dashboard imports the plugin.
// routes.ts / runtime-provider-probes.ts / droid-cli-probe.ts / roadmap-routes.ts
// pull hermes, openclaw, paperclip, cursor, grok, droid and roadmap; dependency-graph
// backs a dashboard view. Keep this list in sync with dashboard's static plugin imports.
export async function buildDashboardRuntimePlugins(): Promise<void> {
  await buildPackage("packages/plugin-sdk");
  await Promise.all([
    buildPackage("plugins/fusion-plugin-dependency-graph"),
    buildPackage("plugins/fusion-plugin-hermes-runtime"),
    buildPackage("plugins/fusion-plugin-openclaw-runtime"),
    buildPackage("plugins/fusion-plugin-paperclip-runtime"),
    buildPackage("plugins/fusion-plugin-cursor-runtime"),
    buildPackage("plugins/fusion-plugin-grok-runtime"),
    buildPackage("plugins/fusion-plugin-droid-runtime"),
    buildPackage("plugins/fusion-plugin-roadmap"),
  ]);
}

export async function buildDashboard(): Promise<void> {
  const dashboardRoot = resolve(workspaceRoot, "packages", "dashboard");
  await buildDashboardRuntimePlugins();
  await runWorkspaceBin("vite", ["build"], dashboardRoot);
  await runWorkspaceBin("tsc", [], dashboardRoot);
  // FNXC:DesktopBuild 2026-07-01-11:45:
  // Desktop release and test paths call this helper directly instead of the dashboard package script, so copy the Node-read registry manifest beside server dist here as the shared build invariant.
  await cp(resolve(dashboardRoot, "src", "registry-manifest.json"), resolve(dashboardRoot, "dist", "registry-manifest.json"));
}

function runPnpm(args: string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("pnpm", args, {
      cwd,
      stdio: "inherit",
      env: process.env,
      // pnpm resolves to a .cmd shim on Windows; Node refuses to spawn it without a shell.
      shell: process.platform === "win32",
    });
    child.on("error", rejectPromise);
    child.on("exit", (code) =>
      code === 0 ? resolvePromise() : rejectPromise(new Error(`pnpm ${args.join(" ")} exited with code ${code ?? "unknown"}`)),
    );
  });
}

/*
FNXC:DesktopPackaging 2026-07-01-21:15:
Durable fix for the packaged desktop app missing runtime dependencies.
electron-builder's pnpm support runs `pnpm list --prod` and silently drops
`deduped` subtrees, so the embedded Local runtime's `import("@fusion/engine")`
closure (@modelcontextprotocol/sdk, the pi-ai provider SDKs, etc.) was never
packed and the app crashed with ERR_MODULE_NOT_FOUND. Instead of relying on that
collector, materialize the complete production closure with `pnpm deploy`
(legacy + hoisted => a real flat node_modules that pnpm resolves correctly) and
point electron-builder at that staged directory via --projectDir.

- --prod drops devDependencies (electron itself), so copy electron's package.json
  into the stage so electron-builder can still compute the version (it downloads
  the runtime separately).
- Rewrite the staged electron-builder.yml output to ../dist-electron so artifacts
  still land in packages/desktop/dist-electron for the existing workflow globs.
- The stage has no pnpm-lock, so electron-builder treats it as a plain flat
  project and packs the whole node_modules — no dedup gap.
*/
/*
 * FNXC:DesktopBuild 2026-07-03-10:20:
 * `pnpm deploy` materializes the flat production closure by renaming a temp dir into place. On some
 * Windows filesystems (notably the orca-managed workspace mount used for local dev) that final rename
 * hits EPERM and also litters deeply-nested deploy_tmp_* dirs that are painful to remove. Allow
 * redirecting the staged deploy to an external, plain-NTFS path via FUSION_DESKTOP_DEPLOY_DIR so local
 * Windows installer builds can sidestep the race; CI and the default path are unchanged.
 */
export const desktopDeployDir = process.env.FUSION_DESKTOP_DEPLOY_DIR
  ? resolve(process.env.FUSION_DESKTOP_DEPLOY_DIR)
  : resolve(packageRoot, "deploy");

export async function stageDesktopDeploy(): Promise<void> {
  console.log("[desktop:build] Staging complete production closure via pnpm deploy...");
  await rm(desktopDeployDir, { recursive: true, force: true });
  await runPnpm(
    ["--filter", "@fusion/desktop", "deploy", "--prod", "--legacy", "--config.node-linker=hoisted", desktopDeployDir],
    workspaceRoot,
  );

  // electron-builder needs electron's version; --prod pruned the devDependency.
  const electronPkg = resolve(packageRoot, "node_modules", "electron", "package.json");
  const stagedElectronDir = resolve(desktopDeployDir, "node_modules", "electron");
  await mkdir(stagedElectronDir, { recursive: true });
  await cp(electronPkg, resolve(stagedElectronDir, "package.json"));

  // Keep artifacts in packages/desktop/dist-electron for the existing workflow globs.
  const stagedConfig = resolve(desktopDeployDir, "electron-builder.yml");
  const config = await readFile(stagedConfig, "utf8");
  const patched = /output:\s*dist-electron/.test(config)
    ? config.replace(/output:\s*dist-electron/, "output: ../dist-electron")
    : `directories:\n  output: ../dist-electron\n${config}`;
  await writeFile(stagedConfig, patched);
  console.log(`[desktop:build] Deploy staged at ${desktopDeployDir}`);
}

export async function buildDashboardClient(): Promise<void> {
  // FNXC:DesktopBuild 2026-07-13-12:15:
  // Clean the dashboard client output directory before building. Vite generates
  // content-hashed chunk filenames; if a previous build left stale assets, the
  // rollup write queue can hit ENOENT on stale-hashed paths. A clean outDir
  // ensures the new build owns all filenames deterministically.
  const clientDir = resolve(workspaceRoot, "packages", "dashboard", "dist", "client");
  await rm(clientDir, { recursive: true, force: true });

  // Desktop loads index.html via file:// from inside the asar, so absolute
  // asset paths (/assets/...) resolve to the filesystem root and fail. Build
  // with a relative base so the bundled HTML references ./assets/... instead.
  await runWorkspaceBin("vite", ["build", "--base", "./"], resolve(workspaceRoot, "packages", "dashboard"));
}
