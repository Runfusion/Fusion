import { describe, expect, it } from "vitest";
import { readAppFile } from "../../test/cssFixture";

const source = readAppFile("components/ListView.tsx");
const notices = source.match(/<PlanApprovalNotice\b[^>]*variant="list"[^>]*\/>/g) ?? [];

describe("ListView plan approval overlays", () => {
  it("renders the notice in the compact card path", () => {
    expect(notices[0]).toContain("projectId={projectId}");
    expect(notices[0]).toContain("isPlanningLane={isPlanningLaneForTask(task)}");
  });

  it("renders the notice in the table status-cell path", () => {
    expect(notices).toHaveLength(2);
    expect(notices[1]).toContain("projectId={projectId}");
    expect(notices[1]).toContain("addToast={addToast}");
    expect(notices[1]).toContain("isPlanningLane={isPlanningLaneForTask(task)}");
  });

  it("resolves both list paths from the shared pre-implementation lane helper", () => {
    expect(source).toContain("isPreImplementationColumnRole(getTaskColumnFlags(task), task.column)");
    expect(source.match(/isPlanningLane=\{isPlanningLaneForTask\(task\)\}/g)).toHaveLength(2);
  });
});
