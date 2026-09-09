import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { TransitionRejectionError } from "@fusion/core";

import {
  formatLifecycleMoveLog,
  registerLifecycleMoveLog,
} from "../execution/lifecycle-move-log.js";
import { moveTaskWithLifecycleReason } from "../execution/lifecycle-move.js";

const lanes = {
  intake: "ideas",
  hold: "planning",
  wip: "implementation",
  review: "review",
  complete: "done",
  terminal: ["done"],
};

describe("lifecycle move legibility", () => {
  /*
  FNXC:LifecycleContainment 2026-08-28-04:47:
  FN-207 symptom: a forward graph transition carries no `lifecycleReason` (that registry is for
  explicit BACKWARD moves), so before the emitter forwarded `workflowMoveSource` every routine
  advance logged as "unattributed automatic move". "Unattributed" must mean the mover declared
  nothing — never that the log discarded a declared cause.
  */
  it("attributes a forward graph transition to its mover instead of calling it unattributed", () => {
    const line = formatLifecycleMoveLog({
      task: { id: "FN-207" }, from: "implementation", to: "review", source: "engine",
      requestedSource: "engine", workflowMoveSource: "workflow-graph", lanes,
    });

    expect(line).toBe("Lifecycle move: implementation → review (forward) — workflow-graph transition [source=engine]");
    expect(line).not.toContain("unattributed");
  });

  it("prefers a registered backward reason over raw provenance when both are present", () => {
    expect(formatLifecycleMoveLog({
      task: { id: "FN-207" }, from: "review", to: "implementation", source: "engine",
      requestedSource: "engine", lifecycleReason: "code-review-revise-remediation",
      workflowMoveSource: "workflow-graph", lanes,
    })).toContain("— Code Review REVISE requested implementation fixes [source=engine]");
  });

  it("attributes any non-graph provenance verbatim rather than inventing a cause", () => {
    expect(formatLifecycleMoveLog({
      task: { id: "FN-207" }, from: "implementation", to: "review", source: "engine",
      requestedSource: "engine", workflowMoveSource: "merge-boundary", lanes,
    })).toContain("— merge-boundary transition [source=engine]");
  });

  it.each([
    ["scheduler hold release", "scheduler-hold-release", "planning", "implementation", "scheduler"],
    ["normal auto-merge finalization", "auto-merge-finalization", "review", "done", "engine"],
    ["recovery auto-merge finalization", "auto-merge-finalization", "planning", "done", "engine"],
    ["legacy merger completion", "merger-complete-task", "review", "done", "engine"],
  ] as const)("renders %s provenance instead of unattributed automatic move", (_name, workflowMoveSource, from, to, source) => {
    const line = formatLifecycleMoveLog({
      task: { id: "FN-255" }, from, to, source, requestedSource: source, workflowMoveSource, lanes,
    });

    expect(line).toContain(`— ${workflowMoveSource} transition`);
    expect(line).not.toContain("unattributed automatic move");
  });

  it("still reports a genuinely causeless move as unattributed", () => {
    expect(formatLifecycleMoveLog({
      task: { id: "FN-207" }, from: "implementation", to: "review", source: "engine",
      requestedSource: "engine", workflowMoveSource: "   ", lanes,
    })).toContain("— unattributed automatic move [source=engine]");
  });

  it("writes the attributed cause through the registered listener, not only the formatter", async () => {
    const emitter = new EventEmitter();
    const logEntry = vi.fn(async () => undefined);
    const unregister = registerLifecycleMoveLog({
      on: emitter.on.bind(emitter),
      off: emitter.off.bind(emitter),
      logEntry,
    } as never);

    emitter.emit("task:moved", {
      task: { id: "FN-207" }, from: "implementation", to: "review", source: "engine",
      requestedSource: "engine", workflowMoveSource: "workflow-graph", lanes,
    });
    await Promise.resolve();

    expect(logEntry).toHaveBeenCalledWith("FN-207", expect.stringContaining("workflow-graph transition"));
    unregister();
  });

  it("formats forward, backward, user, and unclassified moves with an attributable cause", () => {
    expect(formatLifecycleMoveLog({
      task: { id: "FN-207" }, from: "planning", to: "implementation", source: "engine",
      requestedSource: "engine", lanes,
    })).toBe("Lifecycle move: planning → implementation (forward) — unattributed automatic move [source=engine]");

    expect(formatLifecycleMoveLog({
      task: { id: "FN-207" }, from: "review", to: "implementation", source: "engine",
      requestedSource: "engine", lifecycleReason: "code-review-revise-remediation", lanes,
    })).toBe("Lifecycle move: review → implementation (backward) — Code Review REVISE requested implementation fixes [source=engine]");

    expect(formatLifecycleMoveLog({
      task: { id: "FN-207" }, from: "review", to: "planning", source: "user",
      requestedSource: "user", lanes,
    })).toContain("(backward) — unattributed automatic move [source=user]");

    expect(formatLifecycleMoveLog({
      task: { id: "FN-207" }, from: "custom-a", to: "custom-b", source: "scheduler",
    })).toContain("(unclassified)");
  });

  it("writes exactly one line for each real event and unregisters cleanly", async () => {
    const emitter = new EventEmitter();
    const logEntry = vi.fn(async () => undefined);
    const store = {
      on: emitter.on.bind(emitter),
      off: emitter.off.bind(emitter),
      logEntry,
    };
    const unregister = registerLifecycleMoveLog(store as never);

    const event = {
      task: { id: "FN-207" }, from: "review", to: "implementation", source: "engine" as const,
      requestedSource: "engine" as const, lifecycleReason: "code-review-revise-remediation", lanes,
    };
    emitter.emit("task:moved", event);
    emitter.emit("task:moved", { ...event, from: "review", to: "review" });
    await Promise.resolve();

    expect(logEntry).toHaveBeenCalledTimes(1);
    expect(logEntry).toHaveBeenCalledWith("FN-207", expect.stringContaining("review → implementation (backward)"));

    unregister();
    emitter.emit("task:moved", event);
    await Promise.resolve();
    expect(logEntry).toHaveBeenCalledTimes(1);
  });

  it("defers a capacity-refused backward move in place without retargeting", async () => {
    const capacityError = new TransitionRejectionError({
      code: "capacity-exhausted",
      messageKey: "transition.rejected.capacityExhausted",
      retryable: true,
      detail: "implementation is full",
    }, "implementation is full");
    const row = { id: "FN-207", column: "review" };
    const store = {
      moveTask: vi.fn(async () => { throw capacityError; }),
      getTask: vi.fn(async () => row),
      logEntry: vi.fn(async () => undefined),
    };

    await expect(moveTaskWithLifecycleReason(
      store as never,
      row.id,
      "implementation",
      "code-review-revise-remediation",
      { moveSource: "engine" },
    )).resolves.toEqual({ moved: false, deferred: "capacity", detail: "implementation is full" });

    expect(row.column).toBe("review");
    expect(store.moveTask).toHaveBeenCalledTimes(1);
    expect(store.logEntry).toHaveBeenCalledWith(
      row.id,
      "Lifecycle move deferred: review → implementation (backward) — Code Review REVISE requested implementation fixes (destination at capacity; retrying later)",
    );
  });
});
