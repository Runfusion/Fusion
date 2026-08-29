import { describe, it, expect } from "vitest";
import type { TraitFlags } from "@fusion/core";
import {
  bucketForTask,
  groupTasksByBucket,
  otherBucketSecondaryLabel,
  TUI_BUCKETS,
  OTHER_BUCKET,
  isOtherBucket,
} from "../bucket-mapping.js";
import type { TaskItem } from "../state.js";

function task(partial: Partial<TaskItem> & { id: string; column: string }): TaskItem {
  return { description: "", ...partial };
}

describe("bucketForTask (U11 / R18 graceful degradation)", () => {
  it("keeps legacy column ids in their own bucket verbatim", () => {
    expect(bucketForTask(task({ id: "a", column: "todo" }))).toBe("todo");
    expect(bucketForTask(task({ id: "b", column: "in-progress" }))).toBe("in-progress");
    expect(bucketForTask(task({ id: "c", column: "in-review" }))).toBe("in-review");
    expect(bucketForTask(task({ id: "d", column: "done" }))).toBe("done");
  });

  it("flag-OFF (no columnFlags) sends a non-legacy column to the read-only 'other' bucket — never dropped", () => {
    expect(bucketForTask(task({ id: "x", column: "staging" }))).toBe(OTHER_BUCKET);
    expect(bucketForTask(task({ id: "y", column: "qa-review" }))).toBe(OTHER_BUCKET);
  });

  it("maps each built-in trait flag to the correct legacy bucket", () => {
    const cases: Array<[TraitFlags, string]> = [
      [{ complete: true }, "done"],
      [{ humanReview: true }, "in-review"],
      [{ mergeBlocker: true }, "in-review"],
      [{ countsTowardWip: true }, "in-progress"],
      [{ hold: true }, "todo"],
      [{ intake: true }, "todo"],
    ];
    for (const [flags, expected] of cases) {
      expect(
        bucketForTask(task({ id: "t", column: "custom-col", columnFlags: flags })),
      ).toBe(expected);
    }
  });

  it("applies flag precedence: complete > review > wip > todo-like", () => {
    expect(
      bucketForTask(task({ id: "t", column: "c", columnFlags: { complete: true, countsTowardWip: false, humanReview: true } })),
    ).toBe("done");
    expect(
      bucketForTask(task({ id: "t", column: "c", columnFlags: { humanReview: true, countsTowardWip: true } })),
    ).toBe("in-review");
    expect(
      bucketForTask(task({ id: "t", column: "c", columnFlags: { countsTowardWip: true, hold: true } })),
    ).toBe("in-progress");
  });

  it("flagged column with no mapping-relevant flags lands in 'other'", () => {
    expect(
      bucketForTask(task({ id: "t", column: "weird", columnFlags: { notify: true, timing: true } })),
    ).toBe(OTHER_BUCKET);
  });
});

describe("groupTasksByBucket", () => {
  it("never drops a card: every task lands in exactly one of the five buckets", () => {
    const tasks: TaskItem[] = [
      task({ id: "1", column: "todo" }),
      task({ id: "2", column: "in-progress" }),
      task({ id: "3", column: "in-review" }),
      task({ id: "4", column: "done" }),
      task({ id: "5", column: "triage", columnFlags: { intake: true } }),
      task({ id: "6", column: "staging" }), // unmapped → other
      task({ id: "7", column: "deploying", columnFlags: { notify: true } }), // unmapped → other
      task({ id: "8", column: "blocked", columnFlags: { mergeBlocker: true } }),
    ];
    const grouped = groupTasksByBucket(tasks);
    const total = TUI_BUCKETS.reduce((n, b) => n + grouped[b].length, 0);
    expect(total).toBe(tasks.length);

    const allIds = TUI_BUCKETS.flatMap((b) => grouped[b].map((t) => t.id)).sort();
    expect(allIds).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);

    expect(grouped.todo.map((t) => t.id)).toEqual(["1", "5"]); // intake → todo
    expect(grouped["in-review"].map((t) => t.id)).toEqual(["3", "8"]); // mergeBlocker → in-review
    expect(grouped[OTHER_BUCKET].map((t) => t.id)).toEqual(["6", "7"]);
  });
});

describe("bucket ordering + labels", () => {
  it("orders 'other' between in-review and done", () => {
    expect([...TUI_BUCKETS]).toEqual(["todo", "in-progress", "in-review", OTHER_BUCKET, "done"]);
    const reviewIdx = TUI_BUCKETS.indexOf("in-review");
    const otherIdx = TUI_BUCKETS.indexOf(OTHER_BUCKET);
    const doneIdx = TUI_BUCKETS.indexOf("done");
    expect(otherIdx).toBeGreaterThan(reviewIdx);
    expect(otherIdx).toBeLessThan(doneIdx);
  });

  it("isOtherBucket flags only the catch-all", () => {
    expect(isOtherBucket(OTHER_BUCKET)).toBe(true);
    expect(isOtherBucket("done")).toBe(false);
  });

  it("secondary label uses the real column name, falling back to the id", () => {
    expect(otherBucketSecondaryLabel(task({ id: "a", column: "staging", columnName: "Staging area" }))).toBe("Staging area");
    expect(otherBucketSecondaryLabel(task({ id: "b", column: "qa-gate" }))).toBe("qa-gate");
  });
});
