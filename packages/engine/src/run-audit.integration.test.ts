/**
 * Run-Audit Engine Integration Tests
 *
 * These tests verify that engine mutation paths (executor, heartbeat, merger)
 * correctly emit audit events to the core TaskStore via the run-audit API.
 *
 * Key assertions:
 * - Engine operations correlate to concrete audit events under a single runId
 * - All three domains (git, database, filesystem) emit events
 * - Non-empty mutationType/target and domain-appropriate metadata
 * - No-context paths are no-ops (no throw)
 * - Partial metadata normalization is deterministic
 *
 * Run with: pnpm --filter @fusion/engine exec vitest run src/run-audit.integration.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TaskStore } from "@fusion/core";
import { Database } from "@fusion/core";
import { TaskStore as CoreTaskStore } from "@fusion/core";
import { createRunAuditor, generateSyntheticRunId, type EngineRunContext, type RunAuditor } from "./run-audit.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "fn-engine-audit-integration-test-"));
}

describe("Run Audit Engine Integration", () => {
  let rootDir: string;
  let kbDir: string;
  let db: Database;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = makeTmpDir();
    kbDir = join(rootDir, ".fusion");
    db = new Database(kbDir);
    db.init();
    store = new CoreTaskStore(rootDir);
    await store.init();

    // Initialize git repo for engine tests that need it
    const gitDir = join(rootDir, ".git");
    if (!existsSync(gitDir)) {
      mkdirSync(gitDir, { recursive: true });
    }
  });

  afterEach(async () => {
    try {
      store.close();
    } catch {
      // ignore
    }
    try {
      db.close();
    } catch {
      // ignore
    }
    await rm(rootDir, { recursive: true, force: true });
  });

  describe("createRunAuditor with EngineRunContext", () => {
    it("creates auditor that emits git-domain events", async () => {
      const context: EngineRunContext = {
        runId: "engine-git-run-001",
        agentId: "agent-engine",
        taskId: "FN-ENG-001",
        phase: "execute",
      };

      const auditor = createRunAuditor(store, context);
      await auditor.git({
        type: "worktree:create",
        target: ".worktrees/engine-task",
        metadata: { branch: "fusion/engine-task" },
      });

      const events = store.getRunAuditEvents({ runId: context.runId });
      expect(events).toHaveLength(1);

      const event = events[0];
      expect(event.domain).toBe("git");
      expect(event.mutationType).toBe("worktree:create");
      expect(event.target).toBe(".worktrees/engine-task");
      expect(event.runId).toBe(context.runId);
      expect(event.agentId).toBe(context.agentId);
      expect(event.taskId).toBe(context.taskId);
      expect(event.metadata).toEqual({
        phase: "execute",
        branch: "fusion/engine-task",
      });
    });

    it("creates auditor that emits database-domain events", async () => {
      const context: EngineRunContext = {
        runId: "engine-db-run-001",
        agentId: "agent-engine",
        taskId: "FN-ENG-002",
        phase: "execute",
      };

      const auditor = createRunAuditor(store, context);
      await auditor.database({
        type: "task:update",
        target: "FN-ENG-002",
        metadata: { updatedFields: ["status"] },
      });

      const events = store.getRunAuditEvents({ runId: context.runId });
      expect(events).toHaveLength(1);

      const event = events[0];
      expect(event.domain).toBe("database");
      expect(event.mutationType).toBe("task:update");
      expect(event.target).toBe("FN-ENG-002");
      expect(event.taskId).toBe("FN-ENG-002"); // Task ID inferred from target
      expect(event.metadata).toEqual({
        phase: "execute",
        updatedFields: ["status"],
      });
    });

    it("creates auditor that emits filesystem-domain events", async () => {
      const context: EngineRunContext = {
        runId: "engine-fs-run-001",
        agentId: "agent-engine",
        taskId: "FN-ENG-003",
        phase: "execute",
      };

      const auditor = createRunAuditor(store, context);
      await auditor.filesystem({
        type: "file:write",
        target: "src/engine-test.ts",
        metadata: { size: 1234 },
      });

      const events = store.getRunAuditEvents({ runId: context.runId });
      expect(events).toHaveLength(1);

      const event = events[0];
      expect(event.domain).toBe("filesystem");
      expect(event.mutationType).toBe("file:write");
      expect(event.target).toBe("src/engine-test.ts");
      expect(event.metadata).toEqual({
        phase: "execute",
        size: 1234,
      });
    });

    it("emits multiple events across all domains under single runId", async () => {
      const context: EngineRunContext = {
        runId: "engine-multi-domain-001",
        agentId: "agent-multi",
        taskId: "FN-ENG-004",
        phase: "execute",
      };

      const auditor = createRunAuditor(store, context);

      // Emit events across all three domains
      await auditor.git({ type: "worktree:create", target: "worktrees/test" });
      await auditor.database({ type: "task:update", target: "FN-ENG-004" });
      await auditor.filesystem({ type: "file:write", target: "src/test.ts" });

      const events = store.getRunAuditEvents({ runId: context.runId });
      expect(events).toHaveLength(3);

      const domains = events.map((e) => e.domain);
      expect(domains).toContain("git");
      expect(domains).toContain("database");
      expect(domains).toContain("filesystem");

      // All events have the same runId and agentId
      events.forEach((event) => {
        expect(event.runId).toBe(context.runId);
        expect(event.agentId).toBe(context.agentId);
      });
    });
  });

  describe("generateSyntheticRunId", () => {
    it("generates unique IDs for different runs", () => {
      const id1 = generateSyntheticRunId("exec", "FN-001");
      const id2 = generateSyntheticRunId("exec", "FN-002");
      const id3 = generateSyntheticRunId("merge", "FN-001");

      expect(id1).not.toBe(id2);
      expect(id1).not.toBe(id3);
      expect(id2).not.toBe(id3);
    });

    it("includes prefix, taskId, timestamp, and random in format", () => {
      const id = generateSyntheticRunId("exec", "FNTEST");
      // Split from end to handle taskId with dashes correctly
      // Format: prefix-taskId-timestamp-random
      const lastDashIndex = id.lastIndexOf("-");
      const secondLastDashIndex = id.lastIndexOf("-", lastDashIndex - 1);

      // Extract parts by working backwards
      const random = id.slice(lastDashIndex + 1);
      const timestamp = id.slice(secondLastDashIndex + 1, lastDashIndex);
      const prefix = id.slice(0, id.indexOf("-"));

      expect(id.startsWith("exec-")).toBe(true);
      expect(parseInt(timestamp)).toBeGreaterThan(0); // timestamp
      expect(random.length).toBe(4); // random suffix

      // The ID contains the taskId between prefix and timestamp
      expect(id).toContain("exec-");
      expect(id).toContain(`-${timestamp}-`);
    });

    it("generates IDs suitable for run correlation", () => {
      const execId = generateSyntheticRunId("exec", "FN001");
      const mergeId = generateSyntheticRunId("merge", "FN001");

      // IDs should be different for different phases
      expect(execId).not.toBe(mergeId);

      // Both should start with their respective prefixes
      expect(execId.startsWith("exec-")).toBe(true);
      expect(mergeId.startsWith("merge-")).toBe(true);

      // IDs should be different for different tasks
      const execId2 = generateSyntheticRunId("exec", "FN002");
      expect(execId).not.toBe(execId2);
    });
  });

  describe("no-context path regression", () => {
    it("auditor is no-op when context is null", async () => {
      const auditor = createRunAuditor(store, null);

      // Should not throw
      await expect(auditor.git({ type: "worktree:create", target: "test" })).resolves.not.toThrow();
      await expect(auditor.database({ type: "task:update", target: "FN-001" })).resolves.not.toThrow();
      await expect(auditor.filesystem({ type: "file:write", target: "test.ts" })).resolves.not.toThrow();

      // No events should be recorded
      const events = store.getRunAuditEvents();
      expect(events).toHaveLength(0);
    });

    it("auditor is no-op when context is undefined", async () => {
      const auditor = createRunAuditor(store, undefined);

      await expect(auditor.git({ type: "worktree:create", target: "test" })).resolves.not.toThrow();
      await expect(auditor.database({ type: "task:update", target: "FN-001" })).resolves.not.toThrow();
      await expect(auditor.filesystem({ type: "file:write", target: "test.ts" })).resolves.not.toThrow();

      const events = store.getRunAuditEvents();
      expect(events).toHaveLength(0);
    });

    it("createRunAuditor handles store without recordRunAuditEvent gracefully", () => {
      // Mock a store without recordRunAuditEvent
      const mockStore = {
        // Missing recordRunAuditEvent method
      } as any;

      const context: EngineRunContext = {
        runId: "no-method-run",
        agentId: "agent-no-method",
      };

      const auditor = createRunAuditor(mockStore, context);

      // Should not throw - use a valid mutation type
      expect(() => auditor.git({ type: "branch:create", target: "t" })).not.toThrow();
    });
  });

  describe("partial metadata normalization", () => {
    it("normalizes git mutation with minimal metadata", async () => {
      const context: EngineRunContext = {
        runId: "git-minimal-meta",
        agentId: "agent-minimal",
        taskId: "FN-MINIMAL",
        phase: "execute",
      };

      const auditor = createRunAuditor(store, context);

      // Only type and target, no metadata
      await auditor.git({
        type: "branch:create",
        target: "feature/test",
      });

      const events = store.getRunAuditEvents({ runId: context.runId });
      expect(events).toHaveLength(1);

      const event = events[0];
      expect(event.domain).toBe("git");
      expect(event.mutationType).toBe("branch:create");
      expect(event.target).toBe("feature/test");
      expect(event.metadata).toEqual({ phase: "execute" }); // Only phase added
    });

    it("normalizes database mutation with minimal metadata", async () => {
      const context: EngineRunContext = {
        runId: "db-minimal-meta",
        agentId: "agent-minimal",
        taskId: "FN-DB-MINIMAL",
        phase: "execute",
      };

      const auditor = createRunAuditor(store, context);

      await auditor.database({
        type: "task:log-entry",
        target: "FN-DB-MINIMAL",
      });

      const events = store.getRunAuditEvents({ runId: context.runId });
      expect(events).toHaveLength(1);

      const event = events[0];
      expect(event.domain).toBe("database");
      expect(event.mutationType).toBe("task:log-entry");
      expect(event.metadata).toEqual({ phase: "execute" });
    });

    it("normalizes filesystem mutation with minimal metadata", async () => {
      const context: EngineRunContext = {
        runId: "fs-minimal-meta",
        agentId: "agent-minimal",
        taskId: "FN-FS-MINIMAL",
        phase: "execute",
      };

      const auditor = createRunAuditor(store, context);

      await auditor.filesystem({
        type: "file:write",
        target: "src/test.ts",
      });

      const events = store.getRunAuditEvents({ runId: context.runId });
      expect(events).toHaveLength(1);

      const event = events[0];
      expect(event.domain).toBe("filesystem");
      expect(event.mutationType).toBe("file:write");
      expect(event.metadata).toEqual({ phase: "execute" });
    });

    it("preserves source field when provided in context", async () => {
      const context: EngineRunContext = {
        runId: "with-source",
        agentId: "agent-source",
        taskId: "FN-SOURCE",
        phase: "heartbeat",
        source: "timer",
      };

      const auditor = createRunAuditor(store, context);

      await auditor.database({
        type: "task:update",
        target: "FN-SOURCE",
        metadata: { field: "value" },
      });

      const events = store.getRunAuditEvents({ runId: context.runId });
      expect(events).toHaveLength(1);

      const event = events[0];
      expect(event.metadata).toEqual({
        phase: "heartbeat",
        source: "timer",
        field: "value",
      });
    });

    it("spreads additional metadata fields correctly", async () => {
      const context: EngineRunContext = {
        runId: "metadata-spread",
        agentId: "agent-spread",
        taskId: "FN-SPREAD",
        phase: "execute",
      };

      const auditor = createRunAuditor(store, context);

      await auditor.git({
        type: "commit:create",
        target: "abc123",
        metadata: {
          filesChanged: 5,
          insertions: 100,
          deletions: 20,
          author: "test",
        },
      });

      const events = store.getRunAuditEvents({ runId: context.runId });
      expect(events).toHaveLength(1);

      const event = events[0];
      expect(event.metadata).toEqual({
        phase: "execute",
        filesChanged: 5,
        insertions: 100,
        deletions: 20,
        author: "test",
      });
    });
  });

  describe("event metadata completeness", () => {
    it("verifies all required fields are present in engine-emitted events", async () => {
      const context: EngineRunContext = {
        runId: "complete-fields",
        agentId: "agent-complete",
        taskId: "FN-COMPLETE",
        phase: "execute",
      };

      const auditor = createRunAuditor(store, context);
      await auditor.database({
        type: "task:create",
        target: "FN-COMPLETE",
        metadata: { description: "Test task" },
      });

      const events = store.getRunAuditEvents({ runId: context.runId });
      expect(events).toHaveLength(1);

      const event = events[0];

      // All required fields present
      expect(event.id).toBeDefined();
      expect(event.timestamp).toBeDefined();
      expect(event.runId).toBe(context.runId);
      expect(event.agentId).toBe(context.agentId);
      expect(event.taskId).toBe(context.taskId);
      expect(event.domain).toBe("database");
      expect(event.mutationType).toBe("task:create");
      expect(event.target).toBe("FN-COMPLETE");

      // Non-empty values
      expect(typeof event.id).toBe("string");
      expect(event.id.length).toBeGreaterThan(0);
      expect(typeof event.timestamp).toBe("string");
      expect(event.timestamp.length).toBeGreaterThan(0);
    });

    it("verifies mutationType is non-empty in all events", async () => {
      const context: EngineRunContext = {
        runId: "nonempty-mutation",
        agentId: "agent-nonempty",
        taskId: "FN-NONEMPTY",
      };

      const auditor = createRunAuditor(store, context);

      const mutationTypes = [
        "worktree:create",
        "worktree:remove",
        "branch:create",
        "branch:delete",
        "commit:create",
        "task:create",
        "task:update",
        "task:move",
        "task:log-entry",
        "task:comment:add",
        "task:assign",
        "file:write",
        "file:delete",
        "attachment:create",
        "prompt:write",
      ];

      for (const type of mutationTypes) {
        await auditor.git({ type: type as any, target: "test" });
      }

      const events = store.getRunAuditEvents({ runId: context.runId });
      events.forEach((event) => {
        expect(event.mutationType).toBeTruthy();
        expect(event.mutationType.length).toBeGreaterThan(0);
      });
    });

    it("verifies target is non-empty in all events", async () => {
      const context: EngineRunContext = {
        runId: "nonempty-target",
        agentId: "agent-target",
        taskId: "FN-TARGET",
      };

      const auditor = createRunAuditor(store, context);

      await auditor.git({ type: "worktree:create", target: ".worktrees/test" });
      await auditor.database({ type: "task:update", target: "FN-TARGET" });
      await auditor.filesystem({ type: "file:write", target: "src/test.ts" });

      const events = store.getRunAuditEvents({ runId: context.runId });
      events.forEach((event) => {
        expect(event.target).toBeTruthy();
        expect(typeof event.target).toBe("string");
        expect(event.target.length).toBeGreaterThan(0);
      });
    });
  });

  describe("heartbeat source correlation", () => {
    it("correlates heartbeat events with source field", async () => {
      const context: EngineRunContext = {
        runId: "heartbeat-timer-run",
        agentId: "agent-heartbeat",
        taskId: "FN-HB-001",
        phase: "heartbeat",
        source: "timer",
      };

      const auditor = createRunAuditor(store, context);
      await auditor.database({
        type: "task:log-entry",
        target: "FN-HB-001",
        metadata: { action: "heartbeat check" },
      });

      const events = store.getRunAuditEvents({ runId: context.runId });
      expect(events).toHaveLength(1);
      expect(events[0].metadata).toEqual({
        phase: "heartbeat",
        source: "timer",
        action: "heartbeat check",
      });
    });

    it("correlates assignment-triggered heartbeat events", async () => {
      const context: EngineRunContext = {
        runId: "heartbeat-assignment-run",
        agentId: "agent-assignment",
        taskId: "FN-ASSIGN-001",
        phase: "heartbeat",
        source: "assignment",
      };

      const auditor = createRunAuditor(store, context);
      await auditor.database({
        type: "task:assign",
        target: "FN-ASSIGN-001",
        metadata: { assignedTo: "agent-assignment" },
      });

      const events = store.getRunAuditEvents({ runId: context.runId });
      expect(events).toHaveLength(1);
      expect(events[0].metadata).toEqual({
        phase: "heartbeat",
        source: "assignment",
        assignedTo: "agent-assignment",
      });
    });

    it("correlates on-demand heartbeat events", async () => {
      const context: EngineRunContext = {
        runId: "heartbeat-demand-run",
        agentId: "agent-demand",
        taskId: "FN-DEMAND-001",
        phase: "heartbeat",
        source: "on_demand",
      };

      const auditor = createRunAuditor(store, context);
      await auditor.database({
        type: "task:log-entry",
        target: "FN-DEMAND-001",
      });

      const events = store.getRunAuditEvents({ runId: context.runId });
      expect(events).toHaveLength(1);
      expect(events[0].metadata).toEqual({
        phase: "heartbeat",
        source: "on_demand",
      });
    });
  });

  describe("merge phase correlation", () => {
    it("correlates merge events with merge phase", async () => {
      const context: EngineRunContext = {
        runId: "merge-run-001",
        agentId: "merger",
        taskId: "FN-MERGE-001",
        phase: "merge",
      };

      const auditor = createRunAuditor(store, context);
      await auditor.git({
        type: "merge:resolve",
        target: "fusion/FN-MERGE-001",
        metadata: { strategy: "squash" },
      });

      const events = store.getRunAuditEvents({ runId: context.runId });
      expect(events).toHaveLength(1);
      expect(events[0].domain).toBe("git");
      expect(events[0].mutationType).toBe("merge:resolve");
      expect(events[0].metadata).toEqual({
        phase: "merge",
        strategy: "squash",
      });
    });

    it("supports merge attempt differentiation", async () => {
      const context: EngineRunContext = {
        runId: "merge-attempt-1",
        agentId: "merger",
        taskId: "FN-MERGE-002",
        phase: "merge-attempt-1",
      };

      const auditor = createRunAuditor(store, context);
      await auditor.git({
        type: "merge:start",
        target: "fusion/FN-MERGE-002",
      });

      const events = store.getRunAuditEvents({ runId: context.runId });
      expect(events).toHaveLength(1);
      expect(events[0].metadata).toEqual({
        phase: "merge-attempt-1",
      });
    });
  });

  describe("deterministic ordering of engine-emitted events", () => {
    it("orders multiple events by timestamp DESC, rowid DESC", async () => {
      const context: EngineRunContext = {
        runId: "ordering-test",
        agentId: "agent-order",
        taskId: "FN-ORDER",
        phase: "execute",
      };

      const auditor = createRunAuditor(store, context);

      // Emit events in sequence
      await auditor.git({ type: "branch:create", target: "branch-1" });
      await auditor.database({ type: "task:update", target: "FN-ORDER" });
      await auditor.filesystem({ type: "file:write", target: "file-1.ts" });
      await auditor.git({ type: "commit:create", target: "commit-1" });

      const events = store.getRunAuditEvents({ runId: context.runId });

      // Should be ordered newest first
      expect(events[0].mutationType).toBe("commit:create");
      expect(events[1].mutationType).toBe("file:write");
      expect(events[2].mutationType).toBe("task:update");
      expect(events[3].mutationType).toBe("branch:create");
    });

    it("maintains stable ordering across repeated queries", async () => {
      const context: EngineRunContext = {
        runId: "stable-order",
        agentId: "agent-stable",
        taskId: "FN-STABLE",
        phase: "execute",
      };

      const auditor = createRunAuditor(store, context);

      for (let i = 0; i < 10; i++) {
        await auditor.database({
          type: "task:log-entry",
          target: `FN-STABLE`,
          metadata: { index: i },
        });
      }

      // Query multiple times
      const events1 = store.getRunAuditEvents({ runId: context.runId });
      const events2 = store.getRunAuditEvents({ runId: context.runId });
      const events3 = store.getRunAuditEvents({ runId: context.runId });

      // Order should be consistent
      expect(events1.map((e) => e.id)).toEqual(events2.map((e) => e.id));
      expect(events2.map((e) => e.id)).toEqual(events3.map((e) => e.id));

      // Newest first (index: 9 first due to autoincrement rowid DESC)
      expect(events1[0].metadata).toEqual({ phase: "execute", index: 9 });
      expect(events1[9].metadata).toEqual({ phase: "execute", index: 0 });
    });
  });
});
