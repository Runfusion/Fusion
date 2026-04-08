import { build } from "esbuild";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..");
const workspaceRoot = resolve(packageRoot, "..", "..");
const distDir = join(packageRoot, "dist");

const require = createRequire(import.meta.url);

const sleep = (ms: number): Promise<void> => new Promise((resolvePromise) => {
  setTimeout(resolvePromise, ms);
});

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): ChildProcess {
  return spawn(command, args, {
    cwd,
    env,
    stdio: "inherit",
  });
}

async function buildMainProcess(): Promise<void> {
  await mkdir(distDir, { recursive: true });

  await Promise.all([
    build({
      entryPoints: [join(packageRoot, "src", "main.ts")],
      outfile: join(distDir, "main.js"),
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
      outfile: join(distDir, "preload.js"),
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

function resolveDashboardUrl(): URL {
  const raw = process.env.FUSION_DASHBOARD_URL ?? "http://localhost:5173";
  const parsed = new URL(raw);

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`FUSION_DASHBOARD_URL must be http(s), received: ${raw}`);
  }

  return parsed;
}

async function waitForRenderer(url: string, timeoutMs: number = 60_000): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until timeout.
    }

    await sleep(500);
  }

  throw new Error(`Renderer dev server did not become ready at ${url} within ${timeoutMs}ms`);
}

async function main(): Promise<void> {
  console.log("[desktop:dev] Building main/preload entrypoints...");
  await buildMainProcess();

  const dashboardUrl = resolveDashboardUrl();
  const dashboardHost = dashboardUrl.hostname;
  const dashboardPort = dashboardUrl.port || (dashboardUrl.protocol === "https:" ? "443" : "80");

  console.log(`[desktop:dev] Starting dashboard Vite dev server on ${dashboardUrl.origin}...`);
  const viteProcess = run(
    "pnpm",
    [
      "--filter",
      "@fusion/dashboard",
      "dev:serve",
      "--host",
      dashboardHost,
      "--port",
      dashboardPort,
      "--strictPort",
    ],
    workspaceRoot,
  );

  let isShuttingDown = false;
  let electronProcess: ChildProcess | null = null;

  const shutdown = (code: number): void => {
    if (isShuttingDown) {
      return;
    }

    isShuttingDown = true;

    if (electronProcess && !electronProcess.killed) {
      electronProcess.kill("SIGTERM");
    }

    if (!viteProcess.killed) {
      viteProcess.kill("SIGTERM");
    }

    setTimeout(() => {
      if (electronProcess && !electronProcess.killed) {
        electronProcess.kill("SIGKILL");
      }
      if (!viteProcess.killed) {
        viteProcess.kill("SIGKILL");
      }
      process.exit(code);
    }, 200);
  };

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  viteProcess.on("exit", (code) => {
    if (!isShuttingDown) {
      const exitCode = code ?? 1;
      console.error(`[desktop:dev] Dashboard dev server exited early with code ${exitCode}`);
      shutdown(exitCode);
    }
  });

  await waitForRenderer(dashboardUrl.toString());
  console.log("[desktop:dev] Renderer dev server ready. Launching Electron...");

  const electronBinary = require("electron") as string;
  electronProcess = run(
    electronBinary,
    ["--enable-source-maps", join(distDir, "main.js"), "--dev"],
    packageRoot,
    {
      ...process.env,
      NODE_ENV: "development",
      FUSION_DASHBOARD_URL: dashboardUrl.toString(),
    },
  );

  electronProcess.on("exit", (code) => {
    shutdown(code ?? 0);
  });
}

void main().catch((error) => {
  console.error("[desktop:dev] Failed to start development workflow", error);
  process.exit(1);
});
