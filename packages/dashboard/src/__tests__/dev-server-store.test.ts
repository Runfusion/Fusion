// @vitest-environment node

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEV_SERVER_DEFAULT_STATE,
  DEV_SERVER_LOG_MAX_LINES,
  DevServerStore,
  loadDevServerStore,
  resetDevServerStore,
} from "../dev-server-store.js";

function createTempProject(): string {
  return mkdtempSync(join(os.tmpdir(), "fn-dev-server-store-"));
}

function readPersistedState(projectDir: string): Record<string, unknown> {
  const filePath = join(projectDir, ".fusion", "dev-server.json");
  return JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
}

describe("DevServerStore", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    resetDevServerStore();
  });

  it("loading from missing file initializes with default state", async () => {
    const projectDir = createTempProject();
    tempDirs.push(projectDir);

    const store = new DevServerStore(projectDir);
    await store.load();

    expect(store.getState()).toEqual(DEV_SERVER_DEFAULT_STATE());
  });

  it("loading from valid JSON populates state correctly", async () => {
    const projectDir = createTempProject();
    tempDirs.push(projectDir);

    mkdirSync(join(projectDir, ".fusion"), { recursive: true });
    writeFileSync(
      join(projectDir, ".fusion", "dev-server.json"),
      JSON.stringify(
        {
          state: {
            id: "server-1",
            name: "default",
            status: "running",
            command: "pnpm dev",
            cwd: projectDir,
            logHistory: ["ready"],
            detectedUrl: "http://localhost:5173",
            detectedPort: 5173,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const store = new DevServerStore(projectDir);
    await store.load();

    expect(store.getState()).toMatchObject({
      id: "server-1",
      status: "running",
      command: "pnpm dev",
      cwd: projectDir,
      detectedUrl: "http://localhost:5173",
      detectedPort: 5173,
      logHistory: ["ready"],
    });
  });

  it("loading from invalid JSON falls back to default state", async () => {
    const projectDir = createTempProject();
    tempDirs.push(projectDir);

    mkdirSync(join(projectDir, ".fusion"), { recursive: true });
    writeFileSync(join(projectDir, ".fusion", "dev-server.json"), "{invalid", "utf-8");

    const store = new DevServerStore(projectDir);
    await store.load();

    expect(store.getState()).toEqual(DEV_SERVER_DEFAULT_STATE());
  });

  it("updateState merges partial updates and persists to disk", async () => {
    const projectDir = createTempProject();
    tempDirs.push(projectDir);

    const store = new DevServerStore(projectDir);
    await store.load();

    const updated = await store.updateState({
      id: "abc",
      command: "pnpm dev",
      cwd: projectDir,
      status: "starting",
    });

    expect(updated).toMatchObject({
      id: "abc",
      command: "pnpm dev",
      cwd: projectDir,
      status: "starting",
      name: "default",
    });

    const persisted = readPersistedState(projectDir) as { state: Record<string, unknown> };
    expect(persisted.state).toMatchObject({
      id: "abc",
      command: "pnpm dev",
      status: "starting",
    });
  });

  it("updateState overwrites previous values", async () => {
    const projectDir = createTempProject();
    tempDirs.push(projectDir);

    const store = new DevServerStore(projectDir);
    await store.load();

    await store.updateState({ command: "pnpm dev", status: "running" });
    const updated = await store.updateState({ command: "npm run start", status: "failed", exitCode: 1 });

    expect(updated.command).toBe("npm run start");
    expect(updated.status).toBe("failed");
    expect(updated.exitCode).toBe(1);
  });

  it("appendLog adds lines to logHistory", async () => {
    const projectDir = createTempProject();
    tempDirs.push(projectDir);

    const store = new DevServerStore(projectDir);
    await store.load();

    await store.appendLog("line one");
    await store.appendLog("line two");

    expect(store.getState().logHistory).toEqual(["line one", "line two"]);

    const persisted = readPersistedState(projectDir) as { state: { logHistory: string[] } };
    expect(persisted.state.logHistory).toEqual(["line one", "line two"]);
  });

  it("appendLog trims ring buffer at max 500 lines", async () => {
    const projectDir = createTempProject();
    tempDirs.push(projectDir);

    const store = new DevServerStore(projectDir);
    await store.load();

    for (let i = 0; i < DEV_SERVER_LOG_MAX_LINES + 2; i += 1) {
      await store.appendLog(`line-${i}`);
    }

    const logHistory = store.getState().logHistory;
    expect(logHistory).toHaveLength(DEV_SERVER_LOG_MAX_LINES);
    expect(logHistory[0]).toBe("line-2");
    expect(logHistory[DEV_SERVER_LOG_MAX_LINES - 1]).toBe(`line-${DEV_SERVER_LOG_MAX_LINES + 1}`);
  });

  it("clearLogs empties logHistory and persists", async () => {
    const projectDir = createTempProject();
    tempDirs.push(projectDir);

    const store = new DevServerStore(projectDir);
    await store.load();

    await store.appendLog("before clear");
    await store.clearLogs();

    expect(store.getState().logHistory).toEqual([]);

    const persisted = readPersistedState(projectDir) as { state: { logHistory: string[] } };
    expect(persisted.state.logHistory).toEqual([]);
  });

  it("singleton cache returns same instance for same path", async () => {
    const projectDir = createTempProject();
    tempDirs.push(projectDir);

    const first = await loadDevServerStore(projectDir);
    const second = await loadDevServerStore(projectDir);

    expect(first).toBe(second);
  });

  it("resetDevServerStore clears singleton cache", async () => {
    const projectDir = createTempProject();
    tempDirs.push(projectDir);

    const first = await loadDevServerStore(projectDir);
    resetDevServerStore();
    const second = await loadDevServerStore(projectDir);

    expect(first).not.toBe(second);
  });
});
