import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("settings-mobile-wrap.css", () => {
  const cssPath = resolve(__dirname, "../components/SettingsModal.css");
  const cssContent = readFileSync(cssPath, "utf8");

  function extractMobileMediaBlocks(content: string): string {
    const blocks: string[] = [];
    const regex = /@media[^{]*\(max-width: 768px\)[^{]*\{/g;
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

  const mobileCss = extractMobileMediaBlocks(cssContent);

  it("keeps prose help text wrapping at word boundaries", () => {
    const proseRule = mobileCss.match(/\.settings-content \.form-group small\s*\{[^}]*\}/)?.[0];
    expect(proseRule).toBeTruthy();
    expect(proseRule).toMatch(/overflow-wrap:\s*break-word/);
    expect(proseRule).toMatch(/word-break:\s*normal/);
    expect(proseRule).not.toMatch(/word-break:\s*break-all/);
  });

  it("keeps code tokens overflow-safe on mobile", () => {
    const codeRule = mobileCss.match(/\.backup-list li code\s*\{[^}]*\}/)?.[0];
    expect(codeRule).toBeTruthy();
    expect(codeRule).toMatch(/overflow-wrap:\s*anywhere|word-break:\s*break-all|word-break:\s*break-word/);
  });
});
