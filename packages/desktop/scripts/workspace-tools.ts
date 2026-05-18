import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
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

export async function buildDashboard(): Promise<void> {
  const dashboardRoot = resolve(workspaceRoot, "packages", "dashboard");
  await runWorkspaceBin("vite", ["build"], dashboardRoot);
  await runWorkspaceBin("tsc", [], dashboardRoot);
}

export async function buildDashboardClient(): Promise<void> {
  // Desktop loads index.html via file:// from inside the asar, so absolute
  // asset paths (/assets/...) resolve to the filesystem root and fail. Build
  // with a relative base so the bundled HTML references ./assets/... instead.
  await runWorkspaceBin("vite", ["build", "--base", "./"], resolve(workspaceRoot, "packages", "dashboard"));
}
