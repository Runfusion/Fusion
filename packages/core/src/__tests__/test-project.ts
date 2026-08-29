import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { TaskStore } from "../store.js";
import {
  GLOBAL_SETTINGS_KEYS,
  type GlobalSettings,
  type Settings,
  type Task,
} from "../types.js";

export interface CreateTestProjectOptions {
  seedTasks?: number;
  globalSettingsDir?: string;
  settings?: Partial<Settings>;
  rootDirPrefix?: string;
  globalDirPrefix?: string;
}

export interface TestProjectFixture {
  rootDir: string;
  store: TaskStore;
  globalDir: string;
  cleanup: () => Promise<void>;
}

const TEST_PROJECT_RM_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 50,
} as const;
const TRACKED_TEST_PROJECT_DIRS = new Set<string>();
const TEST_PROJECT_CLEANUP_HOOK_KEY = Symbol.for("fusion.core.test-project.cleanup-hooks-installed");

function assertAbsolutePath(pathValue: string, label: string): void {
  if (!isAbsolute(pathValue)) {
    throw new Error(`${label} must be an absolute path`);
  }
}

function isGlobalSettingsKey(key: string): key is keyof GlobalSettings {
  return (GLOBAL_SETTINGS_KEYS as readonly string[]).includes(key);
}

function splitSettings(settings?: Partial<Settings>): {
  globalPatch: Partial<GlobalSettings>;
  projectPatch: Partial<Settings>;
} {
  const globalPatch: Partial<GlobalSettings> = {};
  const projectPatch: Partial<Settings> = {};

  for (const [key, value] of Object.entries(settings ?? {})) {
    if (isGlobalSettingsKey(key)) {
      (globalPatch as Record<string, unknown>)[key] = value;
      continue;
    }

    (projectPatch as Record<string, unknown>)[key] = value;
  }

  return { globalPatch, projectPatch };
}

/**
 * NOTE: Global test isolation overrides HOME in vitest setupFiles,
 * so homedir()/resolveGlobalDir() always resolve to temp directories.
 * This file provides per-fixture isolation on top of that safety net.
 *
 * Create an isolated temporary test project with a real TaskStore + SQLite DB.
 *
 * Note: we always pass an explicit `globalDir` into TaskStore so tests never
 * hit `resolveGlobalDir()`'s VITEST guard or write to a real ~/.fusion path.
 */
export async function createTestProject(
  options: CreateTestProjectOptions = {},
): Promise<TestProjectFixture> {
  const rootDirPrefix = options.rootDirPrefix ?? "fusion-test-project-";
  const globalDirPrefix = options.globalDirPrefix ?? "fusion-test-global-";
  const rootDir = mkdtempSync(join(tmpdir(), rootDirPrefix));
  const globalDir = options.globalSettingsDir
    ? options.globalSettingsDir
    : mkdtempSync(join(tmpdir(), globalDirPrefix));
  const ownsGlobalDir = !options.globalSettingsDir;

  assertAbsolutePath(rootDir, "rootDir");
  assertAbsolutePath(globalDir, "globalSettingsDir");

  TRACKED_TEST_PROJECT_DIRS.add(rootDir);
  if (ownsGlobalDir) {
    TRACKED_TEST_PROJECT_DIRS.add(globalDir);
  }

  let store: TaskStore | undefined;

  try {
    await mkdir(globalDir, { recursive: true });

    store = new TaskStore(rootDir, globalDir);
    await store.init();

    const { globalPatch, projectPatch } = splitSettings(options.settings);
    if (Object.keys(projectPatch).length > 0) {
      await store.updateSettings(projectPatch);
    }

    if (Object.keys(globalPatch).length > 0) {
      await store.updateGlobalSettings(globalPatch);
    }

    const requestedSeedCount = Math.max(0, Math.floor(options.seedTasks ?? 0));
    if (requestedSeedCount > 0) {
      await seedTasks(store, requestedSeedCount);
    }

    const initializedStore = store;
    const cleanup = async () => {
      initializedStore.close();
      await destroyTestProject(rootDir);

      if (ownsGlobalDir) {
        await destroyTestProject(globalDir);
      }
    };

    return { rootDir, store: initializedStore, globalDir, cleanup };
  } catch (error) {
    store?.close();
    await destroyTestProject(rootDir);

    if (ownsGlobalDir) {
      await destroyTestProject(globalDir);
    }

    throw error;
  }
}

/**
 * Seed a TaskStore with realistic sample tasks in varied columns.
 */
export async function seedTasks(store: TaskStore, count = 3): Promise<Task[]> {
  const templates = [
    {
      title: "Stabilize webhook retries",
      description:
        "Ensure webhook delivery retries are tracked and surfaced in diagnostics.",
      finalColumn: "todo" as const,
    },
    {
      title: "Backfill mission metrics",
      description:
        "Calculate missing mission rollup metrics and persist migration-safe defaults.",
      finalColumn: "in-progress" as const,
    },
    {
      title: "Validate PR badge freshness",
      description:
        "Confirm websocket badge snapshots never override newer REST refresh responses.",
      finalColumn: "in-review" as const,
    },
    {
      title: "Draft follow-up triage",
      description:
        "Collect edge cases discovered during rollout and capture them in triage.",
      finalColumn: "triage" as const,
    },
  ];

  const seeded: Task[] = [];
  const total = Math.max(0, Math.floor(count));

  for (let i = 0; i < total; i++) {
    const template = templates[i % templates.length];
    const dependency = seeded.length > 0 && i % 2 === 1 ? [seeded[seeded.length - 1].id] : [];

    const created = await store.createTask({
      title: `${template.title} ${i + 1}`,
      description: `${template.description} [seed-${i + 1}]`,
      column: "todo",
      dependencies: dependency,
    });

    // Force step hydration from PROMPT.md into persisted task metadata.
    await store.updateStep(created.id, 0, "in-progress");

    const targetColumn = template.finalColumn;
    if (targetColumn === "in-progress" || targetColumn === "in-review") {
      await store.moveTask(created.id, "in-progress");
    }
    if (targetColumn === "in-review") {
      await store.moveTask(created.id, "in-review");
    }
    if (targetColumn === "triage") {
      await store.moveTask(created.id, "triage");
    }

    await store.updateTask(created.id, {
      size: i % 3 === 0 ? "S" : i % 3 === 1 ? "M" : "L",
      reviewLevel: i % 4,
    });

    seeded.push(await store.getTask(created.id));
  }

  return seeded;
}

/**
 * Remove an entire test project directory recursively.
 */
export async function destroyTestProject(dir: string): Promise<void> {
  assertAbsolutePath(dir, "dir");
  try {
    await rm(dir, TEST_PROJECT_RM_OPTIONS);
  } catch {
    try {
      rmSync(dir, TEST_PROJECT_RM_OPTIONS);
    } catch {
      // best-effort fallback during teardown
    }
  } finally {
    TRACKED_TEST_PROJECT_DIRS.delete(dir);
  }
}

function cleanupTrackedTestProjectDirsSync(): void {
  const cleanup = Array.from(TRACKED_TEST_PROJECT_DIRS);
  for (const dir of cleanup) {
    try {
      rmSync(dir, TEST_PROJECT_RM_OPTIONS);
    } catch {
      // best-effort fallback during process teardown
    } finally {
      TRACKED_TEST_PROJECT_DIRS.delete(dir);
    }
  }
}

const processWithCleanupFlag = process as typeof process & {
  [TEST_PROJECT_CLEANUP_HOOK_KEY]?: boolean;
};
if (!processWithCleanupFlag[TEST_PROJECT_CLEANUP_HOOK_KEY]) {
  process.once("beforeExit", cleanupTrackedTestProjectDirsSync);
  process.once("exit", cleanupTrackedTestProjectDirsSync);
  processWithCleanupFlag[TEST_PROJECT_CLEANUP_HOOK_KEY] = true;
}

export function __getTrackedTestProjectDirsForTests(): Set<string> {
  return TRACKED_TEST_PROJECT_DIRS;
}
