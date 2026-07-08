import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "@fusion/core";
import {
  computeVerificationFailureSignature,
  createAutomatedFollowup,
} from "../../verification-followup-dedup.js";

async function createStore() {
  const rootDir = await mkdtemp(join(tmpdir(), "fusion-verification-followup-dedup-reliability-"));
  const store = new TaskStore(rootDir, undefined, { inMemoryDb: true });
  await store.init();
  return {
    store,
    cleanup: async () => {
      store.close();
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

describe("reliability interactions: verification follow-up dedup", () => {
  const fixtures: Array<Awaited<ReturnType<typeof createStore>>> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-19T12:00:00.000Z"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    while (fixtures.length) await fixtures.pop()!.cleanup();
  });

  it("FN-5224 dedups repeated verification follow-ups to one task and one hourly recurrence log", async () => {
    const fx = await createStore();
    fixtures.push(fx);
    const parent = await fx.store.createTask({ description: "parent task" });
    const signature = computeVerificationFailureSignature({
      lane: "pnpm test",
      failingTestFiles: ["packages/dashboard/app/__tests__/verification.test.ts"],
    }).signature;

    const results = [] as Array<Awaited<ReturnType<typeof createAutomatedFollowup>>>;
    results.push(await createAutomatedFollowup(fx.store, {
      kind: "verification-failure",
      parentTaskId: parent.id,
      signature,
      createInput: {
        title: "Investigate repeated verification failure",
        description: "Investigate repeated verification failure.",
        column: "triage",
        source: { sourceType: "recovery", sourceParentTaskId: parent.id },
      },
    }));

    vi.advanceTimersByTime(5 * 60 * 1000);
    results.push(await createAutomatedFollowup(fx.store, {
      kind: "verification-failure",
      parentTaskId: parent.id,
      signature,
      createInput: {
        title: "Investigate repeated verification failure",
        description: "Investigate repeated verification failure.",
        column: "triage",
        source: { sourceType: "recovery", sourceParentTaskId: parent.id },
      },
    }));

    for (let attempt = 0; attempt < 4; attempt += 1) {
      vi.advanceTimersByTime(9 * 60 * 1000);
      results.push(await createAutomatedFollowup(fx.store, {
        kind: "verification-failure",
        parentTaskId: parent.id,
        signature,
        createInput: {
          title: "Investigate repeated verification failure",
          description: "Investigate repeated verification failure.",
          column: "triage",
          source: { sourceType: "recovery", sourceParentTaskId: parent.id },
        },
      }));
    }

    expect(results[0]?.outcome).toBe("created");
    expect(results.slice(1).every((result) => result.outcome === "deduped")).toBe(true);
    expect(results.slice(1).map((result) => result.outcome === "deduped" ? result.rateLimited : null)).toEqual([
      false,
      true,
      true,
      true,
      true,
    ]);

    const allTasks = await fx.store.listTasks({ slim: true, includeArchived: true });
    const followups = allTasks.filter((task) => task.sourceParentTaskId === parent.id && task.id !== parent.id);
    expect(followups).toHaveLength(1);

    const followup = await fx.store.getTask(followups[0]!.id);
    const recurrenceLogs = followup.log.filter((entry) => entry.action.startsWith("[verification recurrence]"));
    expect(recurrenceLogs).toHaveLength(1);

    const dedupedAudits = fx.store.getRunAuditEvents({ mutationType: "verification:followup-deduped" });
    expect(dedupedAudits).toHaveLength(5);
    expect(dedupedAudits.filter((event) => event.metadata?.rateLimited === true)).toHaveLength(4);
  });

  it("creates a new follow-up that supersedes a recent archived sibling", async () => {
    const fx = await createStore();
    fixtures.push(fx);
    const parent = await fx.store.createTask({ description: "parent task" });
    const signature = computeVerificationFailureSignature({ lane: "pnpm test", failingTestFiles: [] }).signature;

    vi.setSystemTime(new Date("2026-05-18T13:00:00.000Z"));
    const archived = await fx.store.createTask({
      description: "old archived follow-up",
      column: "archived",
      source: {
        sourceType: "recovery",
        sourceParentTaskId: parent.id,
        sourceMetadata: { verificationFailureSignature: signature },
      },
    });

    vi.setSystemTime(new Date("2026-05-19T12:00:00.000Z"));
    const result = await createAutomatedFollowup(fx.store, {
      kind: "verification-failure",
      parentTaskId: parent.id,
      signature,
      createInput: {
        description: "new follow-up",
        column: "triage",
        source: { sourceType: "recovery", sourceParentTaskId: parent.id },
      },
    });

    expect(result.outcome).toBe("created");
    if (result.outcome === "created") {
      expect(result.supersedesTaskId).toBe(archived.id);
      expect(result.task.sourceMetadata?.supersedesTaskId).toBe(archived.id);
    }

    const audits = fx.store.getRunAuditEvents({ mutationType: "verification:followup-created" });
    expect(audits.at(-1)?.metadata?.supersedesTaskId).toBe(archived.id);
  });

  it("does not supersede a done task older than 24 hours", async () => {
    const fx = await createStore();
    fixtures.push(fx);
    const parent = await fx.store.createTask({ description: "parent task" });
    const signature = computeVerificationFailureSignature({ lane: "pnpm test", failingTestFiles: [] }).signature;

    vi.setSystemTime(new Date("2026-05-18T10:59:59.000Z"));
    await fx.store.createTask({
      description: "old done follow-up",
      column: "done",
      source: {
        sourceType: "recovery",
        sourceParentTaskId: parent.id,
        sourceMetadata: { verificationFailureSignature: signature },
      },
    });

    vi.setSystemTime(new Date("2026-05-19T12:00:00.000Z"));
    const result = await createAutomatedFollowup(fx.store, {
      kind: "verification-failure",
      parentTaskId: parent.id,
      signature,
      createInput: {
        description: "new follow-up",
        column: "triage",
        source: { sourceType: "recovery", sourceParentTaskId: parent.id },
      },
    });

    expect(result.outcome).toBe("created");
    if (result.outcome === "created") {
      expect(result.supersedesTaskId).toBeUndefined();
      expect(result.task.sourceMetadata?.supersedesTaskId).toBeUndefined();
    }
  });

  it("keeps signatures stable across clock changes", () => {
    const input = { lane: "pnpm test", failingTestFiles: ["packages/engine/src/__tests__/alpha.test.ts"] };
    const first = computeVerificationFailureSignature(input);
    vi.advanceTimersByTime(123_456);
    const second = computeVerificationFailureSignature(input);

    expect(first.signature).toBe(second.signature);
  });

  it("remains additive with FN-4892 same-agent duplicate intake", async () => {
    const fx = await createStore();
    fixtures.push(fx);
    /*
    FNXC:ReliabilityTests 2026-07-08-12:30:
    FN-7658 gated same-agent duplicate auto-archiving behind autoArchiveDuplicateTasksEnabled (default false → flag-in-place in triage). This test asserts the ARCHIVE path is additive with verification follow-up dedup, so opt into the legacy archive behavior explicitly rather than asserting the new flag-in-place default.
    */
    await fx.store.updateSettings({ autoArchiveDuplicateTasksEnabled: true });
    const source = {
      sourceType: "api" as const,
      sourceAgentId: "agent-1",
      sourceParentTaskId: "FN-parent-a",
    };

    const canonical = await fx.store.createTask({
      title: "Follow-up: same agent duplicate",
      description: "Same-agent duplicate description.",
      source,
    });

    const result = await createAutomatedFollowup(fx.store, {
      kind: "pr-comment",
      parentTaskId: "FN-parent-b",
      createInput: {
        title: "Follow-up: same agent duplicate",
        description: "Same-agent duplicate description.",
        source: {
          sourceType: "api",
          sourceAgentId: "agent-1",
          sourceParentTaskId: "FN-parent-b",
        },
      },
    });

    expect(result.outcome).toBe("created");
    if (result.outcome === "created") {
      expect(result.task.column).toBe("archived");
    }

    const visibleSameAgentTasks = (await fx.store.listTasks({ slim: true, includeArchived: true }))
      .filter((task) => task.sourceAgentId === "agent-1" && task.column !== "archived");
    expect(visibleSameAgentTasks.map((task) => task.id)).toEqual([canonical.id]);
  });
});
