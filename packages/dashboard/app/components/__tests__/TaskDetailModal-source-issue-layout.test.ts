import { describe, expect, it } from "vitest";
import { loadAllAppCss, loadAllAppCssBaseOnly } from "../../test/cssFixture";

describe("TaskDetailModal source issue layout CSS contract", () => {
  it("FN-4267 keeps the source issue chevron anchored on the header row", async () => {
    const baseCss = await loadAllAppCssBaseOnly();
    const css = await loadAllAppCss();

    expect(baseCss).toMatch(
      /\.detail-source-section\s+\.detail-source-header\s*\{[^}]*flex-wrap\s*:\s*nowrap\s*;[^}]*align-items\s*:\s*center\s*;/,
    );
    expect(baseCss).toMatch(
      /\.detail-source-section\s+\.detail-source-toggle\s*\{[^}]*flex\s*:\s*0\s+0\s+auto\s*;/,
    );

    expect(css).not.toMatch(
      /@media[^{]*\(max-width:\s*768px\)[^{]*\{[\s\S]*?\.detail-source-section\s+\.detail-source-summary\s*\{[^}]*flex\s*:\s*1\s+1\s+100%\s*;/,
    );
    expect(css).toMatch(
      /@media[^{]*\(max-width:\s*768px\)[^{]*\{[\s\S]*?\.detail-source-section\s+\.detail-source-summary\s*\{[^}]*flex\s*:\s*1\s+1\s+auto\s*;[^}]*min-width\s*:\s*0\s*;/,
    );
  });
});
