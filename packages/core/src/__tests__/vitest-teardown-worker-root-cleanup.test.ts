import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { __fusionWorkerRootCleanupTestHooks } from "../__test-utils__/vitest-setup";
import setup, {
  __setWorkerRootRmSyncForTests,
  __setWorkerRootSleepMsSyncForTests,
  removeLegacyTopLevelHomeRoots,
} from "../__test-utils__/vitest-teardown";

const createdPaths: string[] = [];
const originalWorkerRoot = process.env.FUSION_TEST_WORKER_ROOT;

function remember(path: string): string {
  createdPaths.push(path);
  return path;
}

function makeWorkerChild(root: string, label: string): void {
  const workerDir = join(root, `w-${process.pid}-${label}`);
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(join(workerDir, "file.txt"), "worker temp payload");
}

function restoreWorkerRootEnv(): void {
  if (originalWorkerRoot === undefined) {
    delete process.env.FUSION_TEST_WORKER_ROOT;
  } else {
    process.env.FUSION_TEST_WORKER_ROOT = originalWorkerRoot;
  }
}

afterEach(() => {
  __setWorkerRootRmSyncForTests(rmSync);
  __setWorkerRootSleepMsSyncForTests(() => {});
  restoreWorkerRootEnv();
  for (const path of createdPaths.splice(0).reverse()) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("vitest global teardown worker-root cleanup", () => {
  it("removes the per-invocation worker root on the clean path", async () => {
    const teardown = setup();
    const workerRoot = remember(process.env.FUSION_TEST_WORKER_ROOT!);
    makeWorkerChild(workerRoot, "clean");

    await teardown();

    expect(existsSync(workerRoot)).toBe(false);
  });

  it("retries an EBUSY worker-root removal and removes the root", async () => {
    const teardown = setup();
    const workerRoot = remember(process.env.FUSION_TEST_WORKER_ROOT!);
    makeWorkerChild(workerRoot, "busy");
    let attempts = 0;
    const sleeps: number[] = [];

    __setWorkerRootRmSyncForTests((path, options) => {
      attempts++;
      if (attempts === 1) {
        const error = new Error("resource busy") as NodeJS.ErrnoException;
        error.code = "EBUSY";
        throw error;
      }
      rmSync(path, options);
    });
    __setWorkerRootSleepMsSyncForTests((ms) => {
      sleeps.push(ms);
    });

    await teardown();

    expect(attempts).toBe(2);
    expect(sleeps).toEqual([75]);
    expect(existsSync(workerRoot)).toBe(false);
  });

  it("retries transient ENOTEMPTY worker-root cleanup until the root can be removed", async () => {
    const teardown = setup();
    const workerRoot = remember(process.env.FUSION_TEST_WORKER_ROOT!);
    makeWorkerChild(workerRoot, "not-empty");
    let attempts = 0;
    const sleeps: number[] = [];

    __setWorkerRootRmSyncForTests((path, options) => {
      attempts++;
      if (attempts <= 3) {
        const error = new Error("directory not empty") as NodeJS.ErrnoException;
        error.code = "ENOTEMPTY";
        throw error;
      }
      rmSync(path, options);
    });
    __setWorkerRootSleepMsSyncForTests((ms) => {
      sleeps.push(ms);
    });

    await teardown();

    expect(attempts).toBe(4);
    expect(sleeps).toEqual([75, 75, 75]);
    expect(existsSync(workerRoot)).toBe(false);
  });

  it("tolerates ENOENT when the worker root is already gone", async () => {
    const teardown = setup();
    const workerRoot = remember(process.env.FUSION_TEST_WORKER_ROOT!);
    makeWorkerChild(workerRoot, "enoent");
    rmSync(workerRoot, { recursive: true, force: true });

    await teardown();

    expect(existsSync(workerRoot)).toBe(false);
  });

  it("sweeps legacy top-level temp HOME roots without walking unrelated temp entries", () => {
    const tempRoot = remember(mkdtempSync(join(tmpdir(), "fusion-test-home-sweep-root-")));
    const legacyHome = join(tempRoot, "fn-test-home-stale");
    const unrelated = join(tempRoot, "fusion-test-workers-current");
    mkdirSync(legacyHome, { recursive: true });
    mkdirSync(unrelated, { recursive: true });
    writeFileSync(join(legacyHome, "payload.txt"), "legacy home state");

    removeLegacyTopLevelHomeRoots(tempRoot);

    expect(existsSync(legacyHome)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
  });

  it("removes a self-minted fallback worker root during exit cleanup", () => {
    const workerRoot = remember(mkdtempSync(join(tmpdir(), "fusion-test-workers-self-minted-")));
    const workerDir = join(workerRoot, `w-${process.pid}-fallback`);
    const redirDir = join(workerRoot, `redir-${process.pid}`);
    mkdirSync(workerDir, { recursive: true });
    mkdirSync(redirDir, { recursive: true });
    writeFileSync(join(workerDir, "payload.txt"), "worker temp payload");
    writeFileSync(join(redirDir, "payload.txt"), "redirect temp payload");
    __fusionWorkerRootCleanupTestHooks.writeWorkerRootOwnerMarker(workerRoot);

    __fusionWorkerRootCleanupTestHooks.removeSelfMintedWorkerRootWithRetry(workerRoot, true, 0);

    expect(existsSync(workerRoot)).toBe(false);
  });
});
