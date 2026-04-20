// @vitest-environment node

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DevServerManager,
  resetDevServerManager,
  type DevServerUrlDetectedEvent,
  type DevServerManagerOptions,
} from "../dev-server-manager.js";
import { DevServerStore } from "../dev-server-store.js";

async function createManager(
  rootDir: string,
  options?: DevServerManagerOptions,
): Promise<{ manager: DevServerManager; store: DevServerStore }> {
  const store = new DevServerStore(rootDir);
  await store.load();
  const manager = new DevServerManager(rootDir, store, {
    logLimit: 50,
    ...options,
  });
  await manager.initialize();
  return { manager, store };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("DevServerManager", () => {
  const managers: DevServerManager[] = [];

  afterEach(async () => {
    for (const manager of managers.splice(0)) {
      try {
        await manager.shutdown();
      } catch {
        // ignore cleanup failures
      }
    }
    resetDevServerManager();
  });

  it("emits url-detected with source and detectedAt payload", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-server-manager-"));
    const { manager } = await createManager(root);
    managers.push(manager);

    const detectedPromise = new Promise<DevServerUrlDetectedEvent>((resolve) => {
      manager.once("url-detected", (payload: DevServerUrlDetectedEvent) => resolve(payload));
    });

    await manager.start({
      command: "node -e \"console.log('preview at http://localhost:5173/'); setInterval(() => {}, 1000)\"",
      scriptName: "dev",
    });

    const detected = await detectedPromise;

    expect(detected).toMatchObject({
      url: "http://localhost:5173",
      port: 5173,
      source: "generic-url",
    });
    expect(Number.isNaN(Date.parse(detected.detectedAt))).toBe(false);
  });

  it("keeps manual preview URL effective while detected fields keep updating", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-server-manager-"));
    const { manager, store } = await createManager(root);
    managers.push(manager);

    await store.updateState({ manualUrl: "https://localhost:9999" });

    await manager.start({
      command: "node -e \"console.log('ready at http://localhost:4321/'); setInterval(() => {}, 1000)\"",
      scriptName: "dev",
    });

    await waitFor(() => (store.getState().detectedPort ?? 0) === 4321);

    const persisted = store.getState();
    const derived = manager.getState();

    expect(persisted.detectedUrl).toBe("http://localhost:4321");
    expect(persisted.detectedPort).toBe(4321);
    expect(persisted.manualUrl).toBe("https://localhost:9999");
    expect(derived.previewUrl).toBe("https://localhost:9999");
    expect(derived.previewPort).toBe(9999);
  });

  it("schedules and clears fallback probe timers through start/stop", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-server-manager-"));
    const { manager } = await createManager(root, {
      processOptions: { probeDelayMs: 2_000, probeTimeoutMs: 5 },
    });
    managers.push(manager);

    await manager.start({
      command: "node -e \"setInterval(() => {}, 1000)\"",
      scriptName: "dev",
    });

    expect(manager.hasPendingFallbackProbeTimer()).toBe(true);

    await manager.stop();

    expect(manager.hasPendingFallbackProbeTimer()).toBe(false);
  });

  it("runs fallback probe after grace period when logs do not announce a URL", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-server-manager-"));
    const { manager } = await createManager(root, {
      processOptions: { probeDelayMs: 25, probeTimeoutMs: 5 },
    });
    managers.push(manager);

    await manager.start({
      command: "node -e \"setInterval(() => {}, 1000)\"",
      scriptName: "dev",
    });

    expect(manager.hasPendingFallbackProbeTimer()).toBe(true);
    await waitFor(() => manager.hasPendingFallbackProbeTimer() === false, 3_000);
  });

  it("restart keeps fallback probing active with a fresh timer", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-server-manager-"));
    const { manager } = await createManager(root, {
      processOptions: { probeDelayMs: 2_000, probeTimeoutMs: 5 },
    });
    managers.push(manager);

    await manager.start({
      command: "node -e \"setInterval(() => {}, 1000)\"",
      scriptName: "dev",
    });

    expect(manager.hasPendingFallbackProbeTimer()).toBe(true);

    await manager.restart();

    expect(manager.hasPendingFallbackProbeTimer()).toBe(true);
  });

  it("shutdown clears fallback probe timers", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-server-manager-"));
    const { manager } = await createManager(root, {
      processOptions: { probeDelayMs: 2_000, probeTimeoutMs: 5 },
    });
    managers.push(manager);

    await manager.start({
      command: "node -e \"setInterval(() => {}, 1000)\"",
      scriptName: "dev",
    });

    expect(manager.hasPendingFallbackProbeTimer()).toBe(true);

    await manager.shutdown();

    expect(manager.hasPendingFallbackProbeTimer()).toBe(false);
  });
});
