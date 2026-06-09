import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cssPath = path.resolve(__dirname, "../CompoundEngineeringView.css");
const css = fs.readFileSync(cssPath, "utf-8");

function selectorBlocks(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${escaped}\\s*\\{[^}]*\\}`, "g");
  return css.match(pattern) ?? [];
}

describe("CompoundEngineeringView theme tokens", () => {
  it("does not use hardcoded legacy color fallbacks", () => {
    const forbiddenPatterns = [
      "#d23",
      "#36c",
      "#ddd",
      "#c80",
      "#a60",
      "#2a7",
      "#2563eb",
      "#1d4ed8",
      "rgba(128, 128, 128",
    ];

    for (const pattern of forbiddenPatterns) {
      expect(css, `expected CSS not to contain ${pattern}`).not.toContain(pattern);
    }
  });

  it("does not reference non-existent dashboard color tokens", () => {
    const forbiddenTokens = [
      "--color-danger",
      "--color-accent",
      "--color-border",
      "--color-primary",
      "--color-primary-hover",
    ];

    for (const token of forbiddenTokens) {
      expect(css, `expected CSS not to reference ${token}`).not.toContain(token);
    }
  });

  it("keeps color-mix expressions token-based", () => {
    const colorMixCalls = css.match(/color-mix\([^)]*(?:\)[^)]*)?\)/g) ?? [];
    expect(colorMixCalls.length).toBeGreaterThan(0);

    for (const call of colorMixCalls) {
      expect(call, `expected ${call} to reference a CSS token`).toContain("var(--");
      expect(call, `expected ${call} not to contain hardcoded hex`).not.toMatch(/#[0-9a-fA-F]{3,8}/);
      expect(call, `expected ${call} not to contain rgba()`).not.toMatch(/rgba\(/);
    }
  });

  it("sets root view text color from the theme text token", () => {
    const [viewBlock] = selectorBlocks(".ce-view");
    expect(viewBlock).toBeDefined();
    expect(viewBlock).toMatch(/color:\s*var\(--text\)\s*;/);
  });

  it("does not use opacity to dim text selectors", () => {
    const textDimmingSelectors = [
      ".ce-view-summary",
      ".ce-empty-hint",
      '.ce-group[data-empty="true"]',
      ".ce-group-count",
      ".ce-group-empty",
      ".ce-artifact-path",
      ".ce-flow-turn-role",
      ".ce-flow-option-desc",
      ".ce-flow-status",
      ".ce-session-status",
      ".ce-session-updated",
      ".ce-flow-guidance-label",
      ".ce-flow-thinking",
      ".ce-flow-question-desc",
      ".ce-flow-working-label",
      ".ce-flow-degraded-options",
      ".ce-flow-activity-details summary",
      ".ce-activity-thinking",
      ".ce-flow-turn-comment",
    ];

    for (const selector of textDimmingSelectors) {
      const blocks = selectorBlocks(selector);
      expect(blocks, `expected to find selector ${selector}`).not.toHaveLength(0);
      for (const block of blocks) {
        expect(block, `expected ${selector} not to use opacity for text dimming`).not.toMatch(/opacity\s*:/);
      }
    }
  });
});
