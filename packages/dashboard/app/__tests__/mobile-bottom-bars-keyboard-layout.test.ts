import { describe, expect, it } from "vitest";
import { loadAllAppCss } from "../test/cssFixture";

const css = loadAllAppCss();

describe("mobile bottom bars keyboard-open css contract", () => {
  it("mobile nav keyboard-open rule pins bottom to 0", () => {
    const match = css.match(/\.mobile-nav-bar\.mobile-nav-bar--keyboard-open,\s*\.mobile-nav-bar\.mobile-nav-bar--with-footer\.mobile-nav-bar--keyboard-open\s*\{([^}]*)\}/m);
    expect(match).toBeTruthy();
    expect(match![1]).toContain("bottom: 0");
  });

  it("both portrait and viewport-mode keyboard-open copies pin and translate the nav", () => {
    const copies = [
      /\.mobile-nav-bar\.mobile-nav-bar--keyboard-open,\s*\.mobile-nav-bar\.mobile-nav-bar--with-footer\.mobile-nav-bar--keyboard-open\s*\{([^}]*)\}/m,
      /html\[data-viewport-mode="mobile"\] \.mobile-nav-bar\.mobile-nav-bar--keyboard-open,\s*html\[data-viewport-mode="mobile"\] \.mobile-nav-bar\.mobile-nav-bar--with-footer\.mobile-nav-bar--keyboard-open\s*\{([^}]*)\}/m,
    ];
    for (const selector of copies) {
      const match = css.match(selector);
      expect(match).toBeTruthy();
      expect(match![1]).toContain("bottom: 0");
      expect(match![1]).toContain("transform: translateY(100%)");
    }
  });

  it("mobile nav keyboard-open rule appears after with-footer rule", () => {
    const withFooterPos = css.indexOf(".mobile-nav-bar--with-footer");
    const keyboardPos = css.indexOf(".mobile-nav-bar.mobile-nav-bar--keyboard-open");
    expect(withFooterPos).toBeGreaterThanOrEqual(0);
    expect(keyboardPos).toBeGreaterThan(withFooterPos);
  });

  it("executor status bar keyboard-open rule pins bottom to 0", () => {
    const match = css.match(/\.executor-status-bar\.executor-status-bar--keyboard-open\s*\{([^}]*)\}/m);
    expect(match).toBeTruthy();
    expect(match![1]).toContain("bottom: 0");
  });

  it("executor status bar keyboard-open rule appears after mobile base bottom rule", () => {
    const mobileBasePos = css.indexOf("bottom: calc(var(--icb-bottom-offset, 0px) + var(--mobile-nav-height)");
    const keyboardPos = css.indexOf(".executor-status-bar.executor-status-bar--keyboard-open");
    expect(mobileBasePos).toBeGreaterThanOrEqual(0);
    expect(keyboardPos).toBeGreaterThan(mobileBasePos);
  });
});
