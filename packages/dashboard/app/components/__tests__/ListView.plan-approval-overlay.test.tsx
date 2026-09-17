import { describe, expect, it } from "vitest";
import { readAppFile } from "../../test/cssFixture";

const source = readAppFile("components/ListView.tsx");
const notices = source.match(/<PlanApprovalNotice\b[^>]*variant="list"[^>]*\/>/g) ?? [];

/*
FNXC:PlanApproval 2026-09-16-05:01:
FN-448 keeps BOTH inline List notices (they sit in the row flow and hide nothing) while the board
card's full-bleed overlay is gone. Each notice must also receive `onOpenTaskRecord`, or a messaged
human decision's "Review plan" button renders permanently disabled.
*/
describe("ListView plan approval overlays", () => {
  it.each([
    ["compact card path", 0],
    ["table status-cell path", 1],
  ])("renders a fully wired notice in the %s", (_label, index) => {
    expect(notices).toHaveLength(2);
    expect(notices[index]).toContain("projectId={projectId}");
    expect(notices[index]).toContain("addToast={addToast}");
    expect(notices[index]).toContain("isPlanningLane={isPlanningLaneForTask(task)}");
    expect(notices[index]).toContain("onOpenTaskRecord={onOpenDetail}");
  });

  it("resolves both list paths from the shared pre-implementation lane helper", () => {
    expect(source).toContain("isPreImplementationColumnRole(getTaskColumnFlags(task), task.column)");
    expect(source.match(/isPlanningLane=\{isPlanningLaneForTask\(task\)\}/g)).toHaveLength(2);
  });
});
