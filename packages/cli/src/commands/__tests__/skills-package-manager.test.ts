import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  DefaultPackageManager: vi.fn(),
  createReadOnlyProviderSettingsView: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  DefaultPackageManager: mocks.DefaultPackageManager,
}));
vi.mock("../provider-settings.js", () => ({
  createReadOnlyProviderSettingsView: mocks.createReadOnlyProviderSettingsView,
}));

import { createProjectScopedPackageManagerFactory } from "../skills-package-manager.js";

describe("createProjectScopedPackageManagerFactory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.DefaultPackageManager.mockImplementation(function (this: Record<string, unknown>, options) {
      Object.assign(this, { options });
    });
    mocks.createReadOnlyProviderSettingsView.mockImplementation((rootDir: string, agentDir: string) => ({ rootDir, agentDir }));
  });

  it("constructs a fresh package manager and settings view for each project root", () => {
    const agentDir = "/tmp/fusion-agent";
    const rootA = "/tmp/fusion-project-a";
    const rootB = "/tmp/fusion-project-b";
    const factory = createProjectScopedPackageManagerFactory(agentDir);

    const managerA = factory(rootA);
    const managerB = factory(rootB);

    expect(managerA).not.toBe(managerB);
    expect(mocks.createReadOnlyProviderSettingsView).toHaveBeenNthCalledWith(1, rootA, agentDir);
    expect(mocks.createReadOnlyProviderSettingsView).toHaveBeenNthCalledWith(2, rootB, agentDir);
    expect(mocks.DefaultPackageManager).toHaveBeenNthCalledWith(1, expect.objectContaining({
      cwd: resolve(rootA),
      agentDir,
      settingsManager: { rootDir: rootA, agentDir },
    }));
    expect(mocks.DefaultPackageManager).toHaveBeenNthCalledWith(2, expect.objectContaining({
      cwd: resolve(rootB),
      agentDir,
      settingsManager: { rootDir: rootB, agentDir },
    }));
  });
});
