import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { TaskStore } from "@fusion/core";
import { createServer } from "@fusion/dashboard";

const require = createRequire(import.meta.url);

export interface RunDesktopOptions {
  dev?: boolean;
  paused?: boolean;
  interactive?: boolean;
}

interface DashboardRuntime {
  store: TaskStore;
  server: import("node:http").Server;
  port: number;
}

function runCommand(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", (error) => reject(error));
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`));
    });
  });
}

async function buildDesktopArtifacts(rootDir: string): Promise<void> {
  await runCommand("pnpm", ["--filter", "@fusion/desktop", "build"], rootDir);
}

async function startDashboardRuntime(rootDir: string, paused: boolean): Promise<DashboardRuntime> {
  const store = new TaskStore(rootDir);
  await store.init();
  await store.watch();

  if (paused) {
    await store.updateSettings({ enginePaused: true });
  }

  const app = createServer(store);
  const server = app.listen(0);

  try {
    await Promise.race([
      once(server, "listening"),
      once(server, "error").then(([error]) => {
        throw error;
      }),
    ]);
  } catch (error) {
    store.close();
    throw error;
  }

  const address = server.address() as AddressInfo | null;
  if (!address?.port) {
    server.close();
    store.close();
    throw new Error("Failed to determine dashboard server port");
  }

  return {
    store,
    server,
    port: address.port,
  };
}

async function closeDashboardRuntime(runtime: DashboardRuntime): Promise<void> {
  await new Promise<void>((resolve) => {
    runtime.server.close(() => resolve());
  });
  runtime.store.close();
}

function resolveElectronBinary(): string {
  if (process.env.FUSION_ELECTRON_BINARY) {
    return process.env.FUSION_ELECTRON_BINARY;
  }

  return require("electron") as string;
}

function terminateProcess(child: ChildProcess | null, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!child || child.killed) {
    return;
  }

  child.kill(signal);
}

export async function runDesktop(options: RunDesktopOptions = {}): Promise<void> {
  const rootDir = process.cwd();

  if (!options.dev) {
    await buildDesktopArtifacts(rootDir);
  }

  const runtime = await startDashboardRuntime(rootDir, Boolean(options.paused));
  const rendererUrl = options.dev
    ? process.env.FUSION_DASHBOARD_URL ?? "http://localhost:5173"
    : `http://localhost:${runtime.port}`;

  const electronBinary = resolveElectronBinary();
  const desktopEntry = join(rootDir, "packages", "desktop", "dist", "main.js");
  const electronArgs = ["--enable-source-maps", desktopEntry, ...(options.dev ? ["--dev"] : [])];

  const electronProcess = spawn(electronBinary, electronArgs, {
    cwd: rootDir,
    stdio: "inherit",
    env: {
      ...process.env,
      FUSION_DASHBOARD_URL: rendererUrl,
      FUSION_SERVER_PORT: String(runtime.port),
      ...(options.dev ? { NODE_ENV: "development" } : {}),
    },
  });

  let isShuttingDown = false;

  const shutdown = async (exitCode: number): Promise<void> => {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;

    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);

    terminateProcess(electronProcess);
    await closeDashboardRuntime(runtime);
    process.exit(exitCode);
  };

  const onSigint = () => {
    void shutdown(0);
  };

  const onSigterm = () => {
    void shutdown(0);
  };

  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  electronProcess.on("error", (error) => {
    console.error(`Failed to launch Electron: ${(error as Error).message}`);
    void shutdown(1);
  });

  electronProcess.on("exit", (code) => {
    void shutdown(code ?? 0);
  });
}
