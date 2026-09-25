import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "../../postgres/schema/index.js";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

/*
FNXC:VerificationWriteAhead 2026-08-31-00:00 (EXAM-010):
The executor tool path (fn_run_verification) previously persisted NOTHING, so
fn_task_verification_status answered "No verification request exists" for tasks
that had run dozens of executor verifications, and a killed executor left its
`running` row orphaned forever — blocking every later verification on that task
with "already in flight". These tests pin the write-ahead upsert, the CAS
stale-`running` reclaim, and the any-status latest-first read that fix both.

WHAT THESE PIN, measured against the pre-fix behavior:
  - write-ahead upsert (no row / terminal row / unclaimed chat row)      -> 3 assertions
  - stale reclaim CAS (old startedAt reclaims, fresh does not)           -> 2 assertions
  - concurrent claim race (exactly one winner)                           -> 1 assertion
  - status read returns terminal/stale records (never "no record")       -> 2 assertions
  - project scoping (a peer project's row is invisible)                  -> 1 assertion
*/

pgDescribe("Task verification request write-ahead lifecycle (PostgreSQL)", () => {
  /*
  FNXC:VerificationWriteAhead 2026-08-31-00:00:
  Bound to an explicit projectId: verification-scope filters (verificationScope /
  getTaskVerificationRequestAsyncImpl) only apply on a bound layer, and the project-
  isolation assertion below needs a real peer partition to prove invisibility.
  */
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_task_verif_wal", projectId: "verif_wal_project" });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /** Seed a `running` row with an arbitrary startedAt so staleness is expressible. */
  async function seedRunningRow(taskId: string, requestId: string, startedAt: string, projectId?: string) {
    await h.layer().db.insert(schema.project.taskVerificationRequests).values({
      ...(projectId ? { projectId } : {}),
      taskId,
      requestId,
      status: "running",
      profile: "verify:fast",
      command: "pnpm verify:fast",
      scope: "workspace",
      requestedBy: "executor",
      requestedAt: startedAt,
      startedAt,
    });
  }

  describe("create -> claim -> finish happy path (existing chat queue semantics unchanged)", () => {
    it("persists a chat request, claims it CAS-guarded, and finishes it with a result", async () => {
      const store = h.store();
      const task = await h.createTestTask();

      const created = await store.createTaskVerificationRequest({
        taskId: task.id,
        requestId: "req-chat-1",
        profile: "verify:fast",
        command: "pnpm verify:fast",
        scope: "workspace",
        requestedBy: "chat",
      });
      expect(created.request?.status).toBe("requested");
      expect(created.inFlightRequestId).toBeUndefined();

      const claimed = await store.claimTaskVerificationRequest(task.id, "req-chat-1");
      expect(claimed?.status).toBe("running");
      expect(claimed?.startedAt).toBeTruthy();

      const finished = await store.finishTaskVerificationRequest(task.id, "req-chat-1", "passed", {
        success: true, exitCode: 0, durationMs: 1_234, timedOut: false, stdoutTail: "ok", stderrTail: "",
      });
      expect(finished?.status).toBe("passed");
      expect(finished?.completedAt).toBeTruthy();
      expect(finished?.result?.exitCode).toBe(0);

      // A second create after terminal status is allowed (upsert replaces the row).
      const recreated = await store.createTaskVerificationRequest({
        taskId: task.id, requestId: "req-chat-2", profile: "verify:fast",
        command: "pnpm verify:fast", scope: "workspace", requestedBy: "chat",
      });
      expect(recreated.inFlightRequestId).toBeUndefined();
      expect(recreated.request?.status).toBe("requested");
    });

    it("refuses a duplicate create while requested or running (in-flight guard intact)", async () => {
      const store = h.store();
      const task = await h.createTestTask();
      await store.createTaskVerificationRequest({
        taskId: task.id, requestId: "req-inflight", profile: "verify:fast",
        command: "pnpm verify:fast", scope: "workspace", requestedBy: "chat",
      });
      const duplicate = await store.createTaskVerificationRequest({
        taskId: task.id, requestId: "req-inflight-2", profile: "verify:fast",
        command: "pnpm verify:fast", scope: "workspace", requestedBy: "chat",
      });
      expect(duplicate.inFlightRequestId).toBe("req-inflight");
      expect(duplicate.request).toBeUndefined();
    });
  });

  describe("executor write-ahead upsert", () => {
    it("creates a fresh running row when no record exists (the dropped-record defect)", async () => {
      const store = h.store();
      const task = await h.createTestTask();
      expect(await store.getTaskVerificationRequestAsync(task.id)).toBeNull();

      const wal = await store.upsertExecutorVerificationRequest({
        taskId: task.id, requestId: "req-exec-1", profile: "test-command",
        command: "pnpm --filter @x exec vitest run src/a.test.ts", scope: "package", requestedBy: "executor",
      });

      expect(wal.claimed).toBe(true);
      expect(wal.request.status).toBe("running");
      expect(wal.request.requestId).toBe("req-exec-1");
      expect(wal.request.startedAt).toBeTruthy();
      // The whole point of the fix: the record is now readable for a task whose
      // only verifications came from the executor tool path.
      const read = await store.getTaskVerificationRequestAsync(task.id);
      expect(read?.status).toBe("running");
      expect(read?.command).toContain("vitest");
    });

    it("replaces a terminal row and preserves nothing stale", async () => {
      const store = h.store();
      const task = await h.createTestTask();
      await store.createTaskVerificationRequest({
        taskId: task.id, requestId: "req-old", profile: "verify:fast",
        command: "pnpm verify:fast", scope: "workspace", requestedBy: "chat",
      });
      await store.claimTaskVerificationRequest(task.id, "req-old");
      await store.finishTaskVerificationRequest(task.id, "req-old", "failed", undefined, "previous run failed");

      const wal = await store.upsertExecutorVerificationRequest({
        taskId: task.id, requestId: "req-exec-2", profile: "test-command",
        command: "pnpm lint", scope: "workspace", requestedBy: "executor",
      });
      expect(wal.claimed).toBe(true);
      expect(wal.request.requestId).toBe("req-exec-2");
      expect(wal.request.status).toBe("running");
      expect(wal.request.rejectionReason).toBeUndefined();

      const read = await store.getTaskVerificationRequestAsync(task.id);
      expect(read?.status).toBe("running");
      expect(read?.rejectionReason).toBeFalsy();
    });

    it("claims an unclaimed chat request in place, preserving the chat requestId lineage", async () => {
      const store = h.store();
      const task = await h.createTestTask();
      await store.createTaskVerificationRequest({
        taskId: task.id, requestId: "req-chat-lineage", profile: "verify:fast",
        command: "pnpm verify:fast", scope: "workspace", requestedBy: "chat",
      });

      const wal = await store.upsertExecutorVerificationRequest({
        taskId: task.id, requestId: "req-exec-3", profile: "test-command",
        command: "pnpm lint", scope: "workspace", requestedBy: "executor",
      });
      // Claimed the existing unclaimed row — NOT clobbered with a new requestId.
      expect(wal.claimed).toBe(true);
      expect(wal.request.requestId).toBe("req-chat-lineage");
      expect(wal.request.status).toBe("running");
      expect(wal.request.requestedBy).toBe("chat");

      const rows = await h.layer().db.select().from(schema.project.taskVerificationRequests)
        .where(eq(schema.project.taskVerificationRequests.taskId, task.id));
      expect(rows).toHaveLength(1);
    });

    it("returns in-flight (never steals) when the row is already running", async () => {
      const store = h.store();
      const task = await h.createTestTask();
      await seedRunningRow(task.id, "req-live", new Date().toISOString());

      const wal = await store.upsertExecutorVerificationRequest({
        taskId: task.id, requestId: "req-exec-4", profile: "test-command",
        command: "pnpm lint", scope: "workspace", requestedBy: "executor",
      });
      expect(wal.claimed).toBe(false);
      expect(wal.reason).toBe("in-flight");
      expect(wal.request.requestId).toBe("req-live");
      expect(wal.request.status).toBe("running");
    });
  });

  describe("stale-`running` CAS reclaim", () => {
    it("reclaims a running row whose startedAt is older than the ceiling", async () => {
      const store = h.store();
      const task = await h.createTestTask();
      const staleStartedAt = new Date(Date.now() - 700_000).toISOString();
      await seedRunningRow(task.id, "req-dead", staleStartedAt);

      const reclaimed = await store.reclaimStaleTaskVerificationRequest(task.id, "req-dead", 600_000);
      expect(reclaimed?.status).toBe("failed");
      expect(reclaimed?.completedAt).toBeTruthy();
      expect(reclaimed?.rejectionReason).toContain("executor lost");
      expect(reclaimed?.rejectionReason).toContain("600000");

      // After reclaim the follow-up request path is unblocked: a new create succeeds.
      const next = await store.createTaskVerificationRequest({
        taskId: task.id, requestId: "req-after-reclaim", profile: "verify:fast",
        command: "pnpm verify:fast", scope: "workspace", requestedBy: "chat",
      });
      expect(next.inFlightRequestId).toBeUndefined();
      expect(next.request?.status).toBe("requested");
    });

    it("never steals a live executor's fresh running row (startedAt guard)", async () => {
      const store = h.store();
      const task = await h.createTestTask();
      await seedRunningRow(task.id, "req-live-fresh", new Date().toISOString());

      const reclaimed = await store.reclaimStaleTaskVerificationRequest(task.id, "req-live-fresh", 600_000);
      expect(reclaimed).toBeNull();

      const read = await store.getTaskVerificationRequestAsync(task.id);
      expect(read?.status).toBe("running");
    });

    it("never reaps a mismatched requestId even when the row is old", async () => {
      const store = h.store();
      const task = await h.createTestTask();
      await seedRunningRow(task.id, "req-old", new Date(Date.now() - 900_000).toISOString());

      const reclaimed = await store.reclaimStaleTaskVerificationRequest(task.id, "req-newer-generation", 600_000);
      expect(reclaimed).toBeNull();
      expect((await store.getTaskVerificationRequestAsync(task.id))?.status).toBe("running");
    });
  });

  describe("concurrent-claim race", () => {
    it("lets exactly one of two concurrent write-ahead upserts claim an unclaimed row", async () => {
      const store = h.store();
      const task = await h.createTestTask();
      await store.createTaskVerificationRequest({
        taskId: task.id, requestId: "req-race", profile: "verify:fast",
        command: "pnpm verify:fast", scope: "workspace", requestedBy: "chat",
      });

      const upsert = () => store.upsertExecutorVerificationRequest({
        taskId: task.id, requestId: `req-race-exec-${Math.random().toString(36).slice(2, 8)}`,
        profile: "test-command", command: "pnpm lint", scope: "workspace", requestedBy: "executor",
      });
      const [a, b] = await Promise.all([upsert(), upsert()]);

      const winners = [a, b].filter((r) => r.claimed);
      expect(winners).toHaveLength(1);
      // Whoever lost sees the live row in-flight, never a silently dropped outcome.
      const loser = [a, b].find((r) => !r.claimed)!;
      expect(loser.reason).toBe("in-flight");
      expect(loser.request.status).toBe("running");
      // The winner preserved the chat requestId lineage.
      expect(winners[0]!.request.requestId).toBe("req-race");
    });
  });

  describe("status read semantics", () => {
    it("returns the latest record in ANY status — stale/failed included, never a spurious null", async () => {
      const store = h.store();
      const task = await h.createTestTask();
      // No record yet: null is the honest answer for a task that never issued a call.
      expect(await store.getTaskVerificationRequestAsync(task.id)).toBeNull();

      await seedRunningRow(task.id, "req-stale", new Date(Date.now() - 900_000).toISOString());
      await store.reclaimStaleTaskVerificationRequest(task.id, "req-stale", 600_000);
      const read = await store.getTaskVerificationRequestAsync(task.id);
      expect(read?.status).toBe("failed");
      expect(read?.rejectionReason).toBeTruthy();
    });
  });

  describe("project scoping", () => {
    it("keeps a peer project's row invisible and never cross-keyed", async () => {
      const store = h.store();
      const task = await h.createTestTask();
      // Seed a row in a DIFFERENT project partition via raw insert.
      await h.layer().db.insert(schema.project.taskVerificationRequests).values({
        projectId: "peer-project",
        taskId: task.id,
        requestId: "req-peer",
        status: "running",
        profile: "verify:fast",
        command: "pnpm verify:fast",
        scope: "workspace",
        requestedBy: "chat",
        requestedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
      });

      // The store's own (unbound/test) partition sees nothing.
      expect(await store.getTaskVerificationRequestAsync(task.id)).toBeNull();

      // The executor write-ahead creates its own row in THIS partition, not the peer's.
      const wal = await store.upsertExecutorVerificationRequest({
        taskId: task.id, requestId: "req-scoped", profile: "test-command",
        command: "pnpm lint", scope: "workspace", requestedBy: "executor",
      });
      expect(wal.claimed).toBe(true);

      const peerRows = await h.adminDb().select().from(schema.project.taskVerificationRequests)
        .where(and(eq(schema.project.taskVerificationRequests.taskId, task.id), eq(schema.project.taskVerificationRequests.projectId, "peer-project")));
      expect(peerRows).toHaveLength(1);
      expect(peerRows[0]!.requestId).toBe("req-peer");
    });
  });
});

describe("task verification request lifecycle PostgreSQL availability", () => {
  it("fails closed when a required PostgreSQL probe would otherwise be skipped", async () => {
    if (process.env.FUSION_PG_REQUIRED === "1") {
      const { PG_AVAILABLE } = await import("../../__test-utils__/pg-test-harness.js");
      expect(PG_AVAILABLE).toBe(true);
    }
  });
});
