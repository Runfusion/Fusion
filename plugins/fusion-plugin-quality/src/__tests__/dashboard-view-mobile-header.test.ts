import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dashboardViewCss = readFileSync(join(srcRoot, "dashboard-view.css"), "utf8");
const mobileMediaQuery = "@media (max-width: 768px), (max-height: 480px)";

function mediaBlock(css: string, query: string): string {
  const start = css.indexOf(query);
  expect(start, `expected ${query} mobile rule`).toBeGreaterThanOrEqual(0);

  const openBrace = css.indexOf("{", start);
  let depth = 0;
  for (let index = openBrace; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") depth -= 1;
    if (depth === 0) return css.slice(openBrace + 1, index);
  }

  throw new Error(`unterminated ${query} rule`);
}

describe("QualityDashboardView mobile header CSS", () => {
  it("gives the title its own row and wraps preset actions below it", () => {
    const mobileCss = mediaBlock(dashboardViewCss, mobileMediaQuery);

    // FNXC:Quality 2026-07-16-12:45: FN-8131 preserves the mobile invariant for every run-count width and both canonical mobile breakpoint arms.
    expect(mobileCss).toMatch(/\.quality-view \.view-header\s*\{[\s\S]*?flex-wrap\s*:\s*wrap\s*;/);
    expect(mobileCss).toMatch(/\.quality-view \.view-header__title\s*\{[\s\S]*?flex\s*:\s*1\s+0\s+100%\s*;/);
    expect(mobileCss).toMatch(/\.quality-view \.view-header__title\s*\{[\s\S]*?min-width\s*:\s*100%\s*;/);
    expect(mobileCss).toMatch(/\.quality-view \.view-header__title span\s*\{[\s\S]*?overflow\s*:\s*visible\s*;/);
    expect(mobileCss).toMatch(/\.quality-view \.view-header__actions\s*\{[\s\S]*?width\s*:\s*100%\s*;/);
    expect(mobileCss).toMatch(/\.quality-view \.view-header__actions\s*\{[\s\S]*?margin-left\s*:\s*0\s*;/);
  });
});
