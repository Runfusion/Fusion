import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStore } from "@fusion/core";
import {
  __testing__,
  computeVerificationFailureSignature,
  createAutomatedFollowup,
  decideAutomatedFollowup,
  extractFailingTestFiles,
} from "../verification-followup-dedup.js";

async function createStore() {
  const rootDir = await mkdtemp(join(tmpdir(), "fusion-verification-followup-dedup-"));
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

describe("verification follow-up dedup", () => {
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

  it("computes stable signatures from sorted basenames only", () => {
    const a = computeVerificationFailureSignature({
      lane: "pnpm --filter @fusion/dashboard test",
      failingTestFiles: ["packages/dashboard/app/foo.test.tsx", "/tmp/bar.test.ts", "packages/dashboard/app/foo.test.tsx"],
      failedCommand: "pnpm test --pid=123",
    });
    const b = computeVerificationFailureSignature({
      lane: "pnpm --filter @fusion/dashboard test",
      failingTestFiles: ["/another/path/bar.test.ts", "packages/dashboard/app/foo.test.tsx"],
      failedCommand: "pnpm test --pid=999",
    });

    expect(a.failingBasenames).toEqual(["bar.test.ts", "foo.test.tsx"]);
    expect(a.signature).toBe(b.signature);
  });

  it("uses a deterministic lane-only fallback when no files are parsed", () => {
    const a = computeVerificationFailureSignature({ lane: "merge-conflict", failingTestFiles: [] });
    const b = computeVerificationFailureSignature({ lane: "merge-conflict", failingTestFiles: [] });
    const c = computeVerificationFailureSignature({ lane: "autostash-orphan", failingTestFiles: [] });

    expect(a.failingBasenames).toEqual([]);
    expect(a.signature).toBe(b.signature);
    expect(a.signature).not.toBe(c.signature);
  });

  it("extracts failing test file basenames from common runner output", () => {
    const files = extractFailingTestFiles(
      [
        "FAIL  packages/engine/src/__tests__/alpha.test.ts",
        "\u00D7 packages/engine/src/__tests__/beta.test.ts",
        "\u2716 packages/engine/src/__tests__/gamma.test.ts:12:2",
        "Error in packages/engine/src/__tests__/delta.test.ts",
      ].join("\n"),
      "",
    );

    expect(files).toEqual(["alpha.test.ts", "beta.test.ts", "delta.test.ts", "gamma.test.ts"]);
  });

  it("ignores timestamps and unrelated command noise when recomputing the same signature", () => {
    const first = computeVerificationFailureSignature({
      lane: "pnpm test",
      failingTestFiles: ["/tmp/worker-123/foo.test.ts"],
      failedCommand: "pnpm test --reporter dot --pid=123",
    });
    vi.advanceTimersByTime(30_000);
    const second = computeVerificationFailureSignature({
      lane: "pnpm test",
      failingTestFiles: ["/var/tmp/worker-999/foo.test.ts"],
      failedCommand: `pnpm test --reporter dot --pid=${Date.now()}`,
    });

    expect(first.signature).toBe(second.signature);
  });

  it("allows a new recurrence exactly one hour later", async () => {
    const fx = await createStore();
    fixtures.push(fx);
    const parent = await fx.store.createTask({ description: "parent task" });
    const followup = await fx.store.createTask({
      description: "existing follow-up",
      source: {
        sourceType: "recovery",
        sourceParentTaskId: parent.id,
        sourceMetadata: { verificationFailureSignature: "sig-1" },
      },
    });
    await fx.store.logEntry(
      followup.id,
      `${__testing__.RECURRENCE_LOG_TAG} signature=sig-1`,
      "kind=verification-failure; parentTaskId=FN-parent",
    );

    vi.advanceTimersByTime(__testing__.RECURRENCE_RATE_LIMIT_MS);

    const decision = await decideAutomatedFollowup(fx.store, {
      kind: "verification-failure",
      parentTaskId: parent.id,
      signature: "sig-1",
      now: Date.now(),
    });

    expect(decision).toEqual({ action: "append-log", existingTaskId: followup.id, rateLimited: false });
  });

  it("rate-limits a recurrence logged within one hour", async () => {
    const fx = await createStore();
    fixtures.push(fx);
    const parent = await fx.store.createTask({ description: "parent task" });
    const followup = await fx.store.createTask({
      description: "existing follow-up",
      source: {
        sourceType: "recovery",
        sourceParentTaskId: parent.id,
        sourceMetadata: { verificationFailureSignature: "sig-1" },
      },
    });
    await fx.store.logEntry(
      followup.id,
      `${__testing__.RECURRENCE_LOG_TAG} signature=sig-1`,
      "kind=verification-failure; parentTaskId=FN-parent",
    );

    vi.advanceTimersByTime(__testing__.RECURRENCE_RATE_LIMIT_MS - 1);

    const decision = await decideAutomatedFollowup(fx.store, {
      kind: "verification-failure",
      parentTaskId: parent.id,
      signature: "sig-1",
      now: Date.now(),
    });

    expect(decision).toEqual({ action: "append-log", existingTaskId: followup.id, rateLimited: true });
  });

  it("dedups extra metadata keys only within the same parent task", async () => {
    const fx = await createStore();
    fixtures.push(fx);
    const parentA = await fx.store.createTask({ description: "parent A" });
    const parentB = await fx.store.createTask({ description: "parent B" });
    const existing = await fx.store.createTask({
      description: "existing eval follow-up",
      source: {
        sourceType: "automation",
        sourceParentTaskId: parentA.id,
        sourceMetadata: { suggestionId: "suggestion-1" },
      },
    });

    const decision = await decideAutomatedFollowup(fx.store, {
      kind: "eval",
      parentTaskId: parentB.id,
      extraMatchKeys: { suggestionId: "suggestion-1" },
      now: Date.now(),
    });

    expect(existing.id).toBeDefined();
    expect(decision).toEqual({ action: "create-new" });
  });

  it("fails open to direct task creation when dedup decision throws", async () => {
    const fx = await createStore();
    fixtures.push(fx);
    const parent = await fx.store.createTask({ description: "parent task" });
    vi.spyOn(fx.store, "listTasks").mockRejectedValueOnce(new Error("boom"));

    const result = await createAutomatedFollowup(fx.store, {
      kind: "verification-failure",
      parentTaskId: parent.id,
      signature: "sig-1",
      createInput: {
        description: "fallback create",
        source: { sourceType: "recovery", sourceParentTaskId: parent.id },
      },
    });

    expect(result.outcome).toBe("created");
    if (result.outcome === "created") {
      expect(result.task.sourceMetadata?.verificationFailureSignature).toBeUndefined();
    }
  });
});
