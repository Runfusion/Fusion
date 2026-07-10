import { describe, expect, it } from "vitest";
import {
  evaluateOverseerHumanControl,
  type OverseerHumanControlSettings,
  type OverseerHumanControlTask,
} from "../overseer-human-control-policy.js";

function task(overrides: Partial<OverseerHumanControlTask> = {}): OverseerHumanControlTask {
  return {
    userPaused: undefined,
    paused: undefined,
    pausedReason: undefined,
    status: undefined,
    autoMerge: undefined,
    prInfo: undefined,
    prInfos: undefined,
    ...overrides,
  };
}

function settings(overrides: Partial<OverseerHumanControlSettings> = {}): OverseerHumanControlSettings {
  return { autoMerge: true, ...overrides };
}

describe("evaluateOverseerHumanControl", () => {
  it("withholds with reason user-paused when task.userPaused is true", () => {
    const decision = evaluateOverseerHumanControl(task({ userPaused: true }), settings());
    expect(decision).toEqual({ withhold: true, reason: "user-paused" });
  });

  it("withholds with reason user-paused for a user-source task.paused (no pausedReason)", () => {
    const decision = evaluateOverseerHumanControl(task({ paused: true, pausedReason: undefined }), settings());
    expect(decision).toEqual({ withhold: true, reason: "user-paused" });
  });

  it("does NOT treat an engine/self-healing park (paused with a pausedReason) as user pause", () => {
    const decision = evaluateOverseerHumanControl(
      task({ paused: true, pausedReason: "branch-conflict-unrecoverable" }),
      settings(),
    );
    expect(decision.reason).not.toBe("user-paused");
    expect(decision).toEqual({ withhold: false });
  });

  it("withholds with reason auto-merge-off-human-review when settings.autoMerge is false and no per-task override", () => {
    const decision = evaluateOverseerHumanControl(task(), settings({ autoMerge: false }));
    expect(decision).toEqual({ withhold: true, reason: "auto-merge-off-human-review" });
  });

  it("withholds with reason auto-merge-off-human-review when settings.autoMerge false and task.autoMerge is also false", () => {
    const decision = evaluateOverseerHumanControl(task({ autoMerge: false }), settings({ autoMerge: false }));
    expect(decision).toEqual({ withhold: true, reason: "auto-merge-off-human-review" });
  });

  it("is NOT withheld when task.autoMerge:true overrides a global autoMerge:false", () => {
    const decision = evaluateOverseerHumanControl(task({ autoMerge: true }), settings({ autoMerge: false }));
    expect(decision).toEqual({ withhold: false });
  });

  it("is NOT withheld for a fully live task (no pause, auto-merge eligible)", () => {
    const decision = evaluateOverseerHumanControl(task(), settings());
    expect(decision).toEqual({ withhold: false });
  });

  it("handles undefined userPaused/paused/autoMerge states as not-withheld (defaults)", () => {
    const decision = evaluateOverseerHumanControl(
      task({ userPaused: undefined, paused: undefined, autoMerge: undefined }),
      settings({ autoMerge: true }),
    );
    expect(decision).toEqual({ withhold: false });
  });

  it("falls back to auto-merge-enabled defaults when settings is null/undefined", () => {
    expect(evaluateOverseerHumanControl(task(), undefined)).toEqual({ withhold: false });
    expect(evaluateOverseerHumanControl(task(), null)).toEqual({ withhold: false });
  });

  it("fails closed (withhold, no reason) when task is null/undefined", () => {
    expect(evaluateOverseerHumanControl(null, settings())).toEqual({ withhold: true });
    expect(evaluateOverseerHumanControl(undefined, settings())).toEqual({ withhold: true });
  });

  it("prioritizes user-paused over auto-merge-off when both conditions are true", () => {
    const decision = evaluateOverseerHumanControl(task({ userPaused: true }), settings({ autoMerge: false }));
    expect(decision).toEqual({ withhold: true, reason: "user-paused" });
  });

  // FN-7736: the planner overseer must keep withholding for a task blocked on
  // a pending human approval decision, via either hold mechanism, and must
  // NOT regress FN-7514's accidental "paused with no reason" hold once the
  // canonical durable reason is introduced.
  describe("approval hold (FN-7736)", () => {
    it("withholds with reason approval-blocked for the canonical pause-reason hold", () => {
      const decision = evaluateOverseerHumanControl(
        task({ paused: true, pausedReason: "awaiting-approval" }),
        settings(),
      );
      expect(decision).toEqual({ withhold: true, reason: "approval-blocked" });
    });

    it("withholds with reason approval-blocked for the status-based hold (triage plan-approval gate)", () => {
      const decision = evaluateOverseerHumanControl(
        task({ paused: false, status: "awaiting-approval" }),
        settings(),
      );
      expect(decision).toEqual({ withhold: true, reason: "approval-blocked" });
    });

    it("withholds approval-blocked (not auto-merge-off-human-review) even when settings.autoMerge is false", () => {
      const decision = evaluateOverseerHumanControl(
        task({ paused: true, pausedReason: "awaiting-approval" }),
        settings({ autoMerge: false }),
      );
      expect(decision).toEqual({ withhold: true, reason: "approval-blocked" });
    });

    it("does not classify a bare user pause (no reason) as approval-blocked -- still user-paused", () => {
      const decision = evaluateOverseerHumanControl(task({ paused: true, pausedReason: undefined }), settings());
      expect(decision).toEqual({ withhold: true, reason: "user-paused" });
    });

    it("does not classify an engine park with a different reason as approval-blocked", () => {
      const decision = evaluateOverseerHumanControl(
        task({ paused: true, pausedReason: "branch-conflict-unrecoverable" }),
        settings(),
      );
      expect(decision).toEqual({ withhold: false });
    });
  });
});
