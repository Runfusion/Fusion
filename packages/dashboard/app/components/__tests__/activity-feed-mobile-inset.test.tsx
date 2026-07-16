/*
FNXC:ActivityFeedMobile 2026-07-16-00:00:
FN-8122 locks the mobile activity-feed inset across the modal, narrow right dock, and
standalone feed so long populated entries and every shared state retain breathing room.
*/
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const COMPONENTS_DIR = resolve(__dirname, "..");
const scriptsModalCss = readFileSync(join(COMPONENTS_DIR, "ScriptsModal.css"), "utf8");
const activityLogModalCss = readFileSync(join(COMPONENTS_DIR, "ActivityLogModal.css"), "utf8");
const activityFeedCss = readFileSync(join(COMPONENTS_DIR, "ActivityFeed.css"), "utf8");

const SPACE_ORDER = ["xs", "sm", "md", "lg", "xl", "2xl"] as const;

type SpaceToken = (typeof SPACE_ORDER)[number];

function extractAtRuleBlocks(css: string, atRule: string): string[] {
  const blocks: string[] = [];
  let start = css.indexOf(atRule);

  while (start >= 0) {
    const bodyStart = css.indexOf("{", start);
    let depth = 1;
    let cursor = bodyStart + 1;
    while (depth > 0 && cursor < css.length) {
      if (css[cursor] === "{") depth += 1;
      if (css[cursor] === "}") depth -= 1;
      cursor += 1;
    }

    expect(depth, `Expected ${atRule} to close`).toBe(0);
    blocks.push(css.slice(bodyStart + 1, cursor - 1));
    start = css.indexOf(atRule, cursor);
  }

  expect(blocks, `Expected ${atRule} to exist`).not.toHaveLength(0);
  return blocks;
}

function extractAtRuleBlockWithSelector(css: string, atRule: string, selector: string): string {
  const block = extractAtRuleBlocks(css, atRule).find((candidate) => candidate.includes(`${selector} {`));
  expect(block, `Expected ${atRule} to contain ${selector}`).toBeDefined();
  return block as string;
}

function extractRuleBlock(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `Expected ${selector} rule to exist`).toBeGreaterThanOrEqual(0);

  const bodyStart = css.indexOf("{", start);
  let depth = 1;
  let cursor = bodyStart + 1;
  while (depth > 0 && cursor < css.length) {
    if (css[cursor] === "{") depth += 1;
    if (css[cursor] === "}") depth -= 1;
    cursor += 1;
  }

  expect(depth, `Expected ${selector} rule to close`).toBe(0);
  return css.slice(bodyStart + 1, cursor - 1);
}

function rightInsetToken(rule: string): SpaceToken {
  const padding = rule.match(/padding\s*:\s*var\(--space-[\w-]+\)\s+var\(--space-([\w-]+)\)\s*;/);
  expect(padding, "Expected a token-based horizontal padding declaration").not.toBeNull();
  const token = padding?.[1] as SpaceToken;
  expect(SPACE_ORDER).toContain(token);
  return token;
}

function expectLargerInset(inset: SpaceToken, base: SpaceToken): void {
  expect(SPACE_ORDER.indexOf(inset)).toBeGreaterThan(SPACE_ORDER.indexOf(base));
}

describe("activity feed mobile inset contract (FN-8122)", () => {
  it("keeps the mobile Activity Log modal right inset above its former mobile inset", () => {
    const mobileCss = extractAtRuleBlockWithSelector(scriptsModalCss, "@media (max-width: 768px)", ".activity-log-content");
    const contentRule = extractRuleBlock(mobileCss, ".activity-log-content");
    const inset = rightInsetToken(contentRule);

    expectLargerInset(inset, "lg");
    expect(contentRule).not.toMatch(/padding(?:-right)?\s*:\s*\d+px/);
  });

  it("mirrors the larger token-based inset in the narrow embedded right dock", () => {
    const narrowDockCss = extractAtRuleBlockWithSelector(activityLogModalCss, "@container activity-log-embedded (max-width: 560px)", ".activity-log-modal--embedded .activity-log-content");
    const contentRule = extractRuleBlock(narrowDockCss, ".activity-log-modal--embedded .activity-log-content");
    const inset = rightInsetToken(contentRule);

    expectLargerInset(inset, "lg");
    expect(contentRule).not.toMatch(/padding(?:-right)?\s*:\s*\d+px/);
  });

  it("increases the standalone mobile feed inset above its base padding", () => {
    const baseRule = extractRuleBlock(activityFeedCss, ".activity-feed");
    const mobileCss = extractAtRuleBlockWithSelector(activityFeedCss, "@media (max-width: 768px)", ".activity-feed");
    const mobileRule = extractRuleBlock(mobileCss, ".activity-feed");
    const baseInset = baseRule.match(/padding\s*:\s*var\(--space-([\w-]+)\)\s*;/)?.[1] as SpaceToken;
    const inset = rightInsetToken(mobileRule);

    expect(SPACE_ORDER).toContain(baseInset);
    expectLargerInset(inset, baseInset);
    expect(mobileRule).not.toMatch(/padding(?:-right)?\s*:\s*\d+px/);
  });
});
