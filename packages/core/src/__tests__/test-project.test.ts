import { mkdtempSync, existsSync } from "node:fs";
import { rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TaskStore } from "../store.js";
import {
  createTestProject,
  destroyTestProject,
  seedTasks,
  type TestProjectFixture,
} from "./test-project.js";

const fixtures: TestProjectFixture[] = [];
const extraDirs = new Set<string>();

async function createFixture(options?: Parameters<typeof createTestProject>[0]): Promise<TestProjectFixture> {
  const fixture = await createTestProject(options);
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  await Promise.allSettled(fixtures.splice(0).map((fixture) => fixture.cleanup()));
  await Promise.allSettled([...extraDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  extraDirs.clear();
});

describe("test-project fixture", () => {
  it("createTestProject() returns a valid isolated project with initialized .fusion structure", async () => {
    const fixture = await createFixture();

    expect(isAbsolute(fixture.rootDir)).toBe(true);
    expect(isAbsolute(fixture.globalDir)).toBe(true);
    expect(existsSync(join(fixture.rootDir, ".fusion"))).toBe(true);
    expect(existsSync(join(fixture.rootDir, ".fusion", "fusion.db"))).toBe(true);
    expect(existsSync(join(fixture.rootDir, ".fusion", "config.json"))).toBe(true);
    expect(existsSync(join(fixture.rootDir, ".fusion", "tasks"))).toBe(true);
    expect(existsSync(join(fixture.rootDir, ".fusion", "memory.md"))).toBe(true);

    const configRaw = await readFile(join(fixture.rootDir, ".fusion", "config.json"), "utf-8");
    const config = JSON.parse(configRaw);
    expect(config.nextId).toBe(1);
    expect(config.settings.taskPrefix).toBe("FN");

    const tasks = await fixture.store.listTasks();
    expect(tasks).toHaveLength(0);
  });

  it("seedTasks(store, 3) creates exactly 3 tasks", async () => {
    const fixture = await createFixture();

    const seeded = await seedTasks(fixture.store, 3);
    const tasks = await fixture.store.listTasks();

    expect(seeded).toHaveLength(3);
    expect(tasks).toHaveLength(3);
  });

  it("destroyTestProject() removes the project directory recursively", async () => {
    const fixture = await createFixture();

    fixture.store.close();
    await destroyTestProject(fixture.rootDir);

    expect(existsSync(fixture.rootDir)).toBe(false);
  });

  it("supports multiple isolated projects without cross-interference", async () => {
    const first = await createFixture({ seedTasks: 1 });
    const second = await createFixture({ seedTasks: 2 });

    expect(first.rootDir).not.toBe(second.rootDir);
    expect(first.globalDir).not.toBe(second.globalDir);

    const firstTasks = await first.store.listTasks();
    const secondTasks = await second.store.listTasks();

    expect(firstTasks).toHaveLength(1);
    expect(secondTasks).toHaveLength(2);
    expect(firstTasks[0].id).toBe("FN-001");
    expect(secondTasks[0].id).toBe("FN-001");
  });

  it("applies custom settings and honors a custom global settings directory", async () => {
    const customGlobalDir = mkdtempSync(join(tmpdir(), "fusion-custom-global-"));
    extraDirs.add(customGlobalDir);

    const fixture = await createFixture({
      globalSettingsDir: customGlobalDir,
      settings: {
        maxConcurrent: 7,
        taskPrefix: "TP",
        themeMode: "light",
      },
    });

    const settings = await fixture.store.getSettings();

    expect(fixture.globalDir).toBe(customGlobalDir);
    expect(settings.maxConcurrent).toBe(7);
    expect(settings.taskPrefix).toBe("TP");
    expect(settings.themeMode).toBe("light");
    expect(existsSync(join(customGlobalDir, "settings.json"))).toBe(true);
  });

  it("returns a real TaskStore instance that can create, list, and fetch tasks", async () => {
    const fixture = await createFixture();

    expect(fixture.store).toBeInstanceOf(TaskStore);

    const created = await fixture.store.createTask({
      description: "Validate real TaskStore operations in fixture",
    });

    const listed = await fixture.store.listTasks();
    const fetched = await fixture.store.getTask(created.id);

    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(created.id);
    expect(fetched.description).toContain("Validate real TaskStore operations");
  });

  it("createTestProject({ seedTasks }) pre-seeds tasks during setup", async () => {
    const fixture = await createFixture({ seedTasks: 4 });

    const tasks = await fixture.store.listTasks();

    expect(tasks).toHaveLength(4);
  });
});
