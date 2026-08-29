import { describe, expect, it } from "vitest";
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
});
