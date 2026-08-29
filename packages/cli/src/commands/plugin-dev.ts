import { existsSync, watch } from "node:fs";
import { join, resolve } from "node:path";
import { superviseSpawn } from "@fusion/core";
import {
  createPluginLoader,
  createPluginStore,
  loadManifestFromPath,
  resolvePluginEntryFile,
} from "./plugin.js";

interface DevWatchHandle {
  close: () => void;
}

export interface RunPluginDevOptions {
  projectName?: string;
  once?: boolean;
  aiScan?: boolean;
  buildFn?: (dir: string) => Promise<void>;
  watchFn?: (dir: string, onChange: () => void) => DevWatchHandle;
}

async function runSupervisedCommand(command: string, cwd: string, timeoutMs = 120_000): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = superviseSpawn(command, [], {
      cwd,
      shell: true,
      stdio: "inherit",
      env: process.env,
      maxLifetimeMs: timeoutMs + 10_000,
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      rejectPromise(new Error(`Command timed out: ${command}`));
    }, timeoutMs);
    timer.unref();

    child.child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });

    child.waitExit().then((result) => {
      clearTimeout(timer);
      if (result.code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`Command failed (${result.code ?? "signal"}): ${command}`));
    }).catch((error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
  });
}

async function defaultBuildFn(pluginDir: string): Promise<void> {
  try {
    await runSupervisedCommand("pnpm build", pluginDir);
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("pnpm build")) {
      throw error;
    }
  }
  await runSupervisedCommand("npm run build", pluginDir);
}

function defaultWatchFn(pluginDir: string, onChange: () => void): DevWatchHandle {
  const watchPath = existsSync(join(pluginDir, "src")) ? join(pluginDir, "src") : pluginDir;
  try {
    const watcher = watch(watchPath, { recursive: true }, onChange);
    return { close: () => watcher.close() };
  } catch {
    const watcher = watch(watchPath, onChange);
    return { close: () => watcher.close() };
  }
}

function shouldUseWatcher(options?: RunPluginDevOptions): boolean {
  if (options?.once) return false;
  if (options?.watchFn) return true;
  if (process.env.NODE_ENV === "test") return false;
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

export async function runPluginDev(source: string, options?: RunPluginDevOptions): Promise<void> {
  if (!existsSync(source)) {
    console.error(`Plugin path does not exist: ${source}`);
    process.exit(1);
  }

  const pluginDir = resolve(source);
  const buildFn = options?.buildFn ?? defaultBuildFn;
  const watchFn = options?.watchFn ?? defaultWatchFn;

  const { store, loader } = await createPluginLoader(
    await createPluginStore(options?.projectName),
    options?.projectName,
  );

  let pluginId: string | undefined;
  let watcher: DevWatchHandle | undefined;
  let closed = false;
  let debounceTimer: NodeJS.Timeout | undefined;
  let rebuilding = false;
  let queued = false;

  const installOrReload = async (reloadOnly = false): Promise<void> => {
    await buildFn(pluginDir);

    const entryPath = await resolvePluginEntryFile(pluginDir);
    const { manifest } = await loadManifestFromPath(pluginDir);

    if (!pluginId || !reloadOnly) {
      const plugin = await store.registerPlugin({
        manifest,
        path: entryPath,
        aiScanOnLoad: options?.aiScan ?? false,
      });
      pluginId = plugin.id;

      if (plugin.enabled) {
        await loader.loadPlugin(plugin.id);
      }
      return;
    }

    await loader.reloadPlugin(pluginId);
  };

  const onChange = (): void => {
    if (closed || !pluginId) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      void (async () => {
        if (rebuilding) {
          queued = true;
          return;
        }

        rebuilding = true;
        try {
          await installOrReload(true);
          console.log(`  ✓ Reloaded plugin ${pluginId}`);
        } catch (error) {
          console.error(`  ⚠ Reload failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          rebuilding = false;
          if (queued) {
            queued = false;
            onChange();
          }
        }
      })();
    }, 120);
    debounceTimer.unref();
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
    watcher?.close();
    if (pluginId) {
      try {
        await loader.stopPlugin(pluginId);
      } catch {
        // Ignore teardown errors.
      }
    }
  };

  const sigintHandler = () => {
    void close().finally(() => process.exit(0));
  };

  process.once("SIGINT", sigintHandler);

  try {
    await installOrReload(false);
    if (!pluginId) {
      throw new Error("Failed to install plugin");
    }

    console.log(`  ✓ Built and loaded plugin ${pluginId}`);

    if (!shouldUseWatcher(options)) {
      return;
    }

    watcher = watchFn(pluginDir, onChange);
    await new Promise<void>((resolvePromise) => {
      const finish = () => {
        process.off("SIGINT", finish);
        resolvePromise();
      };
      process.on("SIGINT", finish);
    });
  } catch (error) {
    console.error(`  Failed to run plugin dev loop: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  } finally {
    process.off("SIGINT", sigintHandler);
    await close();
  }
}
