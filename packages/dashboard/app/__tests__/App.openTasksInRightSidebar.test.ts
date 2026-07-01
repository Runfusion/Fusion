import { describe, expect, it } from "vitest";
import { getBoardTaskOpenRoute, shouldOpenBoardTaskInDock } from "../App";

describe("board task detail routing", () => {
  it("opens board card clicks in the dock only when the setting and dock surface are both active", () => {
    expect(shouldOpenBoardTaskInDock(true, true)).toBe(true);
    expect(shouldOpenBoardTaskInDock(false, true)).toBe(false);
    expect(shouldOpenBoardTaskInDock(true, false)).toBe(false);
  });

  it("keeps deep-tab opens on the existing main-panel path", () => {
    expect(shouldOpenBoardTaskInDock(true, true, "changes")).toBe(false);
    expect(shouldOpenBoardTaskInDock(true, true, "retries")).toBe(false);
    expect(shouldOpenBoardTaskInDock(true, true, "workflow")).toBe(false);
  });

  it("routes mobile board card clicks to the popup only when the mobile popup setting is enabled", () => {
    expect(getBoardTaskOpenRoute({
      isMobile: true,
      openMobileTasksInPopup: true,
      openTasksInRightSidebar: false,
      rightDockActive: false,
    })).toBe("popup");

    expect(getBoardTaskOpenRoute({
      isMobile: true,
      openMobileTasksInPopup: false,
      openTasksInRightSidebar: false,
      rightDockActive: false,
    })).toBe("main-panel");
  });

  it("preserves desktop and tablet right-dock routing precedence", () => {
    expect(getBoardTaskOpenRoute({
      isMobile: false,
      openMobileTasksInPopup: true,
      openTasksInRightSidebar: true,
      rightDockActive: true,
    })).toBe("dock");

    expect(getBoardTaskOpenRoute({
      isMobile: false,
      openMobileTasksInPopup: true,
      openTasksInRightSidebar: false,
      rightDockActive: true,
    })).toBe("main-panel");
  });

  it("keeps deep-tab opens off the mobile popup path", () => {
    for (const initialTab of ["changes", "retries", "workflow"] as const) {
      expect(getBoardTaskOpenRoute({
        isMobile: true,
        openMobileTasksInPopup: true,
        openTasksInRightSidebar: true,
        rightDockActive: true,
        initialTab,
      })).toBe("main-panel");
    }
  });
});
