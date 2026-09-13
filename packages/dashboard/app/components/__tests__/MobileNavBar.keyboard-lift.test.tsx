import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeMobileNavKeyboardLift, MobileNavBar } from "../MobileNavBar";
import { loadAllAppCss } from "../../test/cssFixture";

const css = loadAllAppCss();
const initialClientHeightDescriptor = Object.getOwnPropertyDescriptor(document.documentElement, "clientHeight");

function renderNav(
  keyboardOpen: boolean,
  keyboardMetrics = { keyboardOverlap: 0, viewportHeight: null as number | null, viewportOffsetTop: 0 },
  alphaMenuOpen = false,
) {
  return render(
    <MobileNavBar
      view="board"
      onChangeView={() => undefined}
      footerVisible
      keyboardOpen={keyboardOpen}
      keyboardMetrics={keyboardMetrics}
      alphaMenuOpen={alphaMenuOpen}
    />,
  );
}

function installCssHost(mode?: "mobile") {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  if (mode) document.documentElement.dataset.viewportMode = mode;
  return style;
}

describe("MobileNavBar keyboard lift CSS", () => {
  let style: HTMLStyleElement;

  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes("max-width: 768px"), media: query,
        addEventListener: vi.fn(), removeEventListener: vi.fn(),
      })),
    });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
    style = installCssHost();
  });
  afterEach(() => {
    style.remove();
    delete document.documentElement.dataset.viewportMode;
    document.body.replaceChildren();
    if (initialClientHeightDescriptor) {
      Object.defineProperty(document.documentElement, "clientHeight", initialClientHeightDescriptor);
    } else {
      delete (document.documentElement as { clientHeight?: number }).clientHeight;
    }
  });

  it("lifts the portrait pill by the iOS visual-viewport occlusion without hiding it", () => {
    const { container } = renderNav(true, { keyboardOverlap: 300, viewportHeight: 544, viewportOffsetTop: 0 });
    const nav = container.querySelector<HTMLElement>(".mobile-nav-bar");
    expect(nav).not.toBeNull();
    expect(nav).toHaveClass("mobile-nav-bar--keyboard-open");
    expect(nav).toHaveStyle({ "--mobile-nav-keyboard-lift": "300px" });
    const resolved = getComputedStyle(nav!);
    expect(resolved.transform).not.toContain("translateY(100%)");
    expect(resolved.pointerEvents).not.toBe("none");
  });

  it("publishes the shifted iOS viewport geometry on both fixed siblings", () => {
    const { container } = renderNav(true, { keyboardOverlap: 300, viewportHeight: 504, viewportOffsetTop: 40 }, true);
    const nav = container.querySelector<HTMLElement>(".mobile-nav-bar");
    const popover = container.querySelector<HTMLElement>(".alpha-mobile-navigation-popover");
    expect(nav).not.toBeNull();
    expect(popover).not.toBeNull();

    for (const property of [
      "--mobile-nav-floating-gap",
      "--mobile-nav-keyboard-lift",
      "--mobile-nav-viewport-offset-top",
      "--mobile-nav-pill-bottom",
      "--mobile-nav-popover-bottom",
    ]) {
      expect(popover!.style.getPropertyValue(property)).toBe(nav!.style.getPropertyValue(property));
      expect(popover!.style.getPropertyValue(property)).not.toBe("");
    }
    expect(popover).toHaveStyle({
      "--mobile-nav-keyboard-lift": "300px",
      "--mobile-nav-viewport-offset-top": "40px",
    });
  });

  it.each([
    ["synchronisé", 544],
    ["périmé", 844],
  ])("does not double-lift an Android resizes-content viewport with %s innerHeight", (_label, innerHeight) => {
    Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 544 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: innerHeight });
    const { container } = renderNav(true, { keyboardOverlap: 300, viewportHeight: 544, viewportOffsetTop: 0 });
    expect(container.querySelector<HTMLElement>(".mobile-nav-bar")).toHaveStyle({ "--mobile-nav-keyboard-lift": "0px" });
  });

  it("uses the same lift contract for landscape data-viewport-mode rendering", () => {
    style.remove();
    style = installCssHost("mobile");
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 430 });
    const { container } = renderNav(true, { keyboardOverlap: 210, viewportHeight: 220, viewportOffsetTop: 0 });
    const nav = container.querySelector<HTMLElement>(".mobile-nav-bar");
    expect(nav).toHaveStyle({ "--mobile-nav-keyboard-lift": "210px" });
    expect(getComputedStyle(nav!).transform).not.toContain("translateY(100%)");
  });

  it("keeps the resting ICB bottom offset when the keyboard class is absent", () => {
    const { container } = renderNav(false);
    const nav = container.querySelector<HTMLElement>(".mobile-nav-bar");
    expect(nav).toHaveStyle({ "--mobile-nav-keyboard-lift": "0px" });
    expect(getComputedStyle(nav!).transform).not.toContain("translateY(100%)");
  });

  it("bounds malformed overlap values to the actual visible occlusion", () => {
    expect(computeMobileNavKeyboardLift({ keyboardOpen: true, keyboardOverlap: 999, viewportHeight: 500, viewportOffsetTop: 20, layoutViewportHeight: 800 })).toBe(280);
    expect(computeMobileNavKeyboardLift({ keyboardOpen: false, keyboardOverlap: 300, viewportHeight: 500, viewportOffsetTop: 0, layoutViewportHeight: 800 })).toBe(0);
  });
});
