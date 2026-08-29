import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

function extractMediaBlocks(content: string, pattern: RegExp): string {
  const blocks: string[] = [];

  for (const match of content.matchAll(pattern)) {
    const start = match.index! + match[0].length;
    let index = start;
    let depth = 1;

    while (index < content.length && depth > 0) {
      if (content[index] === "{") depth += 1;
      if (content[index] === "}") depth -= 1;
      index += 1;
    }

    expect(depth).toBe(0);
    blocks.push(content.slice(start, index - 1));
  }

  expect(blocks.length).toBeGreaterThan(0);
  return blocks.join("\n");
}

describe("AgentMentionPopup.css responsive positioning", () => {
  const css = readFileSync(resolve(__dirname, "../components/AgentMentionPopup.css"), "utf8");
  const tabletOrMobileBlock = extractMediaBlocks(
    css,
    /@media\s*\([^)]*max-width:\s*1024px[^)]*\)\s*\{/g,
  );

  it("keeps desktop default below positioning", () => {
    const belowBlock = css.match(/\.agent-mention-popup--below\s*\{[^}]*\}/)?.[0] ?? "";

    expect(belowBlock).toContain("top: calc(100% + var(--space-xs));");
  });

  it("forces above-input placement for below/above modifiers through tablet widths", () => {
    const responsiveBlock =
      tabletOrMobileBlock.match(
        /\.agent-mention-popup--below,\s*\.agent-mention-popup--above\s*\{[^}]*\}/,
      )?.[0] ?? "";

    expect(responsiveBlock).toContain("bottom: calc(100% + var(--space-xs));");
    expect(responsiveBlock).toContain("top: auto;");
  });
});
