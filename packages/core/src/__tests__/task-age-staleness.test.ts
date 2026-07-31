import { describe, expect, it } from "vitest";
import {
  DEFAULT_TASK_AGE_STALENESS_THRESHOLDS,
  getTaskAgeStalenessSignal,
} from "../task-age-staleness.js";

const NOW = Date.parse("2026-05-14T12:00:00.000Z");

const baseTask = {
  column: "in-progress" as const,
  paused: false,
  columnMovedAt: new Date(NOW).toISOString(),
  updatedAt: new Date(NOW).toISOString(),
  mergeDetails: {},
};

describe("getTaskAgeStalenessSignal", () => {
  it("returns undefined when under warning threshold", () => {
    const signal = getTaskAgeStalenessSignal(
      { ...baseTask, columnMovedAt: new Date(NOW - 60_000).toISOString() },
      { now: NOW },
    );
    expect(signal).toBeUndefined();
  });

  it("returns warning at warning threshold", () => {
    const signal = getTaskAgeStalenessSignal(
      { ...baseTask, columnMovedAt: new Date(NOW - DEFAULT_TASK_AGE_STALENESS_THRESHOLDS.inProgressWarningMs).toISOString() },
      { now: NOW },
    );
    expect(signal?.level).toBe("warning");
  });

  it("returns warning between warning and critical", () => {
    const signal = getTaskAgeStalenessSignal(
      { ...baseTask, columnMovedAt: new Date(NOW - DEFAULT_TASK_AGE_STALENESS_THRESHOLDS.inProgressWarningMs - 1_000).toISOString() },
      { now: NOW },
    );
    expect(signal?.level).toBe("warning");
  });

  it("returns critical at/over critical threshold", () => {
    const signal = getTaskAgeStalenessSignal(
      { ...baseTask, columnMovedAt: new Date(NOW - DEFAULT_TASK_AGE_STALENESS_THRESHOLDS.inProgressCriticalMs).toISOString() },
      { now: NOW },
    );
    expect(signal?.level).toBe("critical");
  });

  it("returns undefined for non-applicable columns", () => {
    expect(getTaskAgeStalenessSignal({ ...baseTask, column: "todo" }, { now: NOW })).toBeUndefined();
    expect(getTaskAgeStalenessSignal({ ...baseTask, column: "done" }, { now: NOW })).toBeUndefined();
  });

  it("includes paused=true in payload", () => {
    const signal = getTaskAgeStalenessSignal(
      {
        ...baseTask,
        column: "in-review",
        paused: true,
        columnMovedAt: new Date(NOW - DEFAULT_TASK_AGE_STALENESS_THRESHOLDS.inReviewWarningMs).toISOString(),
      },
      { now: NOW },
    );
    expect(signal?.paused).toBe(true);
  });

  it("suppresses signal when merge is confirmed", () => {
    expect(
      getTaskAgeStalenessSignal(
        {
          ...baseTask,
          columnMovedAt: new Date(NOW - DEFAULT_TASK_AGE_STALENESS_THRESHOLDS.inProgressCriticalMs).toISOString(),
          mergeDetails: { mergeConfirmed: true },
        },
        { now: NOW },
      ),
    ).toBeUndefined();
  });

  it("falls back to updatedAt when columnMovedAt missing", () => {
    const signal = getTaskAgeStalenessSignal(
      {
        ...baseTask,
        columnMovedAt: undefined,
        updatedAt: new Date(NOW - DEFAULT_TASK_AGE_STALENESS_THRESHOLDS.inProgressWarningMs).toISOString(),
      },
      { now: NOW },
    );
    expect(signal?.level).toBe("warning");
  });

  it("treats 0/undefined thresholds as disabled levels", () => {
    const signal = getTaskAgeStalenessSignal(
      {
        ...baseTask,
        columnMovedAt: new Date(NOW - DEFAULT_TASK_AGE_STALENESS_THRESHOLDS.inProgressWarningMs).toISOString(),
      },
      {
        now: NOW,
        thresholds: {
          inProgressWarningMs: DEFAULT_TASK_AGE_STALENESS_THRESHOLDS.inProgressWarningMs,
          inProgressCriticalMs: 0,
        },
      },
    );
    expect(signal?.level).toBe("warning");
    expect(signal?.criticalThresholdMs).toBe(0);
  });

  it("throws when critical threshold is below warning", () => {
    expect(() =>
      getTaskAgeStalenessSignal(
        {
          ...baseTask,
          column: "in-review",
          columnMovedAt: new Date(NOW - DEFAULT_TASK_AGE_STALENESS_THRESHOLDS.inReviewWarningMs).toISOString(),
        },
        {
          now: NOW,
          thresholds: {
            inReviewWarningMs: 10_000,
            inReviewCriticalMs: 9_000,
          },
        },
      )
    ).toThrowError(new RangeError("critical threshold must be >= warning threshold"));
  });

  it("suppresses age signal during activation grace warmup", () => {
    const signal = getTaskAgeStalenessSignal({
      ...baseTask,
      columnMovedAt: new Date(NOW - DEFAULT_TASK_AGE_STALENESS_THRESHOLDS.inProgressCriticalMs).toISOString(),
    }, {
      now: NOW,
      engineActiveSinceMs: NOW - 60_000,
      engineActivationGraceMs: 5 * 60_000,
    });
    expect(signal).toBeUndefined();
  });

  it("fires age signal when activation floor is far in the past", () => {
    const signal = getTaskAgeStalenessSignal({
      ...baseTask,
      columnMovedAt: new Date(NOW - DEFAULT_TASK_AGE_STALENESS_THRESHOLDS.inProgressCriticalMs).toISOString(),
    }, {
      now: NOW,
      engineActiveSinceMs: NOW - DEFAULT_TASK_AGE_STALENESS_THRESHOLDS.inProgressCriticalMs - 60_000,
      engineActivationGraceMs: 0,
    });
    expect(signal?.level).toBe("critical");
  });
});

/*
FNXC:WorkflowResolvedColumns 2026-07-31-08:25 (fleet phase — evidence for the lane gate):
Age-staleness applies ONLY to the mid-flight and review lanes; a card in a hold or terminal lane is
waiting or finished, not stale. Both lanes were named by id, so on a renamed board this returned
`undefined` for EVERY card and the stale-card warning never appeared anywhere on the board.

`lifecycle` is optional and every case above omits it, so they all keep asserting the legacy ids —
which is why none of them could have caught this.

REVERT CHECK, measured: restoring the `in-progress`/`in-review` literals makes the renamed-lane case
fail (`expected undefined to be defined`), and restoring the threshold selector's literal makes the
threshold case fail — it picks the review threshold for a card in the renamed WIP lane.
*/
describe("age staleness resolves its lanes by ROLE", () => {
  const RENAMED = { wip: "building", review: "checking" };
  const STALE_MOVED_AT = new Date(NOW - 72 * 60 * 60 * 1000).toISOString();

  it("produces a signal for a card in a RENAMED wip lane", () => {
    const signal = getTaskAgeStalenessSignal(
      { ...baseTask, column: "building" as never, columnMovedAt: STALE_MOVED_AT },
      { now: NOW, lifecycle: RENAMED },
    );
    expect(signal).toBeDefined();
  });

  it("produces a signal for a card in a RENAMED review lane", () => {
    const signal = getTaskAgeStalenessSignal(
      { ...baseTask, column: "checking" as never, columnMovedAt: STALE_MOVED_AT },
      { now: NOW, lifecycle: RENAMED },
    );
    expect(signal).toBeDefined();
  });

  it("still returns nothing for a hold lane on that renamed board", () => {
    // Non-vacuous: the gate must still EXCLUDE lanes that play neither role.
    expect(getTaskAgeStalenessSignal(
      { ...baseTask, column: "backlog" as never, columnMovedAt: STALE_MOVED_AT },
      { now: NOW, lifecycle: RENAMED },
    )).toBeUndefined();
  });

  it("selects the WIP threshold, not the review one, for a renamed wip lane", () => {
    /*
    The two threshold selectors are a separate literal from the gate above: converting only the gate
    would admit the card and then measure it against the REVIEW threshold, which is the wrong number
    and silently so.
    */
    const wipSignal = getTaskAgeStalenessSignal(
      { ...baseTask, column: "building" as never, columnMovedAt: STALE_MOVED_AT },
      { now: NOW, lifecycle: RENAMED, thresholds: { inProgressWarningMs: 1, inProgressCriticalMs: 2, inReviewWarningMs: 999 * 60 * 60 * 1000, inReviewCriticalMs: 999 * 60 * 60 * 1000 } },
    );
    // With a 1ms wip warning and a ~999h review warning, only the wip threshold can produce critical.
    expect(wipSignal?.level).toBe("critical");
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-23:59:
  CHARACTERIZATION, and it is honest about being one: this pins the value the signal already emitted.

  `TaskAgeStalenessSignal.column` was typed `"in-progress" | "in-review"` and filled through a cast
  whose comment said "the guard above proves `column` is one of these two legacy ids". That stopped
  being true when the guard was converted to compare against the RESOLVED wip/review lanes — from then
  on the cast asserted the opposite of what the guard established, while the runtime happily passed the
  renamed id through.

  So widening the type changes NO behaviour, and no runtime test can differentiate it; the thing that
  differentiates is `tsc`. Under the old narrow type a consumer writing `signal.column === "building"`
  got a compile error telling them the comparison was impossible — the type actively taught the wrong
  invariant. This case exists so the value is at least pinned, and so a future narrowing has something
  to break against besides a type error nobody sees until they hit it.

  The `as never` casts on the fixtures below are the same shape and stay: `ColumnId` is a union with a
  `string & {}` member, and these are deliberately ids no board declares.
  */
  it("reports the RENAMED lane id it matched, not a legacy one", () => {
    const signal = getTaskAgeStalenessSignal(
      { ...baseTask, column: "building" as never, columnMovedAt: STALE_MOVED_AT },
      { now: NOW, lifecycle: RENAMED },
    );

    expect(signal).toBeDefined();
    expect(signal?.column).toBe("building");
  });
});
