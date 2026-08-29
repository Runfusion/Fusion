import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

function readCss(relativePath: string): string {
  return readFileSync(resolve(__dirname, relativePath), "utf-8");
}

function extractFirstMediaBlock(css: string, pattern: RegExp): string {
  const match = pattern.exec(css);
  expect(match, `missing media block for ${pattern}`).toBeTruthy();

  const start = match!.index + match![0].length;
  let index = start;
  let depth = 1;
  while (index < css.length && depth > 0) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") depth -= 1;
    index += 1;
  }

  expect(depth).toBe(0);
  return css.slice(start, index - 1);
}

function ruleBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{[^}]*\\}`, "s"));
  expect(match, `missing CSS rule for ${selector}`).toBeTruthy();
  return match![0];
}

describe("FN-7843 token table mobile scroll contract", () => {
  const taskDetailCss = readCss("../components/TaskDetailModal.css");
  const commandCenterAreasCss = readCss("../components/command-center/areas/areas.css");
  const mobileTaskDetailCss = extractFirstMediaBlock(
    taskDetailCss,
    /@media\s*\(max-width:\s*768px\)\s*\{/,
  );

  it("keeps the task-detail token table overflow owned by its wrapper", () => {
    const wrapperRule = ruleBlock(taskDetailCss, ".task-summary-token-table-wrap");
    const tableRule = ruleBlock(taskDetailCss, ".task-summary-token-table");

    expect(wrapperRule).toContain("overflow-x: auto;");
    expect(tableRule).toMatch(/min-width:\s*[^;]+;/);
  });

  it("does not convert task-detail token tables into stacked mobile cards", () => {
    expect(mobileTaskDetailCss).not.toMatch(
      /\.task-summary-token-table-wrap\s*\{[^}]*overflow-x:\s*visible\s*;/s,
    );
    expect(mobileTaskDetailCss).not.toMatch(
      /\.task-summary-token-table(?:\s|,|\{|[^{}]*\{[^}]*)display:\s*block\s*;/s,
    );
    expect(mobileTaskDetailCss).not.toMatch(
      /\.task-summary-token-table\s+(?:thead|tbody|tfoot|tr|th|td)(?:\s|,|\{|[^{}]*\{[^}]*)display:\s*block\s*;/s,
    );
    expect(mobileTaskDetailCss).not.toMatch(
      /\.task-summary-token-table\s+thead\s*\{[^}]*display:\s*none\s*;/s,
    );
    expect(mobileTaskDetailCss).not.toContain(".task-summary-token-table td::before");
  });

  it("keeps the Command Center per-model table wrapper scrollable", () => {
    const commandCenterTableWrapRule = ruleBlock(commandCenterAreasCss, ".cc-table-wrap");

    expect(commandCenterTableWrapRule).toContain("overflow-x: auto;");
  });
});
