import { describe, expect, it } from "vitest";
import { computeMobileBarKeyboardFlags } from "../mobileBarKeyboardFlags";

describe("computeMobileBarKeyboardFlags", () => {
  it("hides and collapses the mobile footer when the keyboard is open", () => {
    const flags = computeMobileBarKeyboardFlags({
      isMobile: true, keyboardFocusPending: false, keyboardOpen: true, anyModalOpen: false, overlayOpen: false,
    });

    expect(flags).toEqual({ footerHidden: true, navKeyboardOpen: true, footerKeyboardOpen: true });
  });

  it("collapses the footer as soon as mobile keyboard focus is pending", () => {
    const flags = computeMobileBarKeyboardFlags({
      isMobile: true, keyboardFocusPending: true, keyboardOpen: false, anyModalOpen: false, overlayOpen: false,
    });

    expect(flags).toEqual({ footerHidden: false, navKeyboardOpen: true, footerKeyboardOpen: true });
  });

  it.each([
    ["modal", true, false],
    ["fullscreen overlay", false, true],
  ])("keeps board padding settled while collapsing the footer over a %s", (_surface, anyModalOpen, overlayOpen) => {
    const flags = computeMobileBarKeyboardFlags({
      isMobile: true, keyboardFocusPending: false, keyboardOpen: true, anyModalOpen, overlayOpen,
    });

    expect(flags).toEqual({ footerHidden: false, navKeyboardOpen: true, footerKeyboardOpen: true });
  });

  it("returns all false when the mobile keyboard is closed", () => {
    expect(computeMobileBarKeyboardFlags({
      isMobile: true, keyboardFocusPending: false, keyboardOpen: false, anyModalOpen: false, overlayOpen: false,
    })).toEqual({ footerHidden: false, navKeyboardOpen: false, footerKeyboardOpen: false });
  });

  it("returns all false outside the mobile viewport", () => {
    expect(computeMobileBarKeyboardFlags({
      isMobile: false, keyboardFocusPending: true, keyboardOpen: true, anyModalOpen: true, overlayOpen: true,
    })).toEqual({ footerHidden: false, navKeyboardOpen: false, footerKeyboardOpen: false });
  });
});
