import { describe, expect, it, vi } from "vitest";
import { UpdateInstallCoordinator } from "../update-install-coordinator.js";

const installed = { currentVersion: "1.0.0", latestVersion: "2.0.0", updated: true, outcome: "installed" as const };

describe("UpdateInstallCoordinator", () => {
  it("shares one in-flight install and retains only a successful installed target", async () => {
    const coordinator = new UpdateInstallCoordinator();
    let resolve!: (value: typeof installed) => void;
    const operation = vi.fn(() => new Promise<typeof installed>((done) => { resolve = done; }));
    const first = coordinator.install("2.0.0", operation);
    const second = coordinator.install("2.0.0", operation);
    expect(operation).toHaveBeenCalledTimes(1);
    resolve(installed);
    await expect(Promise.all([first, second])).resolves.toEqual([installed, installed]);
    expect(coordinator.getPendingInstall()).toMatchObject({ ...installed, restartScheduled: false });
    await coordinator.install("3.0.0", operation);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("releases a failed install for retry and makes accepted restart idempotent", async () => {
    const coordinator = new UpdateInstallCoordinator();
    const failed = { ...installed, updated: false, outcome: "failed" as const };
    await coordinator.install("2.0.0", vi.fn().mockResolvedValue(failed));
    expect(coordinator.getPendingInstall()).toBeUndefined();
    await coordinator.install("2.0.0", vi.fn().mockResolvedValue(installed));
    const request = vi.fn(() => false);
    expect(coordinator.requestRestart(request)).toBe(false);
    expect(coordinator.getPendingInstall()).toMatchObject({ restartScheduled: false });
    request.mockReturnValue(true);
    expect(coordinator.requestRestart(request)).toBe(true);
    expect(coordinator.requestRestart(request)).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    expect(coordinator.getPendingInstall()).toMatchObject({ restartAttempted: true, restartScheduled: true });
  });
});
