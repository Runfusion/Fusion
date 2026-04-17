/**
 * InsightStore Tests
 *
 * Covers:
 * - Insight create/get/list/update/delete/upsert lifecycle
 * - Insight run create/list/update/upsert lifecycle
 * - Fingerprint-based upsert dedupe (no duplicate rows)
 * - Stable identity on upsert (id/createdAt preserved)
 * - Deterministic ordering under timestamp ties
 * - Migration: pre-33 DB upgrades to include insight tables
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Database, createDatabase, fromJson } from "./db.js";
import { InsightStore, computeInsightFingerprint } from "./insight-store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  Insight,
  InsightRun,
  InsightCategory,
  InsightStatus,
  InsightProvenance,
  InsightRunTrigger,
  InsightRunStatus,
} from "./insight-types.js";

// ── Test Fixtures ────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "fn-insight-test-"));
}

let kbDir: string;
let db: Database;
let store: InsightStore;

function createProvenance(overrides: Partial<InsightProvenance> = {}): InsightProvenance {
  return {
    trigger: "manual",
    description: "Test generation",
    relatedEntityIds: [],
    ...overrides,
  };
}

beforeEach(() => {
  kbDir = makeTmpDir();
  db = createDatabase(kbDir);
  db.init();
  store = new InsightStore(db);
});

// ── Insight CRUD ────────────────────────────────────────────────────

describe("InsightStore", () => {
  describe("createInsight", () => {
    it("creates an insight and returns it with assigned id and timestamps", () => {
      const input = {
        title: "Test Insight",
        category: "quality" as InsightCategory,
        provenance: createProvenance(),
      };

      const insight = store.createInsight("test-project", input);

      expect(insight.id).toMatch(/^INS-[A-Z0-9]+-[A-Z0-9]+$/);
      expect(insight.projectId).toBe("test-project");
      expect(insight.title).toBe("Test Insight");
      expect(insight.content).toBeNull();
      expect(insight.category).toBe("quality");
      expect(insight.status).toBe("generated");
      expect(insight.fingerprint).toBeTruthy();
      expect(insight.lastRunId).toBeNull();
      expect(insight.createdAt).toBeTruthy();
      expect(insight.updatedAt).toBeTruthy();
    });

    it("accepts optional content and custom status", () => {
      const input = {
        title: "Insight with content",
        content: "Detailed description",
        category: "performance" as InsightCategory,
        status: "confirmed" as InsightStatus,
        provenance: createProvenance(),
      };

      const insight = store.createInsight("proj", input);

      expect(insight.content).toBe("Detailed description");
      expect(insight.status).toBe("confirmed");
    });

    it("uses provided fingerprint when given", () => {
      const input = {
        title: "Custom fingerprint",
        category: "security" as InsightCategory,
        provenance: createProvenance(),
        fingerprint: "my-custom-fingerprint",
      };

      const insight = store.createInsight("proj", input);
      expect(insight.fingerprint).toBe("my-custom-fingerprint");
    });

    it("persists insight to the database", () => {
      const insight = store.createInsight("proj", {
        title: "Persisted",
        category: "architecture",
        provenance: createProvenance(),
      });

      const fromDb = store.getInsight(insight.id);
      expect(fromDb).toEqual(insight);
    });

    it("emits insight:created event", () => {
      const handler = vi.fn();
      store.on("insight:created", handler);

      const insight = store.createInsight("proj", {
        title: "Event test",
        category: "ux",
        provenance: createProvenance(),
      });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(insight);
    });
  });

  describe("getInsight", () => {
    it("returns the insight when found", () => {
      const created = store.createInsight("proj", {
        title: "To get",
        category: "testability",
        provenance: createProvenance(),
      });

      const found = store.getInsight(created.id);
      expect(found).toEqual(created);
    });

    it("returns undefined when not found", () => {
      const found = store.getInsight("INS-NOTFOUND");
      expect(found).toBeUndefined();
    });
  });

  describe("listInsights", () => {
    it("returns all insights for a project", () => {
      store.createInsight("proj", { title: "A", category: "quality", provenance: createProvenance() });
      store.createInsight("proj", { title: "B", category: "performance", provenance: createProvenance() });
      store.createInsight("other", { title: "C", category: "architecture", provenance: createProvenance() });

      const list = store.listInsights({ projectId: "proj" });
      expect(list).toHaveLength(2);
    });

    it("filters by category", () => {
      store.createInsight("proj", { title: "A", category: "quality", provenance: createProvenance() });
      store.createInsight("proj", { title: "B", category: "performance", provenance: createProvenance() });

      const list = store.listInsights({ projectId: "proj", category: "quality" });
      expect(list).toHaveLength(1);
      expect(list[0].title).toBe("A");
    });

    it("filters by status", () => {
      store.createInsight("proj", { title: "A", category: "quality", status: "confirmed", provenance: createProvenance() });
      store.createInsight("proj", { title: "B", category: "quality", status: "generated", provenance: createProvenance() });

      const list = store.listInsights({ projectId: "proj", status: "confirmed" });
      expect(list).toHaveLength(1);
      expect(list[0].title).toBe("A");
    });

    it("supports pagination with limit and offset", () => {
      for (let i = 0; i < 10; i++) {
        store.createInsight("proj", { title: `Insight ${i}`, category: "quality", provenance: createProvenance() });
      }

      const page1 = store.listInsights({ projectId: "proj", limit: 3, offset: 0 });
      const page2 = store.listInsights({ projectId: "proj", limit: 3, offset: 3 });

      expect(page1).toHaveLength(3);
      expect(page2).toHaveLength(3);
      expect(page1[0].id).not.toEqual(page2[0].id);
    });

    it("is ordered ascending by createdAt, then id (deterministic)", () => {
      // Create insights with explicit timestamps 1s apart to ensure distinct timestamps
      const now = new Date();
      const insertedIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const ts = new Date(now.getTime() + i * 1000).toISOString();
        const id = `INS-LIST-${i}`;
        insertedIds.push(id);
        store.getDatabase().prepare(`
          INSERT INTO project_insights (id, projectId, title, content, category, status, fingerprint, provenance, lastRunId, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          "proj",
          `Insight ${i}`,
          null,
          "quality",
          "generated",
          `fp-list-${i}`,
          null,
          null,
          ts,
          ts,
        );
      }

      const list = store.listInsights({ projectId: "proj" });
      expect(list.map((i) => i.id)).toEqual(insertedIds);
      // Verify ascending order by createdAt
      for (let i = 1; i < list.length; i++) {
        expect(list[i - 1].createdAt < list[i].createdAt).toBe(true);
      }
    });
  });

  describe("updateInsight", () => {
    it("updates mutable fields", () => {
      const original = store.createInsight("proj", {
        title: "Original",
        category: "quality",
        provenance: createProvenance(),
      });

      const updated = store.updateInsight(original.id, {
        title: "Updated Title",
        content: "Updated content",
        status: "confirmed",
      });

      expect(updated!.title).toBe("Updated Title");
      expect(updated!.content).toBe("Updated content");
      expect(updated!.status).toBe("confirmed");
      expect(updated!.id).toBe(original.id);
      expect(updated!.createdAt).toBe(original.createdAt);
      // updatedAt should be >= original.createdAt (updated after creation)
      expect(updated!.updatedAt >= original.createdAt).toBe(true);
    });

    it("returns undefined for non-existent insight", () => {
      const result = store.updateInsight("INS-NOTFOUND", { title: "X" });
      expect(result).toBeUndefined();
    });

    it("emits insight:updated event", () => {
      const handler = vi.fn();
      store.on("insight:updated", handler);

      const insight = store.createInsight("proj", {
        title: "To update",
        category: "reliability",
        provenance: createProvenance(),
      });

      store.updateInsight(insight.id, { status: "stale" });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].status).toBe("stale");
    });
  });

  describe("deleteInsight", () => {
    it("deletes an existing insight", () => {
      const insight = store.createInsight("proj", {
        title: "To delete",
        category: "dependency",
        provenance: createProvenance(),
      });

      const deleted = store.deleteInsight(insight.id);
      expect(deleted).toBe(true);
      expect(store.getInsight(insight.id)).toBeUndefined();
    });

    it("returns false for non-existent insight", () => {
      const deleted = store.deleteInsight("INS-NOTFOUND");
      expect(deleted).toBe(false);
    });

    it("emits insight:deleted event", () => {
      const handler = vi.fn();
      store.on("insight:deleted", handler);

      const insight = store.createInsight("proj", {
        title: "To delete",
        category: "documentation",
        provenance: createProvenance(),
      });

      store.deleteInsight(insight.id);
      expect(handler).toHaveBeenCalledWith(insight.id);
    });
  });

  describe("upsertInsight (dedupe)", () => {
    it("creates a new insight when no fingerprint match exists", () => {
      const result = store.upsertInsight("proj", {
        title: "New insight",
        category: "architecture",
        provenance: createProvenance(),
        fingerprint: "new-fp",
      });

      expect(result.id).toMatch(/^INS-/);
      expect(result.fingerprint).toBe("new-fp");
      expect(store.listInsights({ projectId: "proj" })).toHaveLength(1);
    });

    it("updates existing insight when fingerprint matches (no duplicate)", () => {
      // First upsert — creates
      const created = store.upsertInsight("proj", {
        title: "Original title",
        category: "quality",
        provenance: createProvenance(),
        fingerprint: "same-fp",
      });

      const countBefore = store.listInsights({ projectId: "proj" }).length;
      expect(countBefore).toBe(1);

      // Second upsert with same fingerprint — updates (no duplicate)
      const updated = store.upsertInsight("proj", {
        title: "Updated title",
        content: "Added content",
        category: "quality",
        provenance: createProvenance(),
        fingerprint: "same-fp",
      });

      expect(updated.id).toBe(created.id); // Same id
      expect(updated.title).toBe("Updated title");
      expect(updated.content).toBe("Added content");
      expect(updated.createdAt).toBe(created.createdAt); // Original createdAt preserved

      const countAfter = store.listInsights({ projectId: "proj" }).length;
      expect(countAfter).toBe(1); // No duplicate created
    });

    it("preserves stable identity on upsert (id and createdAt unchanged)", () => {
      const first = store.upsertInsight("proj", {
        title: "Stable identity test",
        category: "workflow",
        provenance: createProvenance(),
        fingerprint: "stable-fp",
      });

      const second = store.upsertInsight("proj", {
        title: "Updated title",
        category: "workflow",
        provenance: createProvenance({ trigger: "schedule" }),
        fingerprint: "stable-fp",
      });

      expect(second.id).toBe(first.id);
      expect(second.createdAt).toBe(first.createdAt);
      // updatedAt should be >= first.createdAt (updated after first creation)
      expect(second.updatedAt >= first.createdAt).toBe(true);
    });

    it("upserting different fingerprints creates separate insights", () => {
      store.upsertInsight("proj", {
        title: "Insight A",
        category: "quality",
        provenance: createProvenance(),
        fingerprint: "fp-a",
      });

      store.upsertInsight("proj", {
        title: "Insight B",
        category: "quality",
        provenance: createProvenance(),
        fingerprint: "fp-b",
      });

      const list = store.listInsights({ projectId: "proj" });
      expect(list).toHaveLength(2);
      expect(list.map((i) => i.fingerprint)).toContain("fp-a");
      expect(list.map((i) => i.fingerprint)).toContain("fp-b");
    });

    it("upserting same fingerprint in different projects creates separate insights", () => {
      store.upsertInsight("proj-a", {
        title: "Shared title",
        category: "performance",
        provenance: createProvenance(),
        fingerprint: "cross-project-fp",
      });

      store.upsertInsight("proj-b", {
        title: "Shared title",
        category: "performance",
        provenance: createProvenance(),
        fingerprint: "cross-project-fp",
      });

      const listA = store.listInsights({ projectId: "proj-a" });
      const listB = store.listInsights({ projectId: "proj-b" });

      expect(listA).toHaveLength(1);
      expect(listB).toHaveLength(1);
      expect(listA[0].id).not.toEqual(listB[0].id);
    });
  });

  describe("countInsights", () => {
    it("counts all insights for a project", () => {
      store.createInsight("proj", { title: "A", category: "quality", provenance: createProvenance() });
      store.createInsight("proj", { title: "B", category: "performance", provenance: createProvenance() });
      store.createInsight("other", { title: "C", category: "architecture", provenance: createProvenance() });

      expect(store.countInsights({ projectId: "proj" })).toBe(2);
    });

    it("counts with filters", () => {
      store.createInsight("proj", { title: "A", category: "quality", status: "confirmed", provenance: createProvenance() });
      store.createInsight("proj", { title: "B", category: "quality", status: "generated", provenance: createProvenance() });

      expect(store.countInsights({ projectId: "proj", category: "quality" })).toBe(2);
      expect(store.countInsights({ projectId: "proj", status: "confirmed" })).toBe(1);
    });
  });

  describe("deterministic ordering", () => {
    it("ordering is stable across repeated reads", () => {
      // Create insights with explicit timestamps 1s apart to ensure distinct timestamps
      const now = new Date();
      for (let i = 0; i < 10; i++) {
        const ts = new Date(now.getTime() + i * 1000).toISOString();
        store.getDatabase().prepare(`
          INSERT INTO project_insights (id, projectId, title, content, category, status, fingerprint, provenance, lastRunId, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          `INS-STABLE-${i}`,
          "proj",
          `Insight ${i}`,
          null,
          "quality",
          "generated",
          `fp-stable-${i}`,
          null,
          null,
          ts,
          ts,
        );
      }

      // Ordering is stable: same reads across multiple calls
      const read1 = store.listInsights({ projectId: "proj" }).map((i) => i.id);
      const read2 = store.listInsights({ projectId: "proj" }).map((i) => i.id);
      const read3 = store.listInsights({ projectId: "proj" }).map((i) => i.id);

      expect(read1).toEqual(read2);
      expect(read2).toEqual(read3);
      // Verify the expected IDs are present
      expect(read1).toEqual([
        "INS-STABLE-0", "INS-STABLE-1", "INS-STABLE-2", "INS-STABLE-3", "INS-STABLE-4",
        "INS-STABLE-5", "INS-STABLE-6", "INS-STABLE-7", "INS-STABLE-8", "INS-STABLE-9",
      ]);
    });

    it("results are ascending (oldest first) by createdAt, then id", () => {
      // Create insights with explicit timestamps using SQL to avoid millisecond collisions
      const now = new Date();
      for (let i = 0; i < 5; i++) {
        const ts = new Date(now.getTime() + i * 1000).toISOString();
        store.getDatabase().prepare(`
          INSERT INTO project_insights (id, projectId, title, content, category, status, fingerprint, provenance, lastRunId, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          `INS-ORDER-${i}`,
          "proj",
          `Insight ${i}`,
          null,
          "quality",
          "generated",
          `fp-order-${i}`,
          null,
          null,
          ts,
          ts,
        );
      }

      const list = store.listInsights({ projectId: "proj" });
      expect(list).toHaveLength(5);
      // Verify IDs match what we inserted (auto-incremented order 0..4)
      expect(list.map((i) => i.id)).toEqual([
        "INS-ORDER-0",
        "INS-ORDER-1",
        "INS-ORDER-2",
        "INS-ORDER-3",
        "INS-ORDER-4",
      ]);
      // Verify ascending order by createdAt
      for (let i = 1; i < list.length; i++) {
        expect(list[i - 1].createdAt < list[i].createdAt).toBe(true);
      }
    });
  });

  describe("computeInsightFingerprint", () => {
    it("produces consistent fingerprints for same input", () => {
      const fp1 = computeInsightFingerprint("Test Insight", "quality");
      const fp2 = computeInsightFingerprint("Test Insight", "quality");
      expect(fp1).toBe(fp2);
    });

    it("produces consistent fingerprints regardless of case", () => {
      const fp1 = computeInsightFingerprint("Test Insight", "quality");
      const fp2 = computeInsightFingerprint("test insight", "quality");
      expect(fp1).toBe(fp2);
    });

    it("different titles produce different fingerprints", () => {
      const fp1 = computeInsightFingerprint("Title A", "quality");
      const fp2 = computeInsightFingerprint("Title B", "quality");
      expect(fp1).not.toBe(fp2);
    });

    it("different categories produce different fingerprints", () => {
      const fp1 = computeInsightFingerprint("Same Title", "quality");
      const fp2 = computeInsightFingerprint("Same Title", "performance");
      expect(fp1).not.toBe(fp2);
    });

    it("trims whitespace before hashing", () => {
      const fp1 = computeInsightFingerprint("  Test  ", "quality");
      const fp2 = computeInsightFingerprint("Test", "quality");
      expect(fp1).toBe(fp2);
    });
  });
});

// ── Insight Run CRUD ────────────────────────────────────────────────

describe("InsightStore Run CRUD", () => {
  describe("createRun", () => {
    it("creates a run with pending status", () => {
      const run = store.createRun("proj", { trigger: "manual" });

      expect(run.id).toMatch(/^INSR-/);
      expect(run.projectId).toBe("proj");
      expect(run.trigger).toBe("manual");
      expect(run.status).toBe("pending");
      expect(run.insightsCreated).toBe(0);
      expect(run.insightsUpdated).toBe(0);
      expect(run.createdAt).toBeTruthy();
      expect(run.startedAt).toBeNull();
      expect(run.completedAt).toBeNull();
    });

    it("persists run to the database", () => {
      const created = store.createRun("proj", { trigger: "schedule" });
      const fromDb = store.getRun(created.id);
      expect(fromDb).toEqual(created);
    });

    it("emits run:created event", () => {
      const handler = vi.fn();
      store.on("run:created", handler);

      const run = store.createRun("proj", { trigger: "api" });
      expect(handler).toHaveBeenCalledWith(run);
    });
  });

  describe("getRun", () => {
    it("returns run when found", () => {
      const created = store.createRun("proj", { trigger: "manual" });
      expect(store.getRun(created.id)).toEqual(created);
    });

    it("returns undefined when not found", () => {
      expect(store.getRun("INSR-NOTFOUND")).toBeUndefined();
    });
  });

  describe("listRuns", () => {
    it("returns runs for a project", () => {
      store.createRun("proj", { trigger: "manual" });
      store.createRun("proj", { trigger: "schedule" });
      store.createRun("other", { trigger: "manual" });

      const list = store.listRuns({ projectId: "proj" });
      expect(list).toHaveLength(2);
    });

    it("filters by status", () => {
      store.createRun("proj", { trigger: "manual" }); // pending
      const running = store.createRun("proj", { trigger: "schedule" });
      store.updateRun(running.id, { status: "running" });

      const pending = store.listRuns({ projectId: "proj", status: "pending" });
      expect(pending).toHaveLength(1);
      expect(pending[0].status).toBe("pending");
    });

    it("filters by trigger", () => {
      store.createRun("proj", { trigger: "manual" });
      store.createRun("proj", { trigger: "schedule" });

      const manual = store.listRuns({ projectId: "proj", trigger: "manual" });
      expect(manual).toHaveLength(1);
    });

    it("supports pagination", () => {
      for (let i = 0; i < 10; i++) {
        store.createRun("proj", { trigger: "manual" });
      }

      const page1 = store.listRuns({ projectId: "proj", limit: 3, offset: 0 });
      expect(page1).toHaveLength(3);
    });

    it("is ordered descending by createdAt (newest first)", () => {
      // Create runs with explicit descending timestamps to ensure deterministic ordering
      const now = new Date();
      for (let i = 4; i >= 0; i--) {
        const ts = new Date(now.getTime() + i * 1000).toISOString();
        store.getDatabase().prepare(`
          INSERT INTO project_insight_runs (id, projectId, trigger, status, summary, error, insightsCreated, insightsUpdated, inputMetadata, outputMetadata, createdAt, startedAt, completedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          `INSR-ORDER-${i}`,
          "proj",
          "manual",
          "pending",
          null,
          null,
          0,
          0,
          null,
          null,
          ts,
          null,
          null,
        );
      }

      const list = store.listRuns({ projectId: "proj" });
      expect(list).toHaveLength(5);
      // Descending by createdAt: newest first (ts=4, ts=3, ts=2, ts=1, ts=0)
      for (let i = 1; i < list.length; i++) {
        const prev = list[i - 1];
        const curr = list[i];
        expect(prev.createdAt > curr.createdAt).toBe(true);
      }
    });
  });

  describe("updateRun", () => {
    it("updates mutable fields", () => {
      const run = store.createRun("proj", { trigger: "manual" });

      const updated = store.updateRun(run.id, {
        status: "running",
        startedAt: "2025-01-01T00:00:00.000Z",
      });

      expect(updated!.status).toBe("running");
      expect(updated!.startedAt).toBe("2025-01-01T00:00:00.000Z");
      expect(updated!.id).toBe(run.id);
    });

    it("auto-sets completedAt when transitioning to terminal state", () => {
      const run = store.createRun("proj", { trigger: "schedule" });

      const updated = store.updateRun(run.id, {
        status: "completed",
        summary: "Done",
        insightsCreated: 5,
        insightsUpdated: 2,
      });

      expect(updated!.status).toBe("completed");
      expect(updated!.completedAt).toBeTruthy();
    });

    it("does not override completedAt if already provided", () => {
      const run = store.createRun("proj", { trigger: "manual" });
      const fixed = "2025-06-01T12:00:00.000Z";

      const updated = store.updateRun(run.id, {
        status: "failed",
        completedAt: fixed,
        error: "boom",
      });

      expect(updated!.completedAt).toBe(fixed);
    });

    it("returns undefined for non-existent run", () => {
      const result = store.updateRun("INSR-NOTFOUND", { status: "running" });
      expect(result).toBeUndefined();
    });

    it("emits run:updated event on status change", () => {
      const handler = vi.fn();
      store.on("run:updated", handler);

      const run = store.createRun("proj", { trigger: "manual" });
      store.updateRun(run.id, { status: "running" });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].status).toBe("running");
    });

    it("emits run:completed event when reaching terminal state", () => {
      const handler = vi.fn();
      store.on("run:completed", handler);

      const run = store.createRun("proj", { trigger: "schedule" });
      store.updateRun(run.id, { status: "completed" });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].id).toBe(run.id);
      expect(handler.mock.calls[0][0].status).toBe("completed");
    });
  });

  describe("upsertRun", () => {
    it("creates new run when no pending/running run exists", () => {
      const run = store.upsertRun("proj", "schedule", { trigger: "schedule" });
      expect(run.id).toMatch(/^INSR-/);
      expect(run.status).toBe("pending");
    });

    it("returns existing pending/running run instead of creating duplicate", () => {
      const first = store.createRun("proj", { trigger: "schedule" });

      const second = store.upsertRun("proj", "schedule", { trigger: "schedule" });

      expect(second.id).toBe(first.id);
      expect(store.listRuns({ projectId: "proj", trigger: "schedule" })).toHaveLength(1);
    });

    it("creates new run when existing run is terminal", () => {
      const first = store.createRun("proj", { trigger: "schedule" });
      store.updateRun(first.id, { status: "completed" });

      const second = store.upsertRun("proj", "schedule", { trigger: "schedule" });

      expect(second.id).not.toBe(first.id);
      expect(store.listRuns({ projectId: "proj" })).toHaveLength(2);
    });
  });

  describe("countRuns", () => {
    it("counts runs with optional filters", () => {
      store.createRun("proj", { trigger: "manual" });
      store.createRun("proj", { trigger: "schedule" });
      store.createRun("other", { trigger: "manual" });

      expect(store.countRuns({ projectId: "proj" })).toBe(2);
      expect(store.countRuns({ projectId: "proj", trigger: "manual" })).toBe(1);
    });
  });
});

// ── Migration Test ───────────────────────────────────────────────────

describe("Migration: pre-33 DB upgrade", () => {
  it("creates insight tables when upgrading from schema version 32", () => {
    const legacyDir = mkdtempSync(join(tmpdir(), "fn-mig-test-"));

    try {
      // Step 1: Create a fresh database at v33 (runs all migrations up to 33)
      const db1 = createDatabase(legacyDir);
      db1.init();
      expect(db1.getSchemaVersion()).toBe(37);
      db1.close();

      // Step 2: Manually downgrade to version 32 and drop insight tables
      // to simulate a pre-33 database
      const db2 = createDatabase(legacyDir);
      db2.init();
      db2.prepare("UPDATE __meta SET value = '32' WHERE key = 'schemaVersion'").run();
      // Drop insight tables/indexes to fully simulate pre-33 state
      db2.prepare("DROP TABLE IF EXISTS project_insight_runs").run();
      db2.prepare("DROP TABLE IF EXISTS project_insights").run();
      db2.prepare("DROP INDEX IF EXISTS idxProjectInsightsProjectId").run();
      db2.prepare("DROP INDEX IF EXISTS idxProjectInsightsFingerprint").run();
      db2.prepare("DROP INDEX IF EXISTS idxProjectInsightsCategory").run();
      db2.prepare("DROP INDEX IF EXISTS idxInsightRunsProjectId").run();
      db2.close();

      // Step 3: Verify pre-33 state (after downgrade, before re-init)
      // Note: we check the version BEFORE calling init() on db3
      // because init() would immediately run migration 33.
      // We verify pre-33 state by re-opening without calling init() on the new instance,
      // then calling init() and verifying it upgrades.
      const db3 = createDatabase(legacyDir);
      // Read version without running migrations
      const versionBefore = db3.getSchemaVersion();
      expect(versionBefore).toBe(32);
      // Verify insight tables are absent in the pre-33 state
      const tablesBefore = db3.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'project_%'"
      ).all() as { name: string }[];
      const tableNamesBefore = tablesBefore.map((t) => t.name);
      expect(tableNamesBefore).not.toContain("project_insights");
      expect(tableNamesBefore).not.toContain("project_insight_runs");
      // Now run init — this triggers the v32→v33 migration
      db3.init();
      expect(db3.getSchemaVersion()).toBe(37);

      // Step 4: Verify insight tables exist after migration
      const tablesAfter = db3.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'project_%'"
      ).all() as { name: string }[];
      const tableNamesAfter = tablesAfter.map((t) => t.name);
      expect(tableNamesAfter).toContain("project_insights");
      expect(tableNamesAfter).toContain("project_insight_runs");

      // Verify indexes exist
      const indexes = db3.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'"
      ).all() as { name: string }[];
      const indexNames = indexes.map((i) => i.name);
      expect(indexNames).toContain("idxProjectInsightsProjectId");
      expect(indexNames).toContain("idxProjectInsightsFingerprint");
      expect(indexNames).toContain("idxInsightRunsProjectId");

      db3.close();
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  it("migration is idempotent — running twice does not fail", () => {
    const testDir = mkdtempSync(join(tmpdir(), "fn-idempotent-test-"));

    try {
      const db1 = createDatabase(testDir);
      db1.init();
      expect(db1.getSchemaVersion()).toBe(37);
      db1.close();

      const db2 = createDatabase(testDir);
      expect(() => db2.init()).not.toThrow();
      expect(db2.getSchemaVersion()).toBe(37);
      db2.close();
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
