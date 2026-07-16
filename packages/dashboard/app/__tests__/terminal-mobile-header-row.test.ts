import { describe, it, expect } from "vitest";
import { loadAllAppCss } from "../test/cssFixture";

const css = loadAllAppCss();
const terminalSectionStart = css.indexOf("Terminal Modal Mobile Responsive");
const terminalMobileSection =
  terminalSectionStart >= 0 ? css.slice(terminalSectionStart) : "";

function findRuleBody(selector: RegExp): string {
  const match = terminalMobileSection.match(
    new RegExp(selector.source + /\s*\{([^}]*)\}/.source),
  );
  return match?.[1] ?? "";
}

describe("terminal mobile header row CSS contract", () => {
  it("lets the mobile terminal header wrap intentionally without clipping actions", () => {
    const ruleBody = findRuleBody(/\.terminal-header/);

    expect(ruleBody).toContain("flex-wrap: wrap");
    expect(ruleBody).toContain("row-gap: var(--space-xs)");
    expect(ruleBody).toContain("overflow: hidden");
  });

  it("hides the desktop tab strip and exposes the mobile selector surface", () => {
    const desktopTabsRule = findRuleBody(/\.terminal-tabs/);
    const mobileSelectorRule = findRuleBody(/\.terminal-mobile-tabs/);

    expect(desktopTabsRule).toContain("display: none");
    expect(mobileSelectorRule).toContain("display: flex");
    expect(mobileSelectorRule).toContain("min-width: 0");
    expect(mobileSelectorRule).not.toContain("flex: 1 1 100%");
    expect(mobileSelectorRule).not.toContain("min-width: 100%");
  });

  it("renders no .terminal-actions shell in the mobile header (FN-7560: actions moved to footer)", () => {
    const primaryMobileSlice = terminalMobileSection.split("@media (max-width: 768px)")[1]?.split("@media")[0] ?? "";
    const bareHeaderActions = primaryMobileSlice.match(/(?:^|[^\w.-])\.terminal-actions\s*\{([^}]*)\}/);
    if (bareHeaderActions) {
      const body = bareHeaderActions[1] ?? "";
      expect(body).not.toMatch(/display\s*:/);
      expect(body).not.toMatch(/flex-wrap\s*:/);
      expect(body).not.toMatch(/position\s*:/);
    }
  });

  it("gives the mobile footer action cluster the horizontal-scroll flex-scroll pattern (FN-7560)", () => {
    const ruleBody = css.match(/\.terminal-status-bar\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(ruleBody).toContain("min-width: 0");
    expect(ruleBody).toContain("overflow-x: auto");
    expect(ruleBody).not.toContain("flex: 1 1 100%");
  });

  it("defines dedicated spacing between the clear and shortcuts buttons", () => {
    const ruleBody = css.match(/\.terminal-clear-btn--shortcut\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(ruleBody).toContain("margin-left: var(--space-xs)");
  });
});
