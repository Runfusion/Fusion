import { describe, expect, it } from "vitest";
import { loadAllAppCss } from "../test/cssFixture";

const css = loadAllAppCss();

describe("mobile bottom bars keyboard-open css contract", () => {
  it("keeps the official pill above the visual viewport occlusion", () => {
    const alphaRule = css.match(/\.mobile-nav-bar--native\s*\{([^}]*)\}/m);
    expect(alphaRule).toBeTruthy();
    expect(alphaRule![1]).toContain("bottom: var(--mobile-nav-pill-bottom)");
    expect(css).toContain("--mobile-nav-pill-bottom: calc(var(--mobile-nav-system-offset) + var(--mobile-nav-floating-gap) + var(--mobile-nav-keyboard-lift))");
    expect(alphaRule![1]).not.toContain("translateY(100%)");
    expect(alphaRule![1]).not.toContain("pointer-events: none");
  });

  it("includes the shifted visual viewport top in the popover height cap", () => {
    const popoverRule = css.match(/\.mobile-navigation-popover\s*\{([^}]*)\}/m);
    expect(popoverRule).toBeTruthy();
    expect(css).toContain("--mobile-nav-viewport-offset-top: 0px");
    expect(popoverRule![1]).toContain("var(--mobile-nav-viewport-offset-top)");
    expect(popoverRule![1]).toContain("env(safe-area-inset-top, 0px)");
  });

  it("limits the legacy keyboard hide rules to the non-pill bar", () => {
    expect(css).toContain(".mobile-nav-bar:not(.mobile-nav-bar--native).mobile-nav-bar--keyboard-open");
    expect(css).toContain('html[data-viewport-mode="mobile"] .mobile-nav-bar:not(.mobile-nav-bar--native).mobile-nav-bar--keyboard-open');
  });

  it("mobile nav keyboard-open rule appears after with-footer rule", () => {
    const withFooterPos = css.indexOf(".mobile-nav-bar--with-footer");
    const keyboardPos = css.indexOf(".mobile-nav-bar:not(.mobile-nav-bar--native).mobile-nav-bar--keyboard-open");
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
