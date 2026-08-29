import { describe, expect, it } from "vitest";
import { loadAllAppCss, loadAllAppCssBaseOnly } from "../../test/cssFixture";

describe("TaskDetailModal GitHub tracking enable button CSS contract", () => {
  it("FN-4164 keeps desktop compact while restoring token-based mobile touch-target sizing", async () => {
    const baseCss = await loadAllAppCssBaseOnly();
    const css = await loadAllAppCss();

    expect(baseCss).toMatch(
      /\.detail-github-tracking-enable\s*\{[^}]*min-width\s*:\s*0\s*;[^}]*min-height\s*:\s*0\s*;[^}]*padding-block\s*:\s*calc\(var\(--space-xs\)\s*\/\s*2\)\s*;/,
    );

    const mobileMediaStart = css.indexOf("@media (max-width: 768px)");
    expect(mobileMediaStart).toBeGreaterThanOrEqual(0);
    const mobileCss = css.slice(mobileMediaStart);

    expect(mobileCss).toMatch(
      /\.detail-github-tracking-section\s+\.detail-github-tracking-enable\s*\{[^}]*min-height\s*:\s*calc\(var\(--space-lg\)\s*\+\s*var\(--space-xl\)\s*-\s*var\(--space-xs\)\)\s*;[^}]*padding-block\s*:\s*var\(--space-xs\)\s*;/,
    );
  });
});
