import { mkdtempSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { TaskStore } from "../store.js";
import {
  DEFAULT_PROJECT_SETTINGS,
  GLOBAL_SETTINGS_KEYS,
  type GlobalSettings,
  type Settings,
  type Task,
} from "../types.js";

export interface CreateTestProjectOptions {
  seedTasks?: number;
  globalSettingsDir?: string;
  settings?: Partial<Settings>;
}

export interface TestProjectFixture {
  rootDir: string;
  store: TaskStore;
  globalDir: string;
  cleanup: () => Promise<void>;
}

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
  const projectPatch: Partial<Settings> = { ...DEFAULT_PROJECT_SETTINGS };

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
 */
export async function createTestProject(
  options: CreateTestProjectOptions = {},
): Promise<TestProjectFixture> {
  const rootDir = mkdtempSync(join(tmpdir(), "fusion-test-project-"));
  const globalDir = options.globalSettingsDir
    ? options.globalSettingsDir
    : mkdtempSync(join(tmpdir(), "fusion-test-global-"));

  assertAbsolutePath(rootDir, "rootDir");
  assertAbsolutePath(globalDir, "globalSettingsDir");

  await mkdir(globalDir, { recursive: true });

  const store = new TaskStore(rootDir, globalDir);
  await store.init();

  const { globalPatch, projectPatch } = splitSettings(options.settings);
  await store.updateSettings(projectPatch);

  if (Object.keys(globalPatch).length > 0) {
    await store.updateGlobalSettings(globalPatch);
  }

  const requestedSeedCount = Math.max(0, Math.floor(options.seedTasks ?? 0));
  if (requestedSeedCount > 0) {
    await seedTasks(store, requestedSeedCount);
  }

  const cleanup = async () => {
    store.close();
    await destroyTestProject(rootDir);

    if (!options.globalSettingsDir) {
      await destroyTestProject(globalDir);
    }
  };

  return { rootDir, store, globalDir, cleanup };
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
  await rm(dir, { recursive: true, force: true });
}
