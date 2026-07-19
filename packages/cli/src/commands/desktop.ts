import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import { CentralCore, PluginLoader, createTaskStoreForBackend, type TaskStore } from "@fusion/core";
import { createServer } from "@fusion/dashboard";
import { ProjectEngineManager } from "@fusion/engine";
import { ensureCwdProjectRegistered } from "./ensure-project-registered.js";

const require = createRequire(import.meta.url);
const cliModuleDir = dirname(fileURLToPath(import.meta.url));

export interface RunDesktopOptions {
  dev?: boolean;
  paused?: boolean;
  interactive?: boolean;
  noAuth?: boolean;
}

interface DashboardRuntime {
  store: TaskStore;
  server: import("node:http").Server;
  port: number;
  engineManager?: ProjectEngineManager;
  centralCore?: CentralCore;
  /** Releases the PostgreSQL backend pool / embedded cluster (backend mode only). */
  backendShutdown: () => Promise<void>;
}

async function startDashboardRuntime(rootDir: string, paused: boolean, noAuth: boolean): Promise<DashboardRuntime> {
  // FNXC:PostgresCutover 2026-07-04-00:00: boot the PostgreSQL backend via the startup
  // factory (embedded by default, external via DATABASE_URL), mirroring dashboard.ts.
  // FNXC:PostgresFinalCutover 2026-07-14-17:20: Desktop startup has no SQLite
  // fallback; an obsolete backend opt-out fails explicitly in the factory.
  const boot = await createTaskStoreForBackend({ rootDir });
  const backendShutdown = boot.shutdown;
  const store: TaskStore = boot.taskStore;
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

    /*
     * FNXC:PluginSubsystem 2026-07-08-00:00:
     * `fusion desktop` is a separate createServer(...) call site from the Electron
     * app's packages/desktop/src local runtime (same "desktop" name, different
     * package). It had the same gap: no PluginStore/PluginLoader passed in, so
     * plugin install and Browse registry failed here too. Mirror
     * packages/cli/src/commands/dashboard.ts's construction.
     */
    const pluginStore = store.getPluginStore();
    await pluginStore.init();
    const pluginLoader = new PluginLoader({ pluginStore, taskStore: store });

    const app = createServer(store, {
      engine: cwdEngine,
      engineManager,
      centralCore,
      pluginStore,
      pluginLoader,
      /*
      FNXC:GrokCliRouting 2026-07-15-10:17:
      Pass the warm engine PluginRunner when available — never the bare PluginLoader (lacks getRuntimeById).
      */
      pluginRunner: cwdEngine?.getPluginRunner?.(),
      /*
       * FNXC:DesktopLauncher 2026-07-01-20:19:
       * `fusion desktop --no-auth` is a compatibility flag for users who learned the dashboard launcher semantics. Propagate it to the embedded dashboard server explicitly so desktop routing never treats it as an unknown flag or falls back to source-workspace discovery.
       */
      noAuth,
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
      backendShutdown,
    };
  } catch (error) {
    try {
      if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    } finally {
      await engineManager?.stopAll().catch(() => undefined);
      await centralCore?.close?.().catch(() => undefined);
      /* FNXC:PostgresDesktopLifecycle 2026-07-14-19:10: The startup-factory shutdown is the sole TaskStore/pool/postmaster owner and must run even when earlier server, engine, or CentralCore cleanup fails. */
      await backendShutdown().catch(() => undefined);
    }
    throw error;
  }
}

async function closeDashboardRuntime(runtime: DashboardRuntime): Promise<void> {
  try {
    await new Promise<void>((resolve) => {
      runtime.server.close(() => resolve());
    });
  } finally {
    await runtime.engineManager?.stopAll().catch(() => undefined);
    await runtime.centralCore?.close?.().catch(() => undefined);
    await runtime.backendShutdown().catch(() => undefined);
  }
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

function resolveDevDesktopEntry(rootDir: string): string {
  const desktopEntry = join(rootDir, "packages", "desktop", "dist", "main.js");
  if (existsSync(desktopEntry)) {
    return desktopEntry;
  }

  throw new Error(
    `Fusion desktop dev entry is missing at ${desktopEntry}. Run \`pnpm --filter @fusion/desktop build\` from a Fusion source checkout before using \`fusion desktop --dev\`.`,
  );
}

function resolvePackagedDesktopEntry(): string {
  const override = process.env.FUSION_DESKTOP_ENTRY;
  if (override) {
    const resolvedOverride = isAbsolute(override) ? override : resolve(process.cwd(), override);
    if (existsSync(resolvedOverride)) {
      return resolvedOverride;
    }
    throw new Error(`Fusion desktop runtime override is missing: ${resolvedOverride}`);
  }

  const packagedEntry = resolve(cliModuleDir, "desktop", "main.js");
  if (existsSync(packagedEntry)) {
    return packagedEntry;
  }

  const sourceCheckoutEntry = resolve(cliModuleDir, "..", "..", "dist", "desktop", "main.js");
  if (existsSync(sourceCheckoutEntry)) {
    return sourceCheckoutEntry;
  }

  /*
   * FNXC:DesktopLauncher 2026-07-01-20:04:
   * Installed `fusion desktop` must never infer a source workspace from the caller's cwd or run pnpm there. When package assets are absent, fail with a Fusion-owned runtime diagnostic instead of letting unrelated package.json/template JSON parse errors gate startup. The bundled CLI entry lives in dist, so the packaged runtime is dist/desktop/main.js; the source-checkout fallback only supports tests and direct TS execution without inspecting the caller's workspace.
   */
  throw new Error(
    `Fusion desktop runtime asset is missing: ${packagedEntry}. Reinstall @runfusion/fusion or set FUSION_DESKTOP_ENTRY to a built Fusion desktop main.js.`,
  );
}

export async function runDesktop(options: RunDesktopOptions = {}): Promise<void> {
  const rootDir = process.cwd();
  const desktopEntry = options.dev ? resolveDevDesktopEntry(rootDir) : resolvePackagedDesktopEntry();

  const runtime = await startDashboardRuntime(rootDir, Boolean(options.paused), Boolean(options.noAuth));

  const electronBinary = resolveElectronBinary();

  /*
  FNXC:DesktopWindowsGpuFlags 2026-07-03-14:40:
  Windows Electron renderers observed blank/flickering GPU output and sandbox-related launch instability on some GPUs during the 0.52.0 desktop release (field report Issue 7). Disable GPU acceleration and the Chromium sandbox ONLY on Windows so macOS/Linux keep hardware acceleration and the security sandbox. Applying `--no-sandbox`/`--disable-gpu` on every platform would be a needless security and rendering regression off Windows.
  */
  const isWindows = os.platform() === "win32";
  const windowsGpuFlags = isWindows
    ? [
        "--disable-gpu",
        "--disable-gpu-compositing",
        "--disable-gpu-sandbox",
        "--disable-software-rasterizer",
        "--no-sandbox",
      ]
    : [];
  const electronArgs = [
    "--enable-source-maps",
    desktopEntry,
    ...windowsGpuFlags,
    ...(options.dev ? ["--dev"] : []),
  ];

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
