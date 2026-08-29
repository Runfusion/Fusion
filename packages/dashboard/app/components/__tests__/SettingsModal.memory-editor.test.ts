import { describe, expect, it } from "vitest";
import { loadAllAppCss } from "../../test/cssFixture";

function extractMediaBlocks(css: string, mediaQuery: string): string[] {
  const blocks: string[] = [];
  let searchFrom = 0;

  while (searchFrom < css.length) {
    const start = css.indexOf(mediaQuery, searchFrom);
    if (start < 0) break;

    const openBrace = css.indexOf("{", start);
    expect(openBrace).toBeGreaterThanOrEqual(0);

    let depth = 1;
    let end = -1;
    for (let i = openBrace + 1; i < css.length; i += 1) {
      if (css[i] === "{") depth += 1;
      if (css[i] === "}") depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }

    if (end < 0) {
      throw new Error(`Unable to extract media block for ${mediaQuery}`);
    }

    blocks.push(css.slice(openBrace + 1, end));
    searchFrom = end + 1;
  }

  return blocks;
}

describe("FN-4416 SettingsModal memory editor mobile height", () => {
  it("keeps base 50vh and mobile min-height at or above desktop", async () => {
    const css = await loadAllAppCss();

    const baseMatch = css.match(/\.memory-editor-frame\s*\{[^}]*min-height\s*:\s*(\d+(?:\.\d+)?)vh\s*;[^}]*\}/);
    expect(baseMatch).not.toBeNull();
    const baseHeight = Number(baseMatch?.[1]);
    expect(baseHeight).toBe(50);

    const mobileBlocks = extractMediaBlocks(css, "@media (max-width: 768px)");
    const mobileMatch = mobileBlocks
      .map((block) => block.match(/\.memory-editor-frame\s*\{[^}]*min-height\s*:\s*(\d+(?:\.\d+)?)vh\s*;[^}]*\}/))
      .find((match): match is RegExpMatchArray => match !== null);
    expect(mobileMatch).not.toBeNull();

    const mobileHeight = Number(mobileMatch?.[1]);
    expect(mobileHeight).toBeGreaterThanOrEqual(baseHeight);
    expect(mobileHeight).toBe(65);
  });
});
