import { describe, expect, it } from "vitest";
import * as AppModule from "../App";
import { getBoardTaskOpenRoute } from "../App";

/*
FNXC:TaskDetailDefaultTab 2026-09-16-02:53:
FN-442 removed the `openTasksInRightSidebar` and `openMobileTasksInPopup` project settings, so the board/list/detail-chip
task-open decision has a single input left. The invariant proven here is "any task open outside the mobile drawer is the
floating task window". `shouldOpenBoardTaskInDock` and the `"dock"` route it fed were deleted with their setting, so the
cases that asserted them are removed rather than kept asserting a deliberately removed contract. The App-mounted proof that
a real board card and a real Changes chip reach the window lives in `components/__tests__/App.test.tsx`; List row and
keyboard opens are proven in `components/__tests__/ListView.test.tsx`.
*/
describe("board task detail routing", () => {
  it("routes a mobile-drawer open to the main panel", () => {
    expect(getBoardTaskOpenRoute({ mobileDrawerActive: true })).toBe("main-panel");
  });

  it("routes desktop, tablet, and mobile-without-drawer opens to the task popup", () => {
    expect(getBoardTaskOpenRoute({ mobileDrawerActive: false })).toBe("popup");
  });

  it("no longer exposes a right-dock board routing decision", () => {
    expect("shouldOpenBoardTaskInDock" in AppModule).toBe(false);
  });
});
