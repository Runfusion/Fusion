import { build } from "esbuild";
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..");
const workspaceRoot = resolve(packageRoot, "..", "..");
const dashboardClientDir = join(workspaceRoot, "packages", "dashboard", "dist", "client");
const desktopDistDir = join(packageRoot, "dist");
const desktopClientDistDir = join(desktopDistDir, "client");

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", (error) => {
      rejectPromise(error);
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      rejectPromise(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`));
    });
  });
}

async function ensureDashboardBuild(): Promise<void> {
  console.log("[desktop:build] Building dashboard client...");
  await run("pnpm", ["--filter", "@fusion/dashboard", "build:client"], workspaceRoot);

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
      packages: "external",
      external: ["electron"],
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
      external: ["electron"],
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
