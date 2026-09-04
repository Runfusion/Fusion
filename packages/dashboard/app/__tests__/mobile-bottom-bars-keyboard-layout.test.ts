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

  it("both mobile executor status bar keyboard-open copies pin bottom to 0", () => {
    const copies = [
      /\.executor-status-bar\.executor-status-bar--keyboard-open\s*\{([^}]*)\}/m,
      /html\[data-viewport-mode="mobile"\] \.executor-status-bar\.executor-status-bar--keyboard-open\s*\{([^}]*)\}/m,
    ];
    for (const selector of copies) {
      const match = css.match(selector);
      expect(match).toBeTruthy();
      expect(match![1]).toContain("bottom: 0");
    }
  });

  it("places each mobile executor collapse rule after its lifted bottom reservation", () => {
    const mediaBasePos = css.indexOf("bottom: calc(var(--icb-bottom-offset, 0px) + var(--mobile-nav-height)");
    const mediaKeyboardPos = css.indexOf(".executor-status-bar.executor-status-bar--keyboard-open");
    const viewportBasePos = css.indexOf("html[data-viewport-mode=\"mobile\"] .executor-status-bar {");
    const viewportKeyboardPos = css.indexOf("html[data-viewport-mode=\"mobile\"] .executor-status-bar.executor-status-bar--keyboard-open");
    expect(mediaBasePos).toBeGreaterThanOrEqual(0);
    expect(mediaKeyboardPos).toBeGreaterThan(mediaBasePos);
    expect(viewportBasePos).toBeGreaterThan(mediaKeyboardPos);
    expect(viewportKeyboardPos).toBeGreaterThan(viewportBasePos);
  });

  it("keeps the lifted mobile reservation and desktop/tablet offset intact", () => {
    expect(css).toContain("bottom: calc(var(--icb-bottom-offset, 0px) + var(--mobile-nav-height)");
    const desktopRule = css.match(/html:is\(\[data-viewport-mode="tablet"\], \[data-viewport-mode="desktop"\]\) \.executor-status-bar\s*\{([^}]*)\}/m);
    expect(desktopRule).toBeTruthy();
    expect(desktopRule![1]).toContain("bottom: var(--icb-bottom-offset, 0px)");
  });
});
