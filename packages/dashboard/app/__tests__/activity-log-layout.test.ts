import { describe, it, expect } from "vitest";
import { loadAllAppCss } from "../test/cssFixture";

/**
 * Stylesheet regression test for Activity Log modal layout.
 *
 * Parses the app CSS bundle and asserts that desktop viewport constraints
 * keep the modal on screen while mobile rules keep controls usable on
 * narrow screens.
 */

describe("activity-log-layout.css", () => {
  const cssContent = loadAllAppCss();

  /** Extract all content inside @media (max-width: 768px) blocks. */
  function extractMobileMediaBlocks(content: string): string {
    const blocks: string[] = [];
    const regex = /@media[^{]*\(max-width: 768px\)[^{]*\{/g;
    let match;

    while ((match = regex.exec(content)) !== null) {
      const startIdx = match.index + match[0].length;
      let braceCount = 1;
      let endIdx = startIdx;
      while (braceCount > 0 && endIdx < content.length) {
        if (content[endIdx] === "{") braceCount++;
        if (content[endIdx] === "}") braceCount--;
        endIdx++;
      }
      if (braceCount === 0) {
        blocks.push(content.slice(startIdx, endIdx - 1));
      }
    }
    return blocks.join("\n");
  }

  const mobileCss = extractMobileMediaBlocks(cssContent);

  // ── Modal sizing ────────────────────────────────────────────────────

  it("keeps desktop modal width within the viewport", () => {
    const modalBlock = cssContent.match(/\.activity-log-modal\s*\{[^}]*\}/)?.[0];
    expect(modalBlock).toBeTruthy();
    expect(modalBlock).toContain("width: min(95vw, 640px);");
    expect(modalBlock).toContain("max-width: 95vw;");
  });

  it("keeps desktop modal height inside the visible viewport", () => {
    const modalBlock = cssContent.match(/\.activity-log-modal\s*\{[^}]*\}/)?.[0];
    expect(modalBlock).toBeTruthy();
    expect(modalBlock).toMatch(/max-height:\s*calc\(100dvh - var\(--overlay-padding-top,\s*10vh\) - 16px\);/);
    expect(modalBlock).toContain("overflow: hidden;");
  });

  it("allows content pane to shrink and scroll inside the capped modal", () => {
    const contentBlock = cssContent.match(
      /\.activity-log-content\s*\{(?=[^}]*overflow-y:\s*auto;)(?=[^}]*min-height:\s*0;)[^}]*\}/,
    )?.[0];
    expect(contentBlock).toBeTruthy();
    expect(contentBlock).toContain("overflow-y: auto;");
    expect(contentBlock).toContain("min-height: 0;");
  });

  // ── Close button ────────────────────────────────────────────────────

  it("does not define a custom activity-log-close style (uses shared modal-close)", () => {
    // The modal should use the shared .modal-close class instead of a custom close button
    expect(cssContent).not.toMatch(/\.activity-log-close\s*\{/);
  });

  it("keeps close button on top row with title via explicit flex order", () => {
    // The .modal-close inside activity-log-header has an explicit order value so it
    // stays on the first row with the title (not pushed to a wrapped row by .activity-log-actions).
    expect(mobileCss).toMatch(/\.activity-log-header\s+\.modal-close\s*\{[^}]*order:\s*\d/);
  });

  it("pins close button to right edge via margin-left:auto", () => {
    // The .modal-close inside activity-log-header must be pushed to the right edge
    // of the first row using margin-left:auto
    expect(mobileCss).toMatch(/\.activity-log-header\s+\.modal-close\s*\{[^}]*margin-left:\s*auto/);
  });

  it("title participates in top row via flex:1 1 auto", () => {
    // The .activity-log-title should flex to fill available space in the top row
    expect(mobileCss).toMatch(/\.activity-log-title\s*\{[^}]*flex:\s*1\s+1\s+auto/);
  });

  // ── Modal header / actions ──────────────────────────────────────────

  it("has mobile rule for activity-log-header to wrap on narrow screens", () => {
    expect(mobileCss).toMatch(/\.activity-log-header\s*\{[^}]*flex-wrap:\s*wrap/);
  });

  it("has mobile rule for activity-log-actions to wrap and fill full width", () => {
    expect(mobileCss).toMatch(/\.activity-log-actions\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(mobileCss).toMatch(/\.activity-log-actions\s*\{[^}]*flex:\s*1\s+1\s+100%/);
  });

  // ── Filter controls ─────────────────────────────────────────────────

  it("has mobile rule for filter containers to fill available width", () => {
    expect(mobileCss).toMatch(/\.activity-log-filter/);
    expect(mobileCss).toMatch(/\.activity-log-filter--project/);
  });

  it("has mobile rule for project filter to fill available width", () => {
    // Project filter selector must have mobile-specific width handling
    expect(mobileCss).toMatch(/\.activity-log-filter--project\s*\{[^}]*flex:\s*1\s+1\s+0/);
  });

  it("has mobile rule for filter selects to fill width", () => {
    expect(mobileCss).toMatch(/\.activity-log-filter-select\s*\{[^}]*width:\s*100%/);
  });

  // ── Active filters bar ──────────────────────────────────────────────

  it("has mobile rule for active-filters bar to wrap", () => {
    expect(mobileCss).toMatch(/\.activity-log-active-filters\s*\{[^}]*flex-wrap:\s*wrap/);
  });

  it("resets clear-filters margin-left on mobile so it doesn't force right", () => {
    expect(mobileCss).toMatch(/\.activity-log-clear-filters\s*\{[^}]*margin-left:\s*0/);
  });

  // ── Entry layout ────────────────────────────────────────────────────

  it("has mobile rule for entry details to wrap with word-break", () => {
    expect(mobileCss).toMatch(/\.activity-log-entry-details\s*\{[^}]*word-break:\s*break-word/);
  });

  it("has mobile rule for entry text to break words", () => {
    expect(mobileCss).toMatch(/\.activity-log-entry-text\s*\{[^}]*word-break:\s*break-word/);
  });

  it("has mobile rule for entry headers to wrap", () => {
    expect(mobileCss).toMatch(/\.activity-log-entry-header\s*\{[^}]*flex-wrap:\s*wrap/);
  });

  // ── Confirmation dialog ─────────────────────────────────────────────

  it("has mobile rule for confirm actions to stack vertically", () => {
    expect(mobileCss).toMatch(/\.activity-log-confirm-actions\s*\{[^}]*flex-direction:\s*column/);
  });

  it("has mobile rule for confirm buttons to fill width", () => {
    expect(mobileCss).toMatch(/\.activity-log-confirm-cancel[^}]*width:\s*100%/);
    expect(mobileCss).toMatch(/\.activity-log-confirm-clear[^}]*width:\s*100%/);
  });
});
