import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const APP_ROOT = path.resolve(__dirname, "..");
const LEFT_SIDEBAR_CSS_PATH = path.join(APP_ROOT, "components", "LeftSidebarNav.css");

function readLeftSidebarCss(): string {
  return readFileSync(LEFT_SIDEBAR_CSS_PATH, "utf8");
}

function extractRuleBody(source: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\}`));
  expect(match, `${selector} rule should exist in LeftSidebarNav.css`).not.toBeNull();
  return match?.[1] ?? "";
}

function extractGroupedRuleBody(source: string, selector: string): string {
  const sourceWithoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const match = [...sourceWithoutComments.matchAll(/(^|})\s*([^{}]+)\s*\{([\s\S]*?)\}/g)].find(([, , selectors]) =>
    selectors
      .split(",")
      .map((part) => part.trim())
      .includes(selector),
  );
  expect(match, `${selector} grouped rule should exist in LeftSidebarNav.css`).not.toBeNull();
  return match?.[3] ?? "";
}

describe("left sidebar active accent CSS", () => {
  /**
   * FNXC:DashboardStyling 2026-06-21-11:16:
   * jsdom cannot resolve custom properties reliably, so the left-sidebar theme-accent invariant is guarded by raw CSS text. The active item and resize handle must reference the universal --accent token and must not regress to workflow todo status tokens.
   */
  it("uses the theme accent token for active item and resize handle styling", () => {
    const source = readLeftSidebarCss();
    const activeItemBody = extractGroupedRuleBody(source, ".left-sidebar-nav__item--active");

    expect(activeItemBody).toContain("var(--accent)");
    expect(activeItemBody).not.toContain("var(--todo)");
    expect(activeItemBody).not.toContain("var(--todo-bg)");
    expect(activeItemBody).not.toContain("var(--status-todo-bg)");

    expect(source).toMatch(
      /\.left-sidebar-nav__resize-handle:hover::after,\s*\.left-sidebar-nav__resize-handle:focus-visible::after\s*\{[\s\S]*?background:\s*var\(--accent\);[\s\S]*?\}/,
    );
    expect(source).not.toContain("--todo");
  });
});
