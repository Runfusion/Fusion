// @vitest-environment node
//
// CHARACTERIZATION SUITE (U4 Execution Note — written FIRST, before any change
// to `moveTaskInternal`).
//
// This suite pins the CURRENT behavior of `moveTaskInternal` for every (from,
// to) pair in VALID_TRANSITIONS' domain and both moveSource values, plus the
// key column side effects:
//   - merge-blocker on in-review → done (user source)
//   - userPaused set only for user-source in-progress → todo
//   - reopen field/step resets on in-review/done → todo|triage
//   - autoMerge live-global inheritance on → in-review
//   - timing fields (cumulativeActiveMs / executionStartedAt) on in-progress
//
// It runs GREEN against the unmodified store first, then runs forever against
// BOTH flag states (workflowColumns OFF and ON) — see the `flagStates` loop.
// Any divergence between the two flag states is a U4 parity FAILURE.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { allowsAutoMergeProcessing, resolveEffectiveAutoMerge } from "../task-merge.js";
import { VALID_TRANSITIONS } from "../types.js";
import type { Column, Task } from "../types.js";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

const ALL_COLUMNS: Column[] = ["triage", "todo", "in-progress", "in-review", "done", "archived"];
const MOVE_SOURCES = ["user", "engine", "scheduler"] as const;

// Flag states the characterization runs against. OFF is the legacy path; ON is
// the workflow-resolved path. The default workflow MUST reproduce identical
// outcomes for both, so the same expectations apply.
const flagStates: Array<{ label: string; workflowColumns: boolean }> = [
  { label: "flag OFF (legacy path)", workflowColumns: false },
  { label: "flag ON (workflow-resolved default workflow)", workflowColumns: true },
];

for (const flag of flagStates) {
  describe(`moveTaskInternal characterization — ${flag.label}`, () => {
    const harness = createTaskStoreTestHarness();
    let store: ReturnType<typeof harness.store>;

    beforeEach(async () => {
      await harness.beforeEach();
      store = harness.store();
      await store.updateGlobalSettings({ experimentalFeatures: { workflowColumns: flag.workflowColumns } });
    });

    afterEach(async () => {
      await harness.afterEach();
    });

    /**
     * Drive a freshly-created task (starts in `triage`) into `column` using only
     * legal, side-effect-tolerant moves. Returns the task.
     */
    async function seedInColumn(column: Column): Promise<Task> {
      const task = await store.createTask({ description: `seed-${column}` });
      switch (column) {
        case "triage":
          return task;
        case "todo":
          return store.moveTask(task.id, "todo", { moveSource: "user" });
        case "in-progress":
          await store.moveTask(task.id, "todo", { moveSource: "user" });
          return store.moveTask(task.id, "in-progress", { moveSource: "user" });
        case "in-review":
          await store.moveTask(task.id, "todo", { moveSource: "user" });
          await store.moveTask(task.id, "in-progress", { moveSource: "user" });
          return store.moveTask(task.id, "in-review", { moveSource: "user", allowDirectInReviewMove: true });
        case "done":
          await store.moveTask(task.id, "todo", { moveSource: "user" });
          await store.moveTask(task.id, "in-progress", { moveSource: "user" });
          await store.moveTask(task.id, "in-review", { moveSource: "user", allowDirectInReviewMove: true });
          return store.moveTask(task.id, "done", { moveSource: "engine", skipMergeBlocker: true });
        case "archived":
          await store.moveTask(task.id, "todo", { moveSource: "user" });
          await store.moveTask(task.id, "in-progress", { moveSource: "user" });
          await store.moveTask(task.id, "in-review", { moveSource: "user", allowDirectInReviewMove: true });
          await store.moveTask(task.id, "done", { moveSource: "engine", skipMergeBlocker: true });
          return store.moveTask(task.id, "archived", { moveSource: "user" });
        default:
          throw new Error(`unhandled column ${column}`);
      }
    }

    describe("transition allow/reject matrix (every from×to×moveSource)", () => {
      for (const from of ALL_COLUMNS) {
        for (const to of ALL_COLUMNS) {
          for (const moveSource of MOVE_SOURCES) {
            const allowed = from === to || VALID_TRANSITIONS[from].includes(to);
            const label = `${from} → ${to} [${moveSource}] should ${allowed ? "ALLOW" : "REJECT"}`;
            it(label, async () => {
              const task = await seedInColumn(from);
              // Same-column move is a no-op success in legacy behavior.
              if (from === to) {
                const result = await store.moveTask(task.id, to, { moveSource });
                expect(result.column).toBe(to);
                return;
              }
              if (allowed) {
                // in-review → done with merge-blocker only blocks for user source
                // and only when a blocker exists; our seeded task has no blocker.
                // Bare in-review targets bypass the handoff invariant via
                // allowDirectInReviewMove, matching production drag behavior.
                const opts =
                  to === "in-review"
                    ? { moveSource, allowDirectInReviewMove: true }
                    : { moveSource };
                const result = await store.moveTask(task.id, to, opts);
                expect(result.column).toBe(to);
              } else {
                await expect(
                  store.moveTask(task.id, to, { moveSource }),
                ).rejects.toThrow(/Invalid transition/);
              }
            });
          }
        }
      }
    });

    describe("merge-blocker side effect (in-review → done)", () => {
      it("blocks a user move to done when a merge blocker exists", async () => {
        const task = await seedInColumn("in-review");
        // Incomplete steps create a merge blocker (getTaskMergeBlocker).
        await store.updateTask(task.id, {
          steps: [{ name: "x", status: "pending" }] as Task["steps"],
        });
        await expect(
          store.moveTask(task.id, "done", { moveSource: "user" }),
        ).rejects.toThrow(/Cannot move .* to done/);
      });

      it("skipMergeBlocker bypasses the blocker", async () => {
        const task = await seedInColumn("in-review");
        await store.updateTask(task.id, {
          steps: [{ name: "x", status: "pending" }] as Task["steps"],
        });
        const result = await store.moveTask(task.id, "done", {
          moveSource: "engine",
          skipMergeBlocker: true,
        });
        expect(result.column).toBe("done");
      });
    });

    describe("userPaused side effect (in-progress → todo)", () => {
      it("sets userPaused for a user-source move", async () => {
        const task = await seedInColumn("in-progress");
        const result = await store.moveTask(task.id, "todo", { moveSource: "user" });
        expect(result.userPaused).toBe(true);
      });

      it("does NOT set userPaused for an engine-source move", async () => {
        const task = await seedInColumn("in-progress");
        const result = await store.moveTask(task.id, "todo", { moveSource: "engine" });
        expect(result.userPaused).toBeUndefined();
      });
    });

    describe("reopen resets (in-review → todo)", () => {
      it("clears branch/summary/baseCommitSha on reopen to todo", async () => {
        const task = await seedInColumn("in-review");
        await store.updateTask(task.id, {
          branch: "fusion/fn-x",
          summary: "did stuff",
          baseCommitSha: "abc123",
        });
        const result = await store.moveTask(task.id, "todo", { moveSource: "user" });
        expect(result.branch).toBeUndefined();
        expect(result.summary).toBeUndefined();
        expect(result.baseCommitSha).toBeUndefined();
      });
    });

    describe("autoMerge live-global inheritance (→ in-review)", () => {
      for (const moveSource of MOVE_SOURCES) {
        it(`leaves undefined autoMerge to follow live settings for ${moveSource}-source moves`, async () => {
          await store.updateSettings({ autoMerge: true });
          const task = await seedInColumn("in-progress");
          const result = await store.moveTask(task.id, "in-review", {
            moveSource,
            allowDirectInReviewMove: true,
          });

          expect(result.autoMerge).toBeUndefined();
          expect(allowsAutoMergeProcessing(result, { autoMerge: false })).toBe(false);
          expect(allowsAutoMergeProcessing(result, { autoMerge: true })).toBe(true);
          expect(resolveEffectiveAutoMerge(result, { autoMerge: false })).toBe(false);
          expect(resolveEffectiveAutoMerge(result, { autoMerge: true })).toBe(true);
        });
      }

      it("preserves explicit task autoMerge overrides", async () => {
        await store.updateSettings({ autoMerge: false });
        const explicitTrue = await seedInColumn("in-progress");
        await store.updateTask(explicitTrue.id, { autoMerge: true });
        const trueResult = await store.moveTask(explicitTrue.id, "in-review", {
          moveSource: "engine",
          allowDirectInReviewMove: true,
        });
        expect(trueResult.autoMerge).toBe(true);
        expect(allowsAutoMergeProcessing(trueResult, { autoMerge: false })).toBe(true);

        await store.updateSettings({ autoMerge: true });
        const explicitFalse = await seedInColumn("in-progress");
        await store.updateTask(explicitFalse.id, { autoMerge: false });
        const falseResult = await store.moveTask(explicitFalse.id, "in-review", {
          moveSource: "scheduler",
          allowDirectInReviewMove: true,
        });
        expect(falseResult.autoMerge).toBe(false);
        expect(resolveEffectiveAutoMerge(falseResult, { autoMerge: true })).toBe(false);
        expect(resolveEffectiveAutoMerge(falseResult, { autoMerge: false })).toBe(false);
      });
    });

    describe("timing fields (→ in-progress)", () => {
      it("sets executionStartedAt and initializes cumulativeActiveMs on entry", async () => {
        const task = await seedInColumn("todo");
        const result = await store.moveTask(task.id, "in-progress", { moveSource: "user" });
        expect(result.executionStartedAt).toBeTruthy();
        expect(result.cumulativeActiveMs).toBe(0);
      });

      it("accumulates cumulativeActiveMs on exit from in-progress", async () => {
        const task = await seedInColumn("in-progress");
        const result = await store.moveTask(task.id, "in-review", {
          moveSource: "user",
          allowDirectInReviewMove: true,
        });
        expect(result.cumulativeActiveMs).toBeGreaterThanOrEqual(0);
      });
    });
  });
}
