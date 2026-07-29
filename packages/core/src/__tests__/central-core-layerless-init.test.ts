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

describe("CentralCore layer-less initialization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createCentralBackendLayer.mockResolvedValue({
      asyncLayer: { db: {} },
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

  it("boots and owns a PostgreSQL layer for standalone CLI callers", async () => {
    const globalDir = mkdtempSync(join(tmpdir(), "fusion-central-cli-init-"));
    cleanupDirs.push(globalDir);
    const central = new CentralCore(globalDir);

    await central.init();

    expect(mocks.createCentralBackendLayer).toHaveBeenCalledWith({ globalSettingsDir: globalDir });
    expect(mocks.ensureBackendBootstrap).toHaveBeenCalledOnce();
    expect(central.backendMode).toBe(true);

    await central.close();

    expect(mocks.getLocalNode).not.toHaveBeenCalled();
    expect(mocks.shutdown).toHaveBeenCalledOnce();
  });
});
