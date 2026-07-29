import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createCentralBackendLayer: vi.fn(),
  ensureBackendBootstrap: vi.fn(),
  getLocalNode: vi.fn(),
  releaseConnections: vi.fn(),
  shutdown: vi.fn(),
}));

vi.mock("../postgres/startup-factory.js", () => ({
  createCentralBackendLayer: mocks.createCentralBackendLayer,
}));

vi.mock("../async-central-core.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../async-central-core.js")>();
  return {
    ...actual,
    ensureBackendBootstrap: mocks.ensureBackendBootstrap,
    getLocalNode: mocks.getLocalNode,
  };
});

import { CentralCore } from "../central-core.js";

const cleanupDirs: string[] = [];
const ownedLayer = { db: {} };

describe("CentralCore layer-less initialization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createCentralBackendLayer.mockResolvedValue({
      asyncLayer: ownedLayer,
      releaseConnections: mocks.releaseConnections,
      shutdown: mocks.shutdown,
    });
    mocks.getLocalNode.mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const dir of cleanupDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * FNXC:CentralCore 2026-07-29-16:10:
   * Standalone callers must bootstrap the exact layer they own and release that lifecycle on close; concurrent init calls share the same allocation.
   */
  it("boots and owns a PostgreSQL layer for standalone CLI callers", async () => {
    const globalDir = mkdtempSync(join(tmpdir(), "fusion-central-cli-init-"));
    cleanupDirs.push(globalDir);
    const central = new CentralCore(globalDir);

    await central.init();

    expect(mocks.createCentralBackendLayer).toHaveBeenCalledWith({ globalSettingsDir: globalDir });
    expect(mocks.ensureBackendBootstrap).toHaveBeenCalledWith(ownedLayer);
    expect(central.asyncLayer).toBe(ownedLayer);
    expect(central.backendMode).toBe(true);

    await central.close();

    expect(mocks.getLocalNode).not.toHaveBeenCalled();
    expect(mocks.shutdown).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent layer-less initialization into one owned backend", async () => {
    const globalDir = mkdtempSync(join(tmpdir(), "fusion-central-cli-concurrent-init-"));
    cleanupDirs.push(globalDir);
    const central = new CentralCore(globalDir);

    await Promise.all([central.init(), central.init()]);

    expect(mocks.createCentralBackendLayer).toHaveBeenCalledOnce();
    expect(mocks.ensureBackendBootstrap).toHaveBeenCalledOnce();
    expect(mocks.ensureBackendBootstrap).toHaveBeenCalledWith(ownedLayer);

    await central.close();
    expect(mocks.shutdown).toHaveBeenCalledOnce();
  });
});
