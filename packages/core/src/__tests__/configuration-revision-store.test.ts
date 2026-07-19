import { describe, expect, it } from "vitest";
import {
  configurationTargetKey,
  createConfigurationRevision,
  diffConfigurationSnapshots,
} from "../async-configuration-revision-store.js";

describe("configuration revision snapshots", () => {
  it("uses canonical structured target identity independent of key order", () => {
    expect(configurationTargetKey({ workflowId: "wf-1", projectId: "p-1" }))
      .toBe(configurationTargetKey({ projectId: "p-1", workflowId: "wf-1" }));
  });

  it("does not create revisions for exact no-op snapshots", () => {
    expect(createConfigurationRevision({
      projectId: "project", ownerScope: "project", configKind: "project-settings",
      configTarget: { projectId: "project" }, before: { enabled: true }, after: { enabled: true },
      changedBy: { kind: "system", id: "system" },
    })).toBeNull();
  });

  it("captures deleted keys in a field diff", () => {
    expect(diffConfigurationSnapshots({ retained: 1, deleted: 2 }, { retained: 1 }))
      .toEqual([{ field: "deleted", oldValue: 2, newValue: undefined }]);
  });
});
