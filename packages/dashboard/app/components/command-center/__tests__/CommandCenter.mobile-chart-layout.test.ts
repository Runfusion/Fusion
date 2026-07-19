import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readCommandCenterCss(): string {
  return [
    readFileSync(join(__dirname, "..", "CommandCenter.css"), "utf-8"),
    readFileSync(join(__dirname, "..", "charts", "charts.css"), "utf-8"),
    readFileSync(join(__dirname, "..", "areas", "areas.css"), "utf-8"),
    readFileSync(join(__dirname, "..", "areas", "SystemStatsArea.css"), "utf-8"),
  ].join("\n");
}

function extractMobileMediaBlocks(content: string): string {
  const blocks: string[] = [];
  const regex = /@media[^{}]*\(max-width:\s*768px\)[^{}]*\{/g;
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

    if (braceCount === 0) blocks.push(content.slice(startIdx, endIdx - 1));
  }

  return blocks.join("\n");
}

describe("CommandCenter.mobile-chart-layout.css", () => {
  const cssContent = readCommandCenterCss();
  const mobileCss = extractMobileMediaBlocks(cssContent);

  it("reads the co-located Command Center styles instead of the top-level css fixture", () => {
    expect(cssContent).toContain("FN-6680");
    expect(cssContent).toContain(".cc-token-series-axis");
    expect(cssContent).toContain(".cc-system-chart-grid");
  });

  it("stacks Overview stat cards without mobile overflow", () => {
    expect(mobileCss).toMatch(/\.cc-stat-grid\s*\{[^}]*min-inline-size:\s*0;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it("keeps chart primitives and text-bearing children shrink-bounded for real mobile layout", () => {
    expect(cssContent).toMatch(/\.cc-token-series-axis,[\s\S]*\.cc-funnel-stage\s*\{[\s\S]*min-inline-size:\s*0;[\s\S]*max-inline-size:\s*100%/);
    expect(cssContent).toMatch(/\.cc-bar-label\s*\{[^}]*min-inline-size:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis/);
    expect(cssContent).toMatch(/\.cc-bar-track\s*\{[^}]*min-inline-size:\s*0/);
    expect(cssContent).toMatch(/\.cc-bar-value\s*\{[^}]*min-inline-size:\s*0;[^}]*overflow-wrap:\s*anywhere/);
  });

  it("pins the corrected mobile bar row template without a competing scroll owner", () => {
    expect(mobileCss).toMatch(/\.cc-bar-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(calc\(var\(--space-2xl\)\s*\+\s*var\(--space-lg\)\),\s*2fr\);[^}]*align-items:\s*start/);
    expect(mobileCss).toMatch(/\.cc-bar-value\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;[^}]*max-inline-size:\s*100%/);
    expect(cssContent).not.toMatch(/\.cc-(?:bar|line|radial|sparkline|token-series|funnel)[^{]*\{[^}]*overflow-y:\s*(?:auto|scroll)/);
  });

  it("keeps line, token-series, radial, team, and system charts non-collapsing at mobile", () => {
    expect(mobileCss).toMatch(/\.cc-line-chart\s*\{[^}]*block-size:\s*clamp\(calc\(var\(--space-2xl\)\s*\*\s*2\),\s*44vw,\s*calc\(var\(--space-2xl\)\s*\*\s*4\)\);[^}]*aspect-ratio:\s*auto/);
    expect(mobileCss).toMatch(/\.cc-token-series-plot\s*\{[^}]*block-size:\s*clamp\(calc\(var\(--space-2xl\)\s*\+\s*var\(--space-xl\)\),\s*38vw,\s*calc\(var\(--space-2xl\)\s*\*\s*4\)\)/);
    expect(mobileCss).toMatch(/\.cc-radial-gauge-ring\s*\{[^}]*inline-size:\s*clamp\(calc\(var\(--space-2xl\)\s*\*\s*2\s*\+\s*var\(--space-lg\)\),\s*44vw,\s*calc\(var\(--space-2xl\)\s*\*\s*4\)\)/);
    expect(mobileCss).toMatch(/\.cc-team-chart-grid\s*\{[^}]*min-inline-size:\s*0;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(mobileCss).toMatch(/\.cc-system-chart-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it("keeps recharts ResponsiveContainer parents sized without becoming scroll owners", () => {
    expect(cssContent).toMatch(/\.cc-recharts-chart,[\s\S]*\.cc-recharts-empty\s*\{[\s\S]*inline-size:\s*100%;[\s\S]*block-size:\s*calc\(var\(--space-2xl\)\s*\*\s*7\s*\+\s*var\(--space-lg\)\);[\s\S]*min-inline-size:\s*0/);
    expect(cssContent).toMatch(/\.cc-overview-chart-card \.cc-recharts-chart,[\s\S]*\.cc-overview-chart-card \.cc-recharts-empty\s*\{[\s\S]*inline-size:\s*100%;[\s\S]*block-size:\s*calc\(var\(--space-2xl\)\s*\*\s*7\s*\+\s*var\(--space-lg\)\);[\s\S]*min-inline-size:\s*0/);
    expect(cssContent).toMatch(/\.cc-area \.cc-recharts-chart,[\s\S]*\.cc-area \.cc-recharts-empty\s*\{[\s\S]*inline-size:\s*100%;[\s\S]*block-size:\s*calc\(var\(--space-2xl\)\s*\*\s*7\s*\+\s*var\(--space-lg\)\);[\s\S]*min-inline-size:\s*0/);
    expect(cssContent).not.toMatch(/\.cc-recharts-(?:chart|empty)[^{]*\{[^}]*overflow-y:\s*(?:auto|scroll)/);
  });

  it("normalizes chart/card/table border rhythm with design tokens only", () => {
    expect(cssContent).toMatch(/\.cc-stat-card\s*\{[^}]*padding:\s*var\(--space-md\);[^}]*border:\s*1px\s+solid\s+var\(--border-subtle\);[^}]*border-radius:\s*var\(--radius-md\);[^}]*background:\s*var\(--surface-1\)/);
    expect(cssContent).toMatch(/\.cc-table-wrap\s*\{[^}]*border:\s*1px\s+solid\s+var\(--border-subtle\);[^}]*border-radius:\s*var\(--radius-md\);[^}]*background:\s*var\(--surface-1\);[^}]*overflow-x:\s*auto;[^}]*overflow-y:\s*hidden/);
    expect(cssContent).toMatch(/\.cc-system-vitest-card\s*\{[^}]*border:\s*1px\s+solid\s+var\(--border-subtle\);[^}]*border-radius:\s*var\(--radius-md\);[^}]*background:\s*var\(--surface-1\)/);
  });
});
