import { describe, expect, it } from "vitest";
import { loadAllAppCss } from "../test/cssFixture";

/**
 * Stylesheet regression test for Activity Log tablet layout.
 *
 * The desktop .modal-lg width is too narrow for the Activity Log header at
 * tablet widths, so a component-scoped tablet media block must widen only the
 * Activity Log modal and wrap the header controls. If these tablet rules are
 * removed, refresh/close can be clipped between 769px and 1024px.
 */
describe("activity-log-tablet-layout.css", () => {
  const cssContent = loadAllAppCss();

  function extractTabletMediaBlocks(content: string): string {
    const blocks: string[] = [];
    const regex = /@media[^{}]*\(min-width:\s*769px\)[^{}]*\(max-width:\s*1024px\)[^{}]*\{/g;
    let match: RegExpExecArray | null;

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

  const tabletCss = extractTabletMediaBlocks(cssContent);

  it("defines tablet Activity Log rules for the broken 769px–1024px range", () => {
    expect(tabletCss).toContain(".activity-log-modal");
    expect(tabletCss).toContain(".activity-log-header");
  });

  it("widens only the Activity Log modal beyond the modal-lg base width", () => {
    expect(tabletCss).toMatch(/\.activity-log-modal\s*\{[^}]*width:\s*calc\(100vw\s*-\s*var\(--space-2xl\)\)/);
    expect(tabletCss).toMatch(/\.activity-log-modal\s*\{[^}]*max-width:\s*calc\(100vw\s*-\s*var\(--space-2xl\)\)/);
  });

  it("does not redefine the global modal-lg width inside the tablet block", () => {
    expect(tabletCss).not.toMatch(/\.modal-lg\s*\{/);
  });

  it("allows the Activity Log header to wrap on tablet", () => {
    expect(tabletCss).toMatch(/\.activity-log-header\s*\{[^}]*flex-wrap:\s*wrap/);
  });

  it("moves actions to a reachable wrapping row on tablet", () => {
    expect(tabletCss).toMatch(/\.activity-log-actions\s*\{[^}]*flex:\s*1\s+1\s+100%/);
    expect(tabletCss).toMatch(/\.activity-log-actions\s*\{[^}]*flex-wrap:\s*wrap/);
  });

  it("keeps the close button pinned to the top-right row on tablet", () => {
    expect(tabletCss).toMatch(/\.activity-log-header\s+\.modal-close\s*\{[^}]*order:\s*\d/);
    expect(tabletCss).toMatch(/\.activity-log-header\s+\.modal-close\s*\{[^}]*margin-left:\s*auto/);
  });

  it("keeps filters and refresh/clear controls reachable when optional controls render", () => {
    expect(tabletCss).toMatch(/\.activity-log-filter,\s*\n\s*\.activity-log-filter--project\s*\{[^}]*flex:\s*1\s+1\s+0/);
    expect(tabletCss).toMatch(/\.activity-log-refresh,\s*\n\s*\.activity-log-clear\s*\{[^}]*flex-shrink:\s*0/);
  });
});
