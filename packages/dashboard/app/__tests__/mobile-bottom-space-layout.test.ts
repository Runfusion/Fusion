import { afterEach, describe, expect, it } from "vitest";
import { loadAllAppCss } from "../test/cssFixture";
import { computePublishedMobileNavHeight } from "../components/MobileNavBar";

function extractMobileMediaBlocks(content: string): string {
  const blocks: string[] = [];
  const regex = /@media[^{}]*\(max-width:\s*768px\)[^{]*\{/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    const startIdx = match.index + match[0].length;
    let braceCount = 1;
    let endIdx = startIdx;
    while (braceCount > 0 && endIdx < content.length) {
      if (content[endIdx] === "{") braceCount += 1;
      if (content[endIdx] === "}") braceCount -= 1;
      endIdx += 1;
    }
    if (braceCount === 0) {
      blocks.push(content.slice(startIdx, endIdx - 1));
    }
  }

  return blocks.join("\n");
}

function extractRuleBlock(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\}`));
  return match?.[1] ?? "";
}

function normalizeCss(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

interface BottomStackInput {
  footerVisible: boolean;
  mobileNavVisible: boolean;
  keyboardOpen: boolean;
  safeAreaFloor: number;
  standaloneGap: number;
  icbBottomOffset: number;
  executorFooterHeight: number;
  mobileNavHeight: number;
}

function visibleFixedBottomStack(input: BottomStackInput): number {
  if (input.keyboardOpen || !input.mobileNavVisible) return 0;

  const navSurface = input.mobileNavHeight + input.safeAreaFloor + input.standaloneGap;
  const footer = input.footerVisible ? input.executorFooterHeight : 0;
  return navSurface + footer + input.icbBottomOffset;
}

function reservedProjectContentBottom(input: BottomStackInput): number {
  if (input.keyboardOpen || !input.mobileNavVisible) return 0;

  const navSurface = input.mobileNavHeight + input.safeAreaFloor + input.standaloneGap;
  const footer = input.footerVisible ? input.executorFooterHeight : 0;
  return navSurface + footer + input.icbBottomOffset;
}

describe("mobile bottom-space layout invariant", () => {
  const css = loadAllAppCss();
  const mobileCss = extractMobileMediaBlocks(css);

  afterEach(() => {
    document.body.replaceChildren();
    document.documentElement.style.removeProperty("--mobile-nav-height");
    delete document.documentElement.dataset.viewportMode;
  });

  it.each([
    ["nav only / healthy viewport", { footerVisible: false, mobileNavVisible: true, keyboardOpen: false, safeAreaFloor: 12, standaloneGap: 0, icbBottomOffset: 0, executorFooterHeight: 36, mobileNavHeight: 44 }],
    ["footer + nav / iPhone PWA safe area", { footerVisible: true, mobileNavVisible: true, keyboardOpen: false, safeAreaFloor: 34, standaloneGap: 8, icbBottomOffset: 0, executorFooterHeight: 36, mobileNavHeight: 44 }],
    ["footer + nav / compensated visual viewport", { footerVisible: true, mobileNavVisible: true, keyboardOpen: false, safeAreaFloor: 34, standaloneGap: 8, icbBottomOffset: 52, executorFooterHeight: 36, mobileNavHeight: 44 }],
    ["keyboard open / bars covered", { footerVisible: true, mobileNavVisible: true, keyboardOpen: true, safeAreaFloor: 34, standaloneGap: 8, icbBottomOffset: 0, executorFooterHeight: 36, mobileNavHeight: 44 }],
    ["mobile nav hidden", { footerVisible: false, mobileNavVisible: false, keyboardOpen: false, safeAreaFloor: 34, standaloneGap: 8, icbBottomOffset: 0, executorFooterHeight: 36, mobileNavHeight: 44 }],
  ] satisfies Array<[string, BottomStackInput]>)("reserves exactly the visible fixed stack for %s", (_name, input) => {
    expect(reservedProjectContentBottom(input)).toBe(visibleFixedBottomStack(input));
  });

  it("mobile project-content reservation includes only fixed bottom-bar stack terms", () => {
    const navOnlyRule = normalizeCss(extractRuleBlock(mobileCss, ".project-content--with-mobile-nav:not(.project-content--with-footer)"));
    const footerAndNavRule = normalizeCss(extractRuleBlock(mobileCss, ".project-content--with-footer.project-content--with-mobile-nav"));

    expect(navOnlyRule).toContain("padding-bottom: calc(var(--mobile-nav-height) + max(env(safe-area-inset-bottom, 0px), 12px) + var(--standalone-bottom-gap) + var(--icb-bottom-offset, 0px))");
    expect(footerAndNavRule).toContain("var(--executor-footer-height) + var(--mobile-nav-height) + max(env(safe-area-inset-bottom, 0px), 12px) + var(--standalone-bottom-gap) + var(--icb-bottom-offset, 0px)");
    expect(footerAndNavRule).not.toContain("100vh");
    expect(footerAndNavRule).not.toContain("100dvh");
  });

  it("ancre le drawer Alpha sous la pill tout en gardant la réserve système dans sa surface", () => {
    const drawerRule = normalizeCss(extractRuleBlock(css, ".alpha-mobile-drawer"));
    const drawerPanelRule = normalizeCss(extractRuleBlock(css, ".alpha-mobile-drawer__panel"));
    const drawerBodyRule = normalizeCss(extractRuleBlock(css, ".alpha-mobile-drawer__body"));
    const navRule = normalizeCss(extractRuleBlock(css, ".mobile-nav-bar"));
    const alphaContentRule = normalizeCss(extractRuleBlock(css, 'html[data-viewport-mode="mobile"] .project-content--with-alpha-nav'));
    const alphaBoardRule = normalizeCss(extractRuleBlock(css, '[data-alpha-surface="true"] .board'));
    const skeletonRule = normalizeCss(extractRuleBlock(css, ".board.board-workflows-skeleton"));

    expect(drawerRule).toContain("inset: 0 var(--icb-right-offset, 0px) 0 0");
    expect(drawerRule).toContain("z-index: var(--z-popover)");
    expect(drawerRule).not.toContain("padding-block-end");
    expect(drawerPanelRule).toContain("height: var(--alpha-mobile-drawer-block-size)");
    expect(drawerPanelRule).toContain("max-height: var(--alpha-mobile-drawer-block-size)");
    expect(drawerPanelRule).not.toContain("var(--mobile-nav-height)");
    expect(drawerPanelRule).not.toContain("var(--mobile-nav-alpha-system-offset)");
    expect(drawerBodyRule).toContain("padding-block-end: var(--mobile-nav-alpha-system-offset)");
    expect(navRule).toContain("z-index: 45");
    expect(extractRuleBlock(css, ":root")).toContain("--z-popover: 60");
    expect(alphaContentRule).toContain("var(--mobile-nav-height) + var(--mobile-nav-alpha-system-offset)");
    expect(alphaBoardRule).toContain("--board-padding: var(--alpha-density-3)");
    expect(skeletonRule).toContain("height: 100%");
    expect(skeletonRule).toContain("min-height: 0");
    expect(alphaBoardRule).not.toContain("padding-block-end");
    expect(alphaBoardRule).not.toContain("--mobile-nav-height");
    expect(alphaBoardRule).not.toContain("--mobile-nav-alpha-system-offset");
    expect(alphaBoardRule).not.toContain("env(safe-area-inset-bottom");
    expect(css.match(/--mobile-nav-height:\s*44px/g)).toHaveLength(1);
  });

  it.each([
    ["portrait sans inset", 0, 0, 0, true],
    ["portrait standalone avec safe area", 34, 8, 0, true],
    ["paysage avec compensation ICB", 12, 0, 52, true],
    ["paysage clavier ouvert et pill masquée", 12, 0, 52, false],
  ])("garde le bord du drawer à zéro et sa réserve interne en %s", (_name, safeArea, standalone, icb, pillVisible) => {
    const internalSystemClearance = icb + Math.max(safeArea, 12) + standalone;
    const externalBottomOffset = 0;

    expect(externalBottomOffset).toBe(0);
    expect(internalSystemClearance).toBeGreaterThanOrEqual(12);
    expect(pillVisible ? externalBottomOffset : externalBottomOffset).toBe(0);
  });

  it("aligne les adaptations FloatingWindow et Terminal sur le même bord inférieur", () => {
    const floatingOverlay = normalizeCss(extractRuleBlock(css, 'html[data-alpha-mobile-drawers="true"][data-viewport-mode="mobile"] .floating-window-overlay--alpha-mobile-drawer'));
    const floatingPanel = normalizeCss(extractRuleBlock(css, 'html[data-alpha-mobile-drawers="true"][data-viewport-mode="mobile"] .floating-window--alpha-mobile-drawer'));
    const floatingBody = normalizeCss(extractRuleBlock(css, 'html[data-alpha-mobile-drawers="true"][data-viewport-mode="mobile"] .floating-window--alpha-mobile-drawer .floating-window__body'));
    const terminalOverlay = normalizeCss(extractRuleBlock(css, 'html[data-alpha-mobile-drawers="true"][data-viewport-mode="mobile"] .terminal-modal-overlay:not(.terminal-modal-overlay--docked)'));
    const terminalPanel = normalizeCss(extractRuleBlock(css, 'html[data-alpha-mobile-drawers="true"][data-viewport-mode="mobile"] .terminal-modal-overlay:not(.terminal-modal-overlay--docked) > .terminal-modal'));

    expect(floatingOverlay).toContain("inset: 0 var(--icb-right-offset, 0px) 0 0");
    expect(floatingOverlay).not.toContain("padding-block-end");
    expect(floatingPanel).toContain("height: var(--alpha-mobile-drawer-block-size) !important");
    expect(floatingPanel).toContain("max-height: var(--alpha-mobile-drawer-block-size) !important");
    expect(floatingPanel).not.toContain("var(--mobile-nav-alpha-system-offset)");
    expect(floatingBody).toContain("padding-block-end: var(--mobile-nav-alpha-system-offset)");
    expect(terminalOverlay).not.toContain("padding-block-end");
    expect(terminalPanel).toContain("height: var(--alpha-mobile-drawer-block-size)");
    expect(terminalPanel).toContain("max-height: var(--alpha-mobile-drawer-block-size)");
    expect(terminalPanel).toContain("padding-block-end: var(--mobile-nav-alpha-system-offset)");
    expect(terminalPanel).not.toContain("var(--mobile-nav-height)");
  });

  it("keeps board and list content height parent-relative on mobile and desktop", () => {
    const boardRule = extractRuleBlock(css, ".board");
    const listRule = extractRuleBlock(css, ".list-view");
    const mobileBoardRule = extractRuleBlock(mobileCss, ".board");
    const mobileListRule = extractRuleBlock(mobileCss, ".list-view");

    expect(boardRule).toContain("height: 100%");
    expect(listRule).toContain("height: 100%");
    expect(`${mobileBoardRule}\n${mobileListRule}`).not.toMatch(/height\s*:\s*(?:calc\()?100d?vh/);
  });

  it("publishes nav content height from tab boxes when Safari leaves safe-area padding unresolved", () => {
    expect(
      computePublishedMobileNavHeight({
        navOffsetHeight: 122,
        paddingBottom: Number.NaN,
        tabHeights: [44, 44, 44],
      }),
    ).toBe(44);
  });

  it("falls back to offset minus resolved padding when tab boxes are unavailable", () => {
    expect(
      computePublishedMobileNavHeight({
        navOffsetHeight: 86,
        paddingBottom: 42,
        tabHeights: [],
      }),
    ).toBe(44);
  });

  it("bounds non-finite Alpha measurements and counts the floating gap once", () => {
    expect(computePublishedMobileNavHeight({ navOffsetHeight: Number.NaN, paddingBottom: Number.NaN, tabHeights: [Number.NaN], floatingGap: Number.POSITIVE_INFINITY })).toBe(44);
    expect(computePublishedMobileNavHeight({ navOffsetHeight: 54, paddingBottom: 0, tabHeights: [44], floatingGap: 8 })).toBe(62);
  });
});
