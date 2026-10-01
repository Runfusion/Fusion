import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
const originalRunToken = process.env.FUSION_TEST_RUN_TOKEN;

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
  if (originalRunToken === undefined) {
    delete process.env.FUSION_TEST_RUN_TOKEN;
  } else {
    process.env.FUSION_TEST_RUN_TOKEN = originalRunToken;
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
    process.env.FUSION_TEST_RUN_TOKEN = "clean-run-token";
    const teardown = setup();
    const workerRoot = remember(process.env.FUSION_TEST_WORKER_ROOT!);
    makeWorkerChild(workerRoot, "clean");

    /*
    FNXC:TestTeardownOwnership 2026-09-21-10:48:
    FN-9349 requires this regression to execute globalSetup's marker protocol,
    including its run token, rather than only invoking a cleanup helper.
    */
    expect(readFileSync(join(workerRoot, ".fusion-test-worker-root-owner"), "utf8")).toBe(
      `${process.pid}\nrunToken=clean-run-token\n`,
    );
    await teardown();

    expect(existsSync(workerRoot)).toBe(false);
  });

  it("removes its root after worker forks rewrite the marker with their own pids", async () => {
    /*
    FNXC:TestTeardownOwnership 2026-09-23-01:55:
    Real forked-worker runs leaked one fusion-test-workers-* root per vitest invocation because
    each worker fork rewrites the owner marker with its OWN pid (via vitest-setup's
    ensureWorkerRoot), so the main-process teardown's exact `${pid}\nrunToken=...` match never held
    and removal was skipped (106 stale roots accumulated, tripping check-test-isolation). Ownership
    is proven by the shared run token, not the pid: a marker carrying a different pid but the same
    run token is still this invocation's root and must be removed.
    */
    process.env.FUSION_TEST_RUN_TOKEN = "forked-worker-token";
    const teardown = setup();
    const workerRoot = remember(process.env.FUSION_TEST_WORKER_ROOT!);
    makeWorkerChild(workerRoot, "forked");

    const foreignWorkerPid = process.pid + 7;
    writeFileSync(
      join(workerRoot, ".fusion-test-worker-root-owner"),
      `${foreignWorkerPid}\nrunToken=forked-worker-token\n`,
    );
    await teardown();

    expect(existsSync(workerRoot)).toBe(false);
  });

  it("does not let a stale teardown remove a successor-owned worker root", async () => {
    process.env.FUSION_TEST_RUN_TOKEN = "stale-run-token";
    const staleTeardown = setup();
    const workerRoot = remember(process.env.FUSION_TEST_WORKER_ROOT!);
    makeWorkerChild(workerRoot, "successor");

    /*
    FNXC:TestTeardownOwnership 2026-09-21-10:48:
    FN-9349 requires a stale teardown to reject a successor's distinct run-token
    marker, preserving the live successor root instead of deleting it by path.
    */
    writeFileSync(
      join(workerRoot, ".fusion-test-worker-root-owner"),
      `${process.pid}\nrunToken=successor-run-token\n`,
    );
    await staleTeardown();

    expect(existsSync(workerRoot)).toBe(true);
    expect(readFileSync(join(workerRoot, ".fusion-test-worker-root-owner"), "utf8")).toContain("successor-run-token");
    expect(existsSync(join(workerRoot, "w-" + process.pid + "-successor", "file.txt"))).toBe(true);
  });

  it("preserves an unproven partial-startup root while cleaning a live sibling", async () => {
    process.env.FUSION_TEST_RUN_TOKEN = "partial-startup-token";
    const partialTeardown = setup();
    const partialRoot = remember(process.env.FUSION_TEST_WORKER_ROOT!);
    makeWorkerChild(partialRoot, "partial");

    /*
    FNXC:TestTeardownOwnership 2026-09-21-10:48:
    FN-9349 requires partial startup to fail closed: absent marker provenance
    cannot authorize deleting a root while an independent sibling remains live.
    */
    unlinkSync(join(partialRoot, ".fusion-test-worker-root-owner"));

    process.env.FUSION_TEST_RUN_TOKEN = "live-sibling-token";
    const siblingTeardown = setup();
    const siblingRoot = remember(process.env.FUSION_TEST_WORKER_ROOT!);
    makeWorkerChild(siblingRoot, "live-sibling");

    await partialTeardown();

    expect(existsSync(partialRoot)).toBe(true);
    expect(existsSync(join(partialRoot, "w-" + process.pid + "-partial", "file.txt"))).toBe(true);
    expect(existsSync(siblingRoot)).toBe(true);
    expect(existsSync(join(siblingRoot, "w-" + process.pid + "-live-sibling", "file.txt"))).toBe(true);

    await siblingTeardown();
    expect(existsSync(siblingRoot)).toBe(false);
  });

  it("removes only its own root while a live sibling teardown remains active", async () => {
    const firstTeardown = setup();
    const firstRoot = remember(process.env.FUSION_TEST_WORKER_ROOT!);
    makeWorkerChild(firstRoot, "first");

    const secondTeardown = setup();
    const secondRoot = remember(process.env.FUSION_TEST_WORKER_ROOT!);
    makeWorkerChild(secondRoot, "second");

    await firstTeardown();

    expect(existsSync(firstRoot)).toBe(false);
    expect(existsSync(secondRoot)).toBe(true);
    expect(existsSync(join(secondRoot, "w-" + process.pid + "-second", "file.txt"))).toBe(true);

    await secondTeardown();
    expect(existsSync(secondRoot)).toBe(false);
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
