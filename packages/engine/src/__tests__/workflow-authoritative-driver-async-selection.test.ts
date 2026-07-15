import { describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskDetail, WorkflowParitySummary } from "@fusion/core";

import { WorkflowAuthoritativeDriver } from "../workflow-authoritative-driver.js";

const cleanParity: WorkflowParitySummary = {
  observed: 3,
  agreed: 3,
  drift: 0,
  agreeRate: 1,
  driftFieldCounts: {},
  recentDrift: [],
};

/*
FNXC:WorkflowSelection 2026-07-14-17:06:
Authoritative workflow cutover must not claim a PostgreSQL task whose selection is available only through the asynchronous store API. The synchronous reader in this fixture deliberately returns no result to model the retired backend compatibility path.
*/
describe("WorkflowAuthoritativeDriver PostgreSQL selection guard", () => {
  it("awaits the asynchronous selection and falls back when a workflow is already selected", async () => {
    const getTaskWorkflowSelectionAsync = vi.fn(async () => ({
      workflowId: "WF-postgres",
      stepIds: [],
    }));
    const getTaskWorkflowSelection = vi.fn(() => undefined);
    const driver = new WorkflowAuthoritativeDriver({
      store: {
        getSettings: vi.fn(async () => ({
          experimentalFeatures: { workflowInterpreterAuthoritative: true },
        }) as Settings),
        getWorkflowParitySummary: vi.fn(() => cleanParity),
        getTask: vi.fn(async () => ({ id: "FN-ASYNC" }) as TaskDetail),
        getTaskWorkflowSelection,
        getTaskWorkflowSelectionAsync,
      },
      executor: {
        createAuthoritativeWorkflowSeams: vi.fn(() => {
          throw new Error("selection guard should prevent graph execution");
        }),
      },
      minimumObservedRuns: 3,
    });

    const result = await driver.maybeRun({ id: "FN-ASYNC" } as Task);

    expect(result).toMatchObject({
      handled: false,
      disposition: "fell-back",
      reason: "workflow selection already present (WF-postgres)",
    });
    expect(getTaskWorkflowSelectionAsync).toHaveBeenCalledWith("FN-ASYNC");
    expect(getTaskWorkflowSelection).not.toHaveBeenCalled();
  });
});
