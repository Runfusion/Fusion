import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { CentralCore, TaskStore } from "@fusion/core";
import { createServer } from "@fusion/dashboard";
import { ProjectEngineManager } from "@fusion/engine";
import { ensureCwdProjectRegistered } from "./ensure-project-registered.js";

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
  engineManager?: ProjectEngineManager;
  centralCore?: CentralCore;
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
  let server: import("node:http").Server | null = null;
  let engineManager: ProjectEngineManager | undefined;
  let centralCore: CentralCore | undefined;
  try {
    await store.init();
    await store.watch();

    if (paused) {
      await store.updateSettings({ enginePaused: true });
    }

    /*
     * FNXC:DesktopRuntime 2026-06-20-23:39:
     * Desktop local mode must start the same project engine lifecycle as CLI dashboard mode; a desktop window without engines leaves users with a live dashboard that cannot execute tasks.
     */
    centralCore = new CentralCore();
    await centralCore.init();
    const cwdRegistered = await ensureCwdProjectRegistered({
      cwd: rootDir,
      central: centralCore,
      logPrefix: "desktop",
      autoRegister: true,
    });
    engineManager = new ProjectEngineManager(centralCore);
    await engineManager.startAll();
    engineManager.startReconciliation();
    const cwdEngine = cwdRegistered
      ? await engineManager.ensureEngine(cwdRegistered.id).catch((err) => {
          console.warn(`[desktop] Failed to warm cwd project engine: ${err instanceof Error ? err.message : String(err)}`);
          return undefined;
        })
      : undefined;

    const app = createServer(store, {
      engine: cwdEngine,
      engineManager,
      centralCore,
      onProjectFirstAccessed: (projectId: string) => engineManager?.onProjectAccessed(projectId),
    });
    server = app.listen(0);

    await Promise.race([
      once(server, "listening"),
      once(server, "error").then(([error]) => {
        throw error;
      }),
    ]);
    const address = server.address() as AddressInfo | null;
    if (!address?.port) {
      throw new Error("Failed to determine dashboard server port");
    }

    return {
      store,
      server,
      port: address.port,
      engineManager,
      centralCore,
    };
  } catch (error) {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    await engineManager?.stopAll().catch(() => undefined);
    await centralCore?.close?.().catch(() => undefined);
    store.close();
    throw error;
  }
}

async function closeDashboardRuntime(runtime: DashboardRuntime): Promise<void> {
  await new Promise<void>((resolve) => {
    runtime.server.close(() => resolve());
  });
  await runtime.engineManager?.stopAll().catch(() => undefined);
  await runtime.centralCore?.close?.().catch(() => undefined);
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

  const electronBinary = resolveElectronBinary();
  const desktopEntry = join(rootDir, "packages", "desktop", "dist", "main.js");
  const electronArgs = ["--enable-source-maps", desktopEntry, ...(options.dev ? ["--dev"] : [])];

  // Build environment for Electron process
  const electronEnv: NodeJS.ProcessEnv = {
    ...process.env,
    FUSION_SERVER_PORT: String(runtime.port),
  };

  // In dev mode, set FUSION_DASHBOARD_URL to the dashboard runtime URL
  // In production mode, renderer uses embedded assets (no FUSION_DASHBOARD_URL needed)
  if (options.dev) {
    electronEnv.FUSION_DASHBOARD_URL = process.env.FUSION_DASHBOARD_URL ?? "http://localhost:5173";
    electronEnv.NODE_ENV = "development";
  }

  const electronProcess = spawn(electronBinary, electronArgs, {
    cwd: rootDir,
    stdio: "inherit",
    env: electronEnv,
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
