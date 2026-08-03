import { describe, expect, it } from "vitest";
import { loadAllAppCss } from "../test/cssFixture";

/**
 * Viewport chrome alignment (tablet-class narrow widths).
 *
 * Surface enumeration:
 * - Left sidebar visibility (LeftSidebarNav.css)
 * - Mobile bottom tab bar visibility (MobileNavBar.css)
 * - Executor footer bottom stacking above mobile nav (ExecutorStatusBar.css)
 * - Footer height token on project-content (ProjectSelector.css + ExecutorStatusBar.css)
 * - Right dock hide/show (RightDock.css)
 * - data-viewport-mode publisher (useViewportMode.ts)
 *
 * Original symptom: mid-tablet / tablet-class ≤768 CSS px showed no left sidebar,
 * no bottom tab bar, and a floating footer overlapping board content with empty
 * space below (CSS elevated the footer for a mobile nav that JS never mounted).
 *
 * Assertion: shell chrome CSS keys display and footer stacking off
 * `html[data-viewport-mode="…"]` so tablet/desktop keep left sidebar + footer at
 * the true bottom even when the CSS width is still ≤768.
 */

const css = loadAllAppCss();

describe("viewport chrome mode alignment", () => {
  it("publishes mode-driven left sidebar show/hide that overrides the width-only hide", () => {
    expect(css).toMatch(
      /html:is\(\[data-viewport-mode="tablet"\],\s*\[data-viewport-mode="desktop"\]\)\s*\.left-sidebar-nav\s*\{[^}]*display:\s*flex/,
    );
    expect(css).toMatch(/html\[data-viewport-mode="mobile"\]\s*\.left-sidebar-nav\s*\{[^}]*display:\s*none/);
    // Width fallback remains for no-JS / first paint on true phones.
    expect(css).toMatch(/@media\s*\(\s*max-width:\s*768px\s*\)\s*\{[\s\S]*?\.left-sidebar-nav\s*\{[^}]*display:\s*none/);
  });

  it("publishes mode-driven mobile nav show/hide so tablet never reserves a phantom tab bar", () => {
    expect(css).toMatch(/html\[data-viewport-mode="mobile"\]\s*\.mobile-nav-bar\s*\{[^}]*display:\s*flex/);
    expect(css).toMatch(
      /html:is\(\[data-viewport-mode="tablet"\],\s*\[data-viewport-mode="desktop"\]\)\s*\.mobile-nav-bar\s*\{[^}]*display:\s*none/,
    );
  });

  it("pins the executor footer to the true bottom on tablet/desktop mode", () => {
    expect(css).toMatch(
      /html:is\(\[data-viewport-mode="tablet"\],\s*\[data-viewport-mode="desktop"\]\)\s*\.executor-status-bar\s*\{[^}]*bottom:\s*var\(--icb-bottom-offset,\s*0px\)/,
    );
    expect(css).toMatch(
      /html:is\(\[data-viewport-mode="tablet"\],\s*\[data-viewport-mode="desktop"\]\)\s*\.executor-status-bar\s*\{[^}]*height:\s*36px/,
    );
    // Mobile mode still elevates above the tab bar.
    expect(css).toMatch(
      /html\[data-viewport-mode="mobile"\]\s*\.executor-status-bar\s*\{[\s\S]*?bottom:\s*calc\([^)]*var\(--mobile-nav-height\)/,
    );
  });

  it("keeps the desktop footer-height token for tablet/desktop mode after mobile overrides", () => {
    // May share a declaration block with .dashboard-project-shell (comma selector).
    expect(css).toMatch(
      /html:is\(\[data-viewport-mode="tablet"\],\s*\[data-viewport-mode="desktop"\]\)\s*\.project-content--with-footer[\s\S]{0,180}?\{[^}]*--executor-footer-height:\s*36px/,
    );
    expect(css).toMatch(
      /html\[data-viewport-mode="mobile"\]\s*\.project-content--with-footer\s*\{[^}]*--executor-footer-height:\s*calc\(var\(--space-lg\)\s*\*\s*2\s*\+\s*var\(--space-xs\)\)/,
    );
  });

  it("aligns right-dock mobile hide with viewport mode", () => {
    expect(css).toMatch(/html\[data-viewport-mode="mobile"\]\s*\.right-dock\s*\{[^}]*display:\s*none/);
    expect(css).toMatch(
      /html:is\(\[data-viewport-mode="tablet"\],\s*\[data-viewport-mode="desktop"\]\)\s*\.right-dock\s*\{[^}]*display:\s*flex/,
    );
  });
});
