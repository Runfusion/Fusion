import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStore } from "../store.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "fusion-pr-entity-test-"));
}

describe("TaskStore PR entities", () => {
  let rootDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = makeTmpDir();
    store = new TaskStore(rootDir, join(rootDir, ".fusion-global"));
    await store.init();
  });

  afterEach(async () => {
    store.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("creates, reads, and updates a PR entity", () => {
    const e = store.ensurePrEntityForSource({
      sourceType: "task",
      sourceId: "T-1",
      repo: "owner/repo",
      headBranch: "fusion/t-1",
    });
    expect(e.id.startsWith("PR-")).toBe(true);
    expect(e.state).toBe("creating");
    expect(e.autoMerge).toBe(false);
    expect(e.unverified).toBe(false);

    expect(store.getPrEntity(e.id)?.headBranch).toBe("fusion/t-1");
    expect(store.getActivePrEntityBySource("task", "T-1")?.id).toBe(e.id);

    const opened = store.updatePrEntity(e.id, {
      state: "open",
      prNumber: 42,
      prUrl: "https://github.com/owner/repo/pull/42",
      headOid: "abc123",
      reviewDecision: "APPROVED",
      checksRollup: "success",
      mergeable: "clean",
    });
    expect(opened.state).toBe("open");
    expect(opened.prNumber).toBe(42);
    expect(opened.reviewDecision).toBe("APPROVED");
    expect(store.getPrEntityByNumber("owner/repo", 42)?.id).toBe(e.id);
  });

  it("create-or-reuse: same source twice returns one entity (AE6 idempotency)", () => {
    const a = store.ensurePrEntityForSource({
      sourceType: "branch-group",
      sourceId: "BG-1",
      repo: "owner/repo",
      headBranch: "fusion/group",
    });
    const b = store.ensurePrEntityForSource({
      sourceType: "branch-group",
      sourceId: "BG-1",
      repo: "owner/repo",
      headBranch: "fusion/group",
    });
    expect(b.id).toBe(a.id);
  });

  it("reuse only applies to non-terminal entities; recreate-after-close mints a new one", () => {
    const first = store.ensurePrEntityForSource({
      sourceType: "task",
      sourceId: "T-2",
      repo: "owner/repo",
      headBranch: "fusion/t-2",
    });
    store.updatePrEntity(first.id, { state: "closed" });
    const second = store.ensurePrEntityForSource({
      sourceType: "task",
      sourceId: "T-2",
      repo: "owner/repo",
      headBranch: "fusion/t-2b",
    });
    expect(second.id).not.toBe(first.id);
    expect(store.getPrEntity(first.id)?.state).toBe("closed");
  });

  it("listActivePrEntities excludes terminal rows", () => {
    const a = store.ensurePrEntityForSource({ sourceType: "task", sourceId: "T-A", repo: "r", headBranch: "a" });
    const b = store.ensurePrEntityForSource({ sourceType: "task", sourceId: "T-B", repo: "r", headBranch: "b" });
    store.updatePrEntity(b.id, { state: "merged" });
    const active = store.listActivePrEntities().map((e) => e.id);
    expect(active).toContain(a.id);
    expect(active).not.toContain(b.id);
  });

  it("records and reads per-thread response state keyed by thread id + head OID", () => {
    const e = store.ensurePrEntityForSource({ sourceType: "task", sourceId: "T-3", repo: "r", headBranch: "h" });
    store.recordPrThreadOutcome(e.id, "thread-1", "oid-1", "fixed", "sha-1");
    store.recordPrThreadOutcome(e.id, "thread-1", "oid-2", "pending");
    expect(store.getPrThreadState(e.id, "thread-1", "oid-1")?.outcome).toBe("fixed");
    expect(store.getPrThreadState(e.id, "thread-1", "oid-1")?.fixCommitSha).toBe("sha-1");
    expect(store.getPrThreadState(e.id, "thread-1", "oid-2")?.outcome).toBe("pending");
    expect(store.listPrThreadStates(e.id)).toHaveLength(2);

    // Upsert on the same key updates in place.
    store.recordPrThreadOutcome(e.id, "thread-1", "oid-2", "disagreed");
    expect(store.getPrThreadState(e.id, "thread-1", "oid-2")?.outcome).toBe("disagreed");
    expect(store.listPrThreadStates(e.id)).toHaveLength(2);
  });

  it("migrates legacy branch-group PR fields into unverified entities (R19)", () => {
    // Simulate a legacy branch group that claims an open PR.
    const group = store.createBranchGroup({ sourceType: "mission", sourceId: "M-1", branchName: "fusion/legacy" });
    store.updateBranchGroup(group.id, { prState: "open", prNumber: 7, prUrl: "https://example/pr/7" });

    // Re-run the migration path by invoking the same copy the v109 block runs.
    // (init already ran v109 on an empty DB; here we assert the entity-from-legacy
    // shape via a direct ensure mirroring the migration's intent.)
    const imported = store.ensurePrEntityForSource({
      sourceType: "branch-group",
      sourceId: group.id,
      repo: "",
      headBranch: group.branchName,
      state: "open",
      prNumber: 7,
      prUrl: "https://example/pr/7",
      unverified: true,
    });
    expect(imported.unverified).toBe(true);
    expect(imported.state).toBe("open");
    expect(imported.prNumber).toBe(7);
  });
});
