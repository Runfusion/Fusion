import { afterEach, describe, expect, it } from "vitest";
import { computeMobileBarKeyboardFlags, getMobileKeyboardLayoutViewportHeight } from "../mobileBarKeyboardFlags";

const initialClientHeightDescriptor = Object.getOwnPropertyDescriptor(document.documentElement, "clientHeight");
const initialInnerHeightDescriptor = Object.getOwnPropertyDescriptor(window, "innerHeight");

afterEach(() => {
  if (initialClientHeightDescriptor) Object.defineProperty(document.documentElement, "clientHeight", initialClientHeightDescriptor);
  else delete (document.documentElement as { clientHeight?: number }).clientHeight;
  if (initialInnerHeightDescriptor) Object.defineProperty(window, "innerHeight", initialInnerHeightDescriptor);
  else delete (window as { innerHeight?: number }).innerHeight;
});

describe("mobile keyboard layout metrics", () => {
  it("prefers the resized document viewport over stale Android innerHeight", () => {
    Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 544 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
    expect(getMobileKeyboardLayoutViewportHeight()).toBe(544);
  });
});

describe("computeMobileBarKeyboardFlags", () => {
  it("hides and collapses the mobile footer when the keyboard is open", () => {
    const flags = computeMobileBarKeyboardFlags({
      isMobile: true, keyboardFocusPending: false, keyboardOpen: true, navigationViewportActive: true, anyModalOpen: false, overlayOpen: false,
    });

    expect(flags).toEqual({ footerHidden: true, navKeyboardOpen: true, footerKeyboardOpen: true });
  });

  it("collapses the footer as soon as mobile keyboard focus is pending", () => {
    const flags = computeMobileBarKeyboardFlags({
      isMobile: true, keyboardFocusPending: true, keyboardOpen: false, navigationViewportActive: false, anyModalOpen: false, overlayOpen: false,
    });

    expect(flags).toEqual({ footerHidden: false, navKeyboardOpen: true, footerKeyboardOpen: true });
  });

  it.each([
    ["modal", true, false],
    ["fullscreen overlay", false, true],
  ])("keeps board padding settled while collapsing the footer over a %s", (_surface, anyModalOpen, overlayOpen) => {
    const flags = computeMobileBarKeyboardFlags({
      isMobile: true, keyboardFocusPending: false, keyboardOpen: true, navigationViewportActive: true, anyModalOpen, overlayOpen,
    });

    expect(flags).toEqual({ footerHidden: false, navKeyboardOpen: true, footerKeyboardOpen: true });
  });

  it("keeps only navigation placed while the visual viewport finishes closing", () => {
    expect(computeMobileBarKeyboardFlags({
      isMobile: true, keyboardFocusPending: false, keyboardOpen: false, navigationViewportActive: true, anyModalOpen: false, overlayOpen: false,
    })).toEqual({ footerHidden: false, navKeyboardOpen: true, footerKeyboardOpen: false });
  });

  it("returns all false when the mobile keyboard and navigation viewport are closed", () => {
    expect(computeMobileBarKeyboardFlags({
      isMobile: true, keyboardFocusPending: false, keyboardOpen: false, navigationViewportActive: false, anyModalOpen: false, overlayOpen: false,
    })).toEqual({ footerHidden: false, navKeyboardOpen: false, footerKeyboardOpen: false });
  });

  it("returns all false outside the mobile viewport", () => {
    expect(computeMobileBarKeyboardFlags({
      isMobile: false, keyboardFocusPending: true, keyboardOpen: true, navigationViewportActive: true, anyModalOpen: true, overlayOpen: true,
    })).toEqual({ footerHidden: false, navKeyboardOpen: false, footerKeyboardOpen: false });
  });
});
