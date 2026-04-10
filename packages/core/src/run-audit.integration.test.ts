/**
 * Run-Audit Core Integration Tests
 *
 * These tests verify end-to-end run-audit functionality across the core API:
 * - Multi-domain event correlation under a single runId
 * - Complete event shape verification
 * - Absent run context handling (backward compatibility)
 * - Partial metadata normalization
 * - Deterministic duplicate-timestamp ordering
 *
 * Run with: pnpm --filter @fusion/core exec vitest run src/run-audit.integration.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "./db.js";
import { TaskStore } from "./store.js";
import type { RunAuditEventInput, RunAuditEvent } from "./types.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "fn-run-audit-integration-test-"));
}

describe("Run Audit Integration", () => {
  let rootDir: string;
  let kbDir: string;
  let db: Database;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = makeTmpDir();
    kbDir = join(rootDir, ".fusion");
    db = new Database(kbDir);
    db.init();
    store = new TaskStore(rootDir);
    await store.init();
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

  describe("multi-domain event correlation", () => {
    it("correlates git, database, and filesystem events under a single runId", () => {
      const runId = "integration-test-run-001";
      const agentId = "agent-integration";
      const taskId = "FN-INTEG-001";

      // Record events across all three domains
      store.recordRunAuditEvent({
        runId,
        agentId,
        taskId,
        domain: "git",
        mutationType: "worktree:create",
        target: ".worktrees/integration-task",
        metadata: { branch: "fusion/integration-task" },
      });

      store.recordRunAuditEvent({
        runId,
        agentId,
        taskId,
        domain: "database",
        mutationType: "task:update",
        target: taskId,
        metadata: { updatedFields: ["status"] },
      });

      store.recordRunAuditEvent({
        runId,
        agentId,
        taskId,
        domain: "filesystem",
        mutationType: "file:write",
        target: "src/integration.ts",
        metadata: { size: 1234 },
      });

      // Query by runId
      const events = store.getRunAuditEvents({ runId });

      // All three domains should be present
      expect(events).toHaveLength(3);
      const domains = events.map((e) => e.domain);
      expect(domains).toContain("git");
      expect(domains).toContain("database");
      expect(domains).toContain("filesystem");
    });

    it("returns events ordered by timestamp DESC, rowid DESC", () => {
      const runId = "integration-test-run-002";

      // Insert in reverse order (oldest first in IDs due to autoincrement)
      store.recordRunAuditEvent({
        timestamp: "2025-01-01T01:00:00.000Z",
        runId,
        agentId: "agent-x",
        domain: "database",
        mutationType: "first",
        target: "t1",
      });
      store.recordRunAuditEvent({
        timestamp: "2025-01-01T01:00:00.000Z", // Same timestamp
        runId,
        agentId: "agent-y",
        domain: "git",
        mutationType: "second",
        target: "t2",
      });
      store.recordRunAuditEvent({
        timestamp: "2025-01-01T02:00:00.000Z",
        runId,
        agentId: "agent-z",
        domain: "filesystem",
        mutationType: "third",
        target: "t3",
      });

      const events = store.getRunAuditEvents({ runId });

      // Newest first (timestamp DESC)
      expect(events[0].mutationType).toBe("third");
      expect(events[1].mutationType).toBe("second"); // rowid DESC tiebreaker: second inserted last
      expect(events[2].mutationType).toBe("first");
    });

    it("filters by domain correctly", () => {
      const runId = "integration-test-run-003";

      store.recordRunAuditEvent({
        runId,
        agentId: "agent-1",
        domain: "git",
        mutationType: "commit:create",
        target: "main",
      });
      store.recordRunAuditEvent({
        runId,
        agentId: "agent-1",
        domain: "database",
        mutationType: "task:update",
        target: "FN-001",
      });
      store.recordRunAuditEvent({
        runId,
        agentId: "agent-1",
        domain: "filesystem",
        mutationType: "file:write",
        target: "src/test.ts",
      });

      const gitEvents = store.getRunAuditEvents({ runId, domain: "git" });
      expect(gitEvents).toHaveLength(1);
      expect(gitEvents[0].domain).toBe("git");
    });
  });

  describe("complete event shape verification", () => {
    it("verifies all required fields are present in persisted events", () => {
      const input: RunAuditEventInput = {
        taskId: "FN-SHAPE-001",
        agentId: "agent-shape",
        runId: "run-shape-001",
        domain: "database",
        mutationType: "task:create",
        target: "FN-SHAPE-001",
        metadata: { source: "integration-test" },
      };

      const event = store.recordRunAuditEvent(input);
      const events = store.getRunAuditEvents({ runId: input.runId });

      expect(events).toHaveLength(1);
      const persisted = events[0];

      // Verify complete shape
      expect(persisted.id).toBeDefined();
      expect(typeof persisted.id).toBe("string");
      expect(persisted.timestamp).toBeDefined();
      expect(typeof persisted.timestamp).toBe("string");
      expect(persisted.runId).toBe(input.runId);
      expect(persisted.agentId).toBe(input.agentId);
      expect(persisted.taskId).toBe(input.taskId);
      expect(persisted.domain).toBe(input.domain);
      expect(persisted.mutationType).toBe(input.mutationType);
      expect(persisted.target).toBe(input.target);
      expect(persisted.metadata).toEqual(input.metadata);
    });

    it("handles events without optional fields gracefully", () => {
      const input: RunAuditEventInput = {
        agentId: "agent-minimal",
        runId: "run-minimal-001",
        domain: "database",
        mutationType: "task:log",
        target: "FN-MINIMAL-001",
        // No taskId, no metadata
      };

      const event = store.recordRunAuditEvent(input);
      const events = store.getRunAuditEvents({ runId: input.runId });

      expect(events).toHaveLength(1);
      const persisted = events[0];

      // Required fields present
      expect(persisted.id).toBeDefined();
      expect(persisted.timestamp).toBeDefined();
      expect(persisted.runId).toBe(input.runId);
      expect(persisted.agentId).toBe(input.agentId);
      expect(persisted.domain).toBe(input.domain);
      expect(persisted.mutationType).toBe(input.mutationType);
      expect(persisted.target).toBe(input.target);

      // Optional fields undefined
      expect(persisted.taskId).toBeUndefined();
      expect(persisted.metadata).toBeUndefined();
    });

    it("preserves metadata with nested objects", () => {
      const complexMetadata = {
        filesChanged: 5,
        details: { insertions: 100, deletions: 20 },
        array: ["a", "b", "c"],
        nested: { deep: { value: 42 } },
      };

      store.recordRunAuditEvent({
        runId: "run-complex-meta",
        agentId: "agent-complex",
        domain: "git",
        mutationType: "commit:create",
        target: "feature/test",
        metadata: complexMetadata,
      });

      const events = store.getRunAuditEvents({ runId: "run-complex-meta" });
      expect(events[0].metadata).toEqual(complexMetadata);
    });
  });

  describe("absent run context regression", () => {
    it("recordRunAuditEvent works with minimal required fields", () => {
      // Even without explicit timestamp or full context, should not crash
      const event = store.recordRunAuditEvent({
        agentId: "agent-regression",
        runId: "run-regression-001",
        domain: "database",
        mutationType: "task:log",
        target: "FN-REG-001",
      });

      expect(event.id).toBeDefined();
      expect(event.timestamp).toBeDefined();
      expect(event.runId).toBe("run-regression-001");
    });

    it("getRunAuditEvents with empty filter returns all events", () => {
      // No filters should return all events (or empty if none exist)
      const events = store.getRunAuditEvents();
      expect(Array.isArray(events)).toBe(true);
    });

    it("getRunAuditEvents with non-existent runId returns empty array", () => {
      const events = store.getRunAuditEvents({ runId: "non-existent-run-id" });
      expect(events).toHaveLength(0);
    });

    it("getRunAuditEvents with invalid domain does not crash", () => {
      // Should return empty or filter correctly (no throw)
      const events = store.getRunAuditEvents({ domain: "invalid-domain" as any });
      expect(Array.isArray(events)).toBe(true);
      // Empty because domain filter won't match any valid domains
      expect(events.length).toBe(0);
    });
  });

  describe("partial metadata normalization", () => {
    it("preserves empty string metadata values", () => {
      const event = store.recordRunAuditEvent({
        runId: "run-normalize-001",
        agentId: "agent-norm",
        domain: "database",
        mutationType: "task:update",
        target: "FN-NORM-001",
        metadata: { emptyString: "", valid: "value" },
      });

      const events = store.getRunAuditEvents({ runId: "run-normalize-001" });
      // Empty strings are preserved as-is (no automatic normalization to undefined)
      expect(events[0].metadata).toEqual({ emptyString: "", valid: "value" });
    });

    it("handles null metadata gracefully", () => {
      const event = store.recordRunAuditEvent({
        runId: "run-null-meta",
        agentId: "agent-null",
        domain: "database",
        mutationType: "task:create",
        target: "FN-NULL-001",
        metadata: null as any, // Intentional: should handle gracefully
      });

      // Event should be persisted with null metadata
      expect(event.id).toBeDefined();
      expect(event.metadata).toBeNull();

      // Verify event can be queried
      const events = store.getRunAuditEvents({ runId: "run-null-meta" });
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe(event.id);
    });

    it("records events with undefined metadata", () => {
      const event = store.recordRunAuditEvent({
        runId: "run-undefined-meta",
        agentId: "agent-und",
        domain: "git",
        mutationType: "commit:create",
        target: "main",
        // No metadata field at all
      });

      const events = store.getRunAuditEvents({ runId: "run-undefined-meta" });
      expect(events[0].metadata).toBeUndefined();
    });

    it("preserves metadata with special characters", () => {
      const event = store.recordRunAuditEvent({
        runId: "run-special",
        agentId: "agent-special",
        domain: "filesystem",
        mutationType: "file:write",
        target: "path/with spaces & 'special' chars.txt",
        metadata: {
          description: "Test with émojis 🎉 and unicode ñ",
          path: "C:\\Users\\Test\\file.ts",
        },
      });

      const events = store.getRunAuditEvents({ runId: "run-special" });
      expect(events[0].metadata).toEqual({
        description: "Test with émojis 🎉 and unicode ñ",
        path: "C:\\Users\\Test\\file.ts",
      });
    });
  });

  describe("duplicate timestamp ordering regression", () => {
    it("orders events with identical timestamps deterministically using rowid", () => {
      const runId = "run-duplicate-ts";
      const sameTs = "2025-06-15T12:00:00.000Z";

      // Insert multiple events with identical timestamps
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const event = store.recordRunAuditEvent({
          timestamp: sameTs,
          runId,
          agentId: `agent-${i}`,
          domain: "database",
          mutationType: `event-${i}`,
          target: `target-${i}`,
        });
        ids.push(event.id);
      }

      // Query and verify deterministic order
      const events1 = store.getRunAuditEvents({ runId });
      const events2 = store.getRunAuditEvents({ runId }); // Query again

      // Same order on repeated queries
      expect(events1.map((e) => e.mutationType)).toEqual(events2.map((e) => e.mutationType));

      // Rowid DESC means newest row first (later IDs first for autoincrement)
      expect(events1[0].mutationType).toBe("event-4"); // Last inserted
      expect(events1[4].mutationType).toBe("event-0"); // First inserted
    });

    it("handles many events with same timestamp stably", () => {
      const runId = "run-many-same-ts";
      const sameTs = "2025-06-15T12:00:00.000Z";

      // Insert 20 events with same timestamp
      for (let i = 0; i < 20; i++) {
        store.recordRunAuditEvent({
          timestamp: sameTs,
          runId,
          agentId: `agent-${i}`,
          domain: "database",
          mutationType: `type-${i}`,
          target: `FN-${String(i).padStart(3, "0")}`,
        });
      }

      const events = store.getRunAuditEvents({ runId });

      // All 20 events present
      expect(events).toHaveLength(20);

      // Order is stable and deterministic
      const order1 = events.map((e) => e.mutationType);
      const eventsAgain = store.getRunAuditEvents({ runId });
      const order2 = eventsAgain.map((e) => e.mutationType);
      expect(order1).toEqual(order2);

      // Each mutation type appears exactly once
      const uniqueTypes = new Set(events.map((e) => e.mutationType));
      expect(uniqueTypes.size).toBe(20);
    });

    it("maintains ordering across query limit", () => {
      const runId = "run-limit-order";
      const sameTs = "2025-06-15T12:00:00.000Z";

      // Insert 10 events with same timestamp
      for (let i = 0; i < 10; i++) {
        store.recordRunAuditEvent({
          timestamp: sameTs,
          runId,
          agentId: `agent-${i}`,
          domain: "database",
          mutationType: `type-${i}`,
          target: `FN-${i}`,
        });
      }

      // Query with limit - should get the newest first (rowid DESC)
      const limited = store.getRunAuditEvents({ runId, limit: 5 });
      expect(limited).toHaveLength(5);
      expect(limited[0].mutationType).toBe("type-9"); // Newest first
      expect(limited[4].mutationType).toBe("type-5");

      // Query all and verify order consistency
      const all = store.getRunAuditEvents({ runId });
      expect(all[0].mutationType).toBe("type-9");
      expect(all[9].mutationType).toBe("type-0");
    });
  });

  describe("event metadata completeness", () => {
    it("asserts non-empty mutationType in results", () => {
      const eventTypes = [
        "task:create",
        "task:update",
        "task:move",
        "git:commit",
        "file:write",
        "worktree:create",
      ];

      const runId = "run-complete-001";
      eventTypes.forEach((type) => {
        store.recordRunAuditEvent({
          runId,
          agentId: "agent-check",
          domain: type.startsWith("git") ? "git" : type.startsWith("file") || type.startsWith("worktree") ? "filesystem" : "database",
          mutationType: type,
          target: "test-target",
        });
      });

      const events = store.getRunAuditEvents({ runId });

      events.forEach((event) => {
        expect(event.mutationType).toBeTruthy();
        expect(event.mutationType.length).toBeGreaterThan(0);
      });
    });

    it("asserts non-empty target in results", () => {
      const runId = "run-target-001";
      store.recordRunAuditEvent({
        runId,
        agentId: "agent-target",
        domain: "database",
        mutationType: "task:create",
        target: "FN-TARGET-001",
      });

      const events = store.getRunAuditEvents({ runId });
      events.forEach((event) => {
        expect(event.target).toBeTruthy();
        expect(typeof event.target).toBe("string");
      });
    });

    it("verifies domain is one of valid values", () => {
      const validDomains = ["database", "git", "filesystem"];
      const runId = "run-domain-valid";

      validDomains.forEach((domain) => {
        store.recordRunAuditEvent({
          runId,
          agentId: "agent-domain",
          domain: domain as any,
          mutationType: "test",
          target: "test",
        });
      });

      const events = store.getRunAuditEvents({ runId });
      events.forEach((event) => {
        expect(validDomains).toContain(event.domain);
      });
    });
  });

  describe("integration with TaskStore operations", () => {
    it("task operations can emit correlated audit events", async () => {
      const task = await store.createTask({ description: "Integration test task" });
      const runId = "run-store-integration";

      // Simulate engine operations with run context
      await store.logEntry(task.id, "Test action", undefined, { runId, agentId: "agent-test" });
      await store.addComment(task.id, "Test comment", "user", undefined, { runId, agentId: "agent-test" });

      const events = store.getRunAuditEvents({ runId });

      // Should have logged events from both operations
      expect(events.length).toBeGreaterThanOrEqual(2);

      // All events should have the runId
      events.forEach((event) => {
        expect(event.runId).toBe(runId);
      });

      // Events should have domain and mutationType
      const domains = events.map((e) => e.domain);
      expect(domains).toContain("database");
    });

    it("pauseTask emits correlated audit event", async () => {
      const task = await store.createTask({ description: "Pause test task" });
      const runId = "run-pause-integration";

      await store.pauseTask(task.id, true, { runId, agentId: "agent-pause" });

      const events = store.getRunAuditEvents({ runId });
      expect(events).toHaveLength(1);
      expect(events[0].domain).toBe("database");
      expect(events[0].mutationType).toBe("task:pause");
      expect(events[0].target).toBe(task.id);
    });
  });
});
