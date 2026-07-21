import { describe, expect, it } from "vitest";
import { reconcileMissionFeatureState } from "../mission-feature-sync.js";

describe("reconcileMissionFeatureState", () => {
  it("keeps assertion validation as the completion gate for research-derived features", async () => {
    const decision = await reconcileMissionFeatureState(
      { getTask: async () => undefined } as never,
      { id: "FN-1", column: "done", status: "completed" } as never,
      { id: "F-1", status: "in-progress", lastValidatorStatus: "failed" } as never,
      { hasLinkedAssertions: true },
    );
    expect(decision).toEqual(expect.objectContaining({ kind: "noop" }));
  });

  it("reconciles return and active board states without fabricating completion", async () => {
    const taskStore = { getTask: async () => undefined } as never;
    await expect(reconcileMissionFeatureState(taskStore, { id: "FN-1", column: "todo", status: "pending" } as never, { id: "F-1", status: "in-progress" } as never)).resolves.toMatchObject({ kind: "update", status: "triaged" });
    await expect(reconcileMissionFeatureState(taskStore, { id: "FN-1", column: "triage" } as never, { id: "F-1", status: "in-progress" } as never)).resolves.toMatchObject({ kind: "update", status: "triaged" });
    await expect(reconcileMissionFeatureState(taskStore, { id: "FN-1", column: "in-review", status: "in-progress" } as never, { id: "F-1", status: "triaged" } as never)).resolves.toMatchObject({ kind: "update", status: "in-progress" });
    await expect(reconcileMissionFeatureState(taskStore, { id: "FN-1", column: "in-progress" } as never, { id: "F-1", status: "defined" } as never)).resolves.toMatchObject({ kind: "update", status: "in-progress" });
  });

  it("keeps archived and failed task outcomes as idempotent non-completion", async () => {
    const taskStore = { getTask: async () => undefined } as never;
    await expect(reconcileMissionFeatureState(taskStore, { id: "FN-1", column: "archived" } as never, { id: "F-1", status: "in-progress" } as never)).resolves.toEqual({ kind: "noop" });
    await expect(reconcileMissionFeatureState(taskStore, { id: "FN-1", column: "todo", status: "failed", error: "BLOCKED" } as never, { id: "F-1", status: "triaged" } as never)).resolves.toMatchObject({ kind: "failure" });
  });
});
