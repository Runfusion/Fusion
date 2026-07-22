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

  it("routes ordinary board card clicks to the popup on mobile, tablet, and desktop when enabled", () => {
    for (const isMobile of [true, false]) {
      expect(getBoardTaskOpenRoute({
        isMobile,
        openMobileTasksInPopup: true,
        openTasksInRightSidebar: false,
        rightDockActive: false,
      })).toBe("popup");
    }
  });

  it("keeps setting-off and undefined values on the existing fallback route", () => {
    expect(getBoardTaskOpenRoute({
      isMobile: true,
      openMobileTasksInPopup: false,
      openTasksInRightSidebar: false,
      rightDockActive: false,
    })).toBe("main-panel");

    expect(getBoardTaskOpenRoute({
      isMobile: false,
      openMobileTasksInPopup: undefined as unknown as boolean,
      openTasksInRightSidebar: false,
      rightDockActive: false,
    })).toBe("main-panel");
  });

  it("gives the popup setting deterministic precedence over desktop and tablet right-dock routing", () => {
    expect(getBoardTaskOpenRoute({
      isMobile: false,
      openMobileTasksInPopup: true,
      openTasksInRightSidebar: true,
      rightDockActive: true,
    })).toBe("popup");

    expect(getBoardTaskOpenRoute({
      isMobile: false,
      openMobileTasksInPopup: false,
      openTasksInRightSidebar: true,
      rightDockActive: true,
    })).toBe("dock");

    expect(getBoardTaskOpenRoute({
      isMobile: false,
      openMobileTasksInPopup: true,
      openTasksInRightSidebar: false,
      rightDockActive: true,
    })).toBe("popup");
  });

  it("routes every board-card deep tab to the popup when enabled", () => {
    for (const initialTab of ["changes", "retries", "workflow"] as const) {
      for (const isMobile of [true, false]) {
        expect(getBoardTaskOpenRoute({
          isMobile,
          openMobileTasksInPopup: true,
          openTasksInRightSidebar: true,
          rightDockActive: true,
          initialTab,
        })).toBe("popup");
      }
    }
  });

  it("keeps a popup-disabled changes deep link in the main panel", () => {
    expect(getBoardTaskOpenRoute({
      isMobile: false,
      openMobileTasksInPopup: false,
      openTasksInRightSidebar: true,
      rightDockActive: true,
      initialTab: "changes",
    })).toBe("main-panel");
  });
});
