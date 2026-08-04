import { watch as fsWatch } from "node:fs";
import { join } from "node:path";

export const DEFAULT_DEV_SOURCE_WATCH_PATHS = [
  "packages/core/src",
  "packages/engine/src",
  "packages/dashboard/src",
  "packages/cli/src",
];

const RUNTIME_SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?|json)$/i;
const NON_RUNTIME_SEGMENTS = new Set([
  "__fixtures__",
  "__generated__",
  "__tests__",
  "fixtures",
  "generated",
  "test",
  "tests",
]);

export function isRestartableSourceFile(filename) {
  if (filename === null || filename === undefined) return false;
  const normalized = String(filename).replaceAll("\\", "/");
  if (!normalized || !RUNTIME_SOURCE_EXTENSION.test(normalized)) return false;
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(normalized)) return false;
  if (/\.d\.[cm]?ts$/i.test(normalized)) return false;
  return !normalized.split("/").some((segment) => NON_RUNTIME_SEGMENTS.has(segment));
}

/**
 * FNXC:DevEngineWatch 2026-08-04-01:25:
 * Watch only source roots that execute inside the long-lived dashboard/engine
 * process. Tests, fixtures, generated declarations, build output, task state,
 * and worktrees must not create restart storms. The supervisor owns process
 * replacement; this helper only coalesces source events and reports paths.
 */
export function createDevSourceWatcher({
  rootDir,
  onRestart,
  watchPaths = DEFAULT_DEV_SOURCE_WATCH_PATHS,
  debounceMs = 350,
  maxWaitMs = 2_000,
  watch = fsWatch,
  logger = console,
}) {
  const watchers = [];
  const watchedPaths = [];
  const changedPaths = new Set();
  let debounceTimer;
  let firstChangeAt;
  let closed = false;

  const scheduleRestart = (watchPath, filename) => {
    if (closed || !isRestartableSourceFile(filename)) return;
    const normalized = String(filename).replaceAll("\\", "/");
    changedPaths.add(`${watchPath}/${normalized}`);
    firstChangeAt ??= Date.now();
    if (debounceTimer) clearTimeout(debounceTimer);
    const elapsedMs = Date.now() - firstChangeAt;
    const delayMs = Math.min(debounceMs, Math.max(0, maxWaitMs - elapsedMs));
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      firstChangeAt = undefined;
      const paths = [...changedPaths];
      changedPaths.clear();
      Promise.resolve(onRestart(paths)).catch((error) => {
        logger.warn(`[fusion:dev] source restart request failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, delayMs);
    debounceTimer.unref?.();
  };

  for (const watchPath of watchPaths) {
    const absolutePath = join(rootDir, watchPath);
    try {
      const watcher = watch(absolutePath, { recursive: true }, (_eventType, filename) => {
        scheduleRestart(watchPath, filename);
      });
      watcher.on?.("error", (error) => {
        logger.warn(`[fusion:dev] source watcher error for ${watchPath}: ${error instanceof Error ? error.message : String(error)}`);
      });
      watchers.push(watcher);
      watchedPaths.push(watchPath);
    } catch (error) {
      logger.warn(`[fusion:dev] could not watch ${watchPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    watchedPaths,
    close() {
      closed = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = undefined;
      firstChangeAt = undefined;
      changedPaths.clear();
      for (const watcher of watchers) {
        try {
          watcher.close();
        } catch (error) {
          logger.warn(`[fusion:dev] source watcher close failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
  };
}
