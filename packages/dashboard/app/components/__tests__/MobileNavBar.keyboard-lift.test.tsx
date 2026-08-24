import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileNavBar } from "../MobileNavBar";
import { loadAllAppCss } from "../../test/cssFixture";

const css = loadAllAppCss();

function renderNav(keyboardOpen: boolean) {
  return render(<MobileNavBar view="board" onChangeView={() => undefined} footerVisible keyboardOpen={keyboardOpen} />);
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
    style = installCssHost();
  });
  afterEach(() => {
    style.remove();
    delete document.documentElement.dataset.viewportMode;
    document.body.replaceChildren();
  });

  it("pins and slides the portrait media-query nav class through the CSS cascade", () => {
    const { container } = renderNav(true);
    const nav = container.querySelector<HTMLElement>(".mobile-nav-bar");
    expect(nav).not.toBeNull();
    expect(nav).toHaveClass("mobile-nav-bar--keyboard-open");
    const resolved = getComputedStyle(nav!);
    expect(resolved.bottom).toBe("0px");
    expect(resolved.transform).toContain("translateY(100%)");
  });

  it("pins and slides the landscape data-viewport-mode nav class through the CSS cascade", () => {
    style.remove();
    style = installCssHost("mobile");
    const { container } = renderNav(true);
    const nav = container.querySelector<HTMLElement>(".mobile-nav-bar");
    expect(nav).not.toBeNull();
    const resolved = getComputedStyle(nav!);
    expect(resolved.bottom).toBe("0px");
    expect(resolved.transform).toContain("translateY(100%)");
  });

  it("keeps the resting ICB bottom offset when the keyboard class is absent", () => {
    const { container } = renderNav(false);
    const nav = container.querySelector<HTMLElement>(".mobile-nav-bar");
    expect(getComputedStyle(nav!).bottom).toContain("var(--icb-bottom-offset, 0px)");
  });
});
