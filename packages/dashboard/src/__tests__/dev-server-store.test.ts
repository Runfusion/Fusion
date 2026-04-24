// @vitest-environment node

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEV_SERVER_CONFIG_DEFAULTS,
  DEV_SERVER_DEFAULT_STATE,
  DEV_SERVER_LOG_MAX_LINES,
  DevServerStore,
  loadDevServerStore,
  resetDevServerStore,
} from "../dev-server-store.js";

function createTempProject(): string {
  return mkdtempSync(join(os.tmpdir(), "fn-dev-server-store-"));
}

function readPersistedStoreFile(projectDir: string): Record<string, unknown> {
  const filePath = join(projectDir, ".fusion", "dev-server.json");
  return JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
}

describe("DevServerStore", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
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
    expect(store.getConfig()).toEqual(DEV_SERVER_CONFIG_DEFAULTS);
  });

  it("loading from missing file initializes with default config", async () => {
    const projectDir = createTempProject();
    tempDirs.push(projectDir);

    const store = new DevServerStore(projectDir);
    await store.load();

    expect(store.getConfig()).toEqual(DEV_SERVER_CONFIG_DEFAULTS);
  });

  it("loading from valid JSON populates config", async () => {
    const projectDir = createTempProject();
    tempDirs.push(projectDir);

    mkdirSync(join(projectDir, ".fusion"), { recursive: true });
    writeFileSync(
      join(projectDir, ".fusion", "dev-server.json"),
      JSON.stringify(
        {
          config: {
            selectedScript: "dev",
            selectedSource: "apps/web",
            selectedCommand: "pnpm dev",
            previewUrlOverride: "http://localhost:4173",
            detectedPreviewUrl: "http://localhost:3000",
            selectedAt: "2026-04-19T12:00:00.000Z",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const store = new DevServerStore(projectDir);
    await store.load();

    expect(store.getConfig()).toEqual({
      selectedScript: "dev",
      selectedSource: "apps/web",
      selectedCommand: "pnpm dev",
      previewUrlOverride: "http://localhost:4173",
      detectedPreviewUrl: "http://localhost:3000",
      selectedAt: "2026-04-19T12:00:00.000Z",
    });
  });

  it("updateConfig merges partial updates and persists to disk", async () => {
    const projectDir = createTempProject();
    tempDirs.push(projectDir);

    const store = new DevServerStore(projectDir);
    await store.load();

    const updated = await store.updateConfig({
      selectedScript: "start",
      selectedSource: "root",
      selectedCommand: "next dev",
      selectedAt: "2026-04-19T13:00:00.000Z",
    });

    expect(updated).toEqual({
      ...DEV_SERVER_CONFIG_DEFAULTS,
      selectedScript: "start",
      selectedSource: "root",
      selectedCommand: "next dev",
      selectedAt: "2026-04-19T13:00:00.000Z",
    });

    const persisted = readPersistedStoreFile(projectDir) as {
      config: Record<string, string | null>;
    };

    expect(persisted.config).toMatchObject({
      selectedScript: "start",
      selectedSource: "root",
      selectedCommand: "next dev",
      selectedAt: "2026-04-19T13:00:00.000Z",
    });
  });

  it("updateConfig overwrites previous values", async () => {
    const projectDir = createTempProject();
    tempDirs.push(projectDir);

    const store = new DevServerStore(projectDir);
    await store.load();

    await store.updateConfig({ selectedScript: "dev", previewUrlOverride: "http://localhost:3000" });
    const updated = await store.updateConfig({ selectedScript: "serve", previewUrlOverride: null });

    expect(updated.selectedScript).toBe("serve");
    expect(updated.previewUrlOverride).toBeNull();
  });

  it("saveConfig persists full config payload", async () => {
    const projectDir = createTempProject();
    tempDirs.push(projectDir);

    const store = new DevServerStore(projectDir);
    await store.load();

    await store.saveConfig({
      selectedScript: "storybook",
      selectedSource: "apps/docs",
      selectedCommand: "storybook dev -p 6006",
      previewUrlOverride: "http://localhost:6006",
      detectedPreviewUrl: "http://localhost:6006",
      selectedAt: "2026-04-19T14:00:00.000Z",
    });

    const persisted = readPersistedStoreFile(projectDir) as {
      config: Record<string, string | null>;
    };

    expect(persisted.config).toEqual({
      selectedScript: "storybook",
      selectedSource: "apps/docs",
      selectedCommand: "storybook dev -p 6006",
      previewUrlOverride: "http://localhost:6006",
      detectedPreviewUrl: "http://localhost:6006",
      selectedAt: "2026-04-19T14:00:00.000Z",
    });
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

    const persisted = readPersistedStoreFile(projectDir) as { state: Record<string, unknown> };
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

    const persisted = readPersistedStoreFile(projectDir) as { state: { logHistory: string[] } };
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

    const persisted = readPersistedStoreFile(projectDir) as { state: { logHistory: string[] } };
    expect(persisted.state.logHistory).toEqual([]);
  });

  it("treats ENOENT as non-fatal when project directory is removed during save", async () => {
    const projectDir = createTempProject();
    tempDirs.push(projectDir);

    const store = new DevServerStore(projectDir);
    await store.load();

    rmSync(projectDir, { recursive: true, force: true });

    await expect(store.updateState({ id: "gone", status: "stopped" })).resolves.toMatchObject({
      id: "gone",
      status: "stopped",
    });
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
