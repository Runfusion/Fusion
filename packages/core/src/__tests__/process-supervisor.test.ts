import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __getProcessSupervisorStateForTests,
  __resetProcessSupervisorForTests,
  __terminateSupervisedChildrenForTests,
  superviseSpawn,
} from "../process-supervisor.js";

const fixturePath = join(import.meta.dirname, "fixtures", "process-supervisor-child.mjs");

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (true) {
    try {
      if (predicate()) {
        return;
      }
    } catch {
      // Retry until the timeout; many predicates wait on files to appear.
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("process-supervisor", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await __terminateSupervisedChildrenForTests("afterEach");
    __resetProcessSupervisorForTests();
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registers a child and deregisters it after natural exit", async () => {
    const child = superviseSpawn(process.execPath, [fixturePath, "exit-immediately"], {
      stdio: "ignore",
      maxLifetimeMs: 1_000,
    });

    expect(__getProcessSupervisorStateForTests()).toEqual({ registrySize: 1, handlersInstalled: true });
    await expect(child.waitExit()).resolves.toEqual({ code: 0, signal: null });
    await waitFor(() => __getProcessSupervisorStateForTests().registrySize === 0);
  });

  it("cascades SIGTERM to the supervised process group", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = mkdtempSync(join(os.tmpdir(), "fn-process-supervisor-"));
    tempDirs.push(root);
    const parentPidFile = join(root, "parent.pid");
    const grandchildPidFile = join(root, "grandchild.pid");

    const child = superviseSpawn(process.execPath, [fixturePath, "spawn-child", parentPidFile, grandchildPidFile], {
      stdio: "ignore",
      killGraceMs: 100,
      maxLifetimeMs: 5_000,
    });

    await waitFor(() => Number.parseInt(readFileSync(grandchildPidFile, "utf8"), 10) > 0);
    const grandchildPid = Number.parseInt(readFileSync(grandchildPidFile, "utf8"), 10);
    expect(isAlive(grandchildPid)).toBe(true);

    await __terminateSupervisedChildrenForTests("cascade");
    await child.waitExit();
    await waitFor(() => !isAlive(grandchildPid));
  });

  it("escalates to SIGKILL after the grace period", async () => {
    if (process.platform === "win32") {
      return;
    }

    const child = superviseSpawn(process.execPath, [fixturePath, "keepalive"], {
      stdio: "ignore",
      killGraceMs: 50,
      maxLifetimeMs: 5_000,
    });

    const realKill = process.kill.bind(process);
    const processKillSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -(child.pgid ?? 0)) {
        return true;
      }
      return realKill(pid, signal as NodeJS.Signals | undefined);
    }) as typeof process.kill);

    await __terminateSupervisedChildrenForTests("sigkill");
    expect(processKillSpy).toHaveBeenCalledWith(-(child.pgid ?? 0), "SIGTERM");
    expect(processKillSpy).toHaveBeenCalledWith(-(child.pgid ?? 0), "SIGKILL");

    processKillSpy.mockRestore();
    child.child.kill("SIGKILL");
    await expect(child.waitExit()).resolves.toEqual({ code: null, signal: "SIGKILL" });
  });

  it("enforces maxLifetimeMs", async () => {
    const child = superviseSpawn(process.execPath, [fixturePath, "keepalive"], {
      stdio: "ignore",
      killGraceMs: 50,
      maxLifetimeMs: 50,
    });

    const exit = await child.waitExit();
    expect(exit.code === null || exit.code === 0 || exit.signal !== null).toBe(true);
    await waitFor(() => __getProcessSupervisorStateForTests().registrySize === 0);
  });

  it("installs parent handlers only once", async () => {
    const before = process.listenerCount("SIGTERM");

    const first = superviseSpawn(process.execPath, [fixturePath, "exit-immediately"], { stdio: "ignore" });
    const second = superviseSpawn(process.execPath, [fixturePath, "exit-immediately"], { stdio: "ignore" });

    await Promise.all([first.waitExit(), second.waitExit()]);

    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    expect(__getProcessSupervisorStateForTests().handlersInstalled).toBe(true);
  });

  it("uses the Windows fallback branch when process groups are unavailable", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    const child = superviseSpawn(process.execPath, [fixturePath, "exit-immediately"], {
      stdio: "ignore",
    });

    expect(child.pgid).toBeNull();
    await expect(child.waitExit()).resolves.toEqual({ code: 0, signal: null });
  });
});
