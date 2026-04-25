import { describe, expect, it } from "vitest";
import { loadAllAppCss } from "../test/cssFixture";

const css = loadAllAppCss();

function getRule(selector: string, options: { last?: boolean } = {}): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...css.matchAll(new RegExp(`${escapedSelector}\\s*\\{[^}]*\\}`, "g"))];
  expect(matches.length, `Expected CSS rule for ${selector}`).toBeGreaterThan(0);

  if (options.last) {
    return matches[matches.length - 1]?.[0] ?? "";
  }

  return matches[0]?.[0] ?? "";
}

describe("Dev server view CSS layout regressions", () => {
  it("allows vertical page scrolling to keep all controls reachable on short viewports", () => {
    const rootRule = getRule(".dev-server-view");
    expect(rootRule).toContain("overflow-y: auto");
    expect(rootRule).toContain("overflow-x: hidden");
  });

  it("keeps config and candidate lists scrollable with bounded height", () => {
    const configRule = getRule(".dev-server-config");
    expect(configRule).toContain("max-height: min(52vh, calc(var(--space-2xl) * 16))");
    expect(configRule).toContain("overflow-y: auto");

    const candidatesRule = getRule(".dev-server-candidates");
    expect(candidatesRule).toContain("max-height: min(36vh, calc(var(--space-2xl) * 9))");
    expect(candidatesRule).toContain("overflow-y: auto");
  });

  it("renders fullscreen log viewer above fixed chrome layers", () => {
    const fullscreenRule = getRule(".devserver-log-viewer--fullscreen");
    const zIndexMatch = fullscreenRule.match(/z-index:\s*(\d+)/);
    expect(zIndexMatch).toBeTruthy();

    const zIndex = Number.parseInt(zIndexMatch?.[1] ?? "0", 10);
    expect(zIndex).toBeGreaterThan(50);
  });

  it("separates warning fallback styling from external-only mode", () => {
    const fallbackRule = getRule(".dev-server-preview-fallback", { last: true });
    const externalOnlyRule = getRule(".dev-server-preview-external-only", { last: true });

    expect(fallbackRule).toContain("var(--color-warning)");
    expect(externalOnlyRule).toContain("border: 1px solid var(--border)");
    expect(externalOnlyRule).toContain("background: var(--surface)");
    expect(externalOnlyRule).not.toContain("--color-warning");
  });

  it("keeps the preview header responsive on narrow screens", () => {
    const badgeRule = getRule(".devserver-preview-url-badge");
    expect(badgeRule).toContain("flex: 1 1 auto");
    expect(badgeRule).toContain("min-width: 0");

    const mobileHeaderRule = getRule(".devserver-preview-header", { last: true });
    expect(mobileHeaderRule).toContain("flex-wrap: wrap");

    const mobileActionsRule = getRule(".devserver-preview-actions", { last: true });
    expect(mobileActionsRule).toContain("width: 100%");
    expect(mobileActionsRule).toContain("justify-content: flex-end");
  });
});
