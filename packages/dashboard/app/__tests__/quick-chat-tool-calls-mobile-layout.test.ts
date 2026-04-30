import { describe, expect, it } from "vitest";
import { loadAllAppCss } from "../test/cssFixture";

function extractMobileMediaBlocks(content: string): string {
  const blocks: string[] = [];
  const regex = /@media\s*\(\s*max-width:\s*768px\s*\)\s*\{/g;
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

describe("quick-chat tool-call mobile layout css", () => {
  const css = loadAllAppCss();
  const mobileCss = extractMobileMediaBlocks(css);

  it("keeps grouped quick-chat tool-call summary on a single horizontal row in mobile media blocks", () => {
    const summaryRules = [...mobileCss.matchAll(/\.quick-chat-panel\s+\.chat-tool-calls-group-summary\s*\{[^}]*\}/g)].map((m) => m[0]);
    expect(summaryRules.length).toBeGreaterThan(0);
    expect(summaryRules.some((rule) => /flex-wrap:\s*nowrap/.test(rule))).toBe(true);
    expect(summaryRules.some((rule) => /flex-direction:\s*row/.test(rule))).toBe(true);
    expect(summaryRules.some((rule) => /align-items:\s*center/.test(rule))).toBe(true);
  });

  it("keeps quick-chat scoped text tokens non-wrapping so ChatView mobile stacking cannot override them", () => {
    const scopedNoWrapBlock = /\.quick-chat-panel\s+\.chat-tool-calls-names,\s*\n\s*\.quick-chat-panel\s+\.chat-tool-call-name,\s*\n\s*\.quick-chat-panel\s+\.chat-tool-call-status-text,\s*\n\s*\.quick-chat-panel\s+\.chat-tool-calls-group-status\s*\{[^}]*white-space:\s*nowrap[^}]*\}/m;
    expect(scopedNoWrapBlock.test(mobileCss)).toBe(true);

    const scopedSummaryRules = [...mobileCss.matchAll(/\.quick-chat-panel\s+\.chat-tool-calls-group-summary\s*\{[^}]*\}/g)].map((m) => m[0]);
    expect(scopedSummaryRules.length).toBeGreaterThan(0);
    expect(scopedSummaryRules.every((rule) => !/flex-direction:\s*column/.test(rule))).toBe(true);
  });
});
