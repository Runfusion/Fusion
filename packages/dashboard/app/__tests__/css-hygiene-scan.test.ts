import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const componentsDir = resolve(__dirname, "../components");

const recentlyLandedResponsiveFiles = [
  "PluginManager.css",
  "WorkflowNodeEditor.css",
  "TaskDetailModal.css",
  "WorkflowSelector.css",
  "WorkflowSettingsPanel.css",
];

const recentlyLandedHygieneFiles = [
  ...recentlyLandedResponsiveFiles,
  "MobileWorkflowGraphView.css",
  "PullRequestView.css",
  "TaskCard.css",
  "TaskFieldsSection.css",
];

function readComponentCss(name: string): string {
  return readFileSync(join(componentsDir, name), "utf-8");
}

function linesWith(source: string, predicate: (line: string) => boolean): string[] {
  return source
    .split("\n")
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => predicate(line))
    .map(({ line, index }) => `${index + 1}: ${line.trim()}`);
}

function extractSelectorBlocks(source: string, selector: string): string[] {
  const blocks: string[] = [];
  let searchFrom = 0;

  while (searchFrom < source.length) {
    const start = source.indexOf(selector, searchFrom);
    if (start === -1) break;

    const selectorStart = source.lastIndexOf("}", start) + 1;
    const open = source.indexOf("{", start);
    if (open === -1) break;

    const selectorList = source.slice(selectorStart, open);
    if (!selectorList.split(",").some((entry) => entry.trim() === selector)) {
      searchFrom = start + selector.length;
      continue;
    }

    let depth = 1;
    let index = open + 1;
    while (index < source.length && depth > 0) {
      if (source[index] === "{") depth += 1;
      else if (source[index] === "}") depth -= 1;
      index += 1;
    }

    blocks.push(source.slice(open + 1, index - 1));
    searchFrom = index;
  }

  return blocks;
}

describe("component CSS hygiene scan regressions", () => {
  it("keeps fixed text-on-accent CSS on --cta-text instead of hardcoded white", () => {
    const fixedSelectors: Array<[string, string]> = [
      ["PullRequestView.css", ".pr-action--merge-confirm"],
      ["TaskCard.css", ".card-field-badge--boolean"],
      ["TaskFieldsSection.css", ".task-field-chip.is-active"],
    ];

    const findings = fixedSelectors.flatMap(([file, selector]) => {
      const blocks = extractSelectorBlocks(readComponentCss(file), selector);
      const issues: string[] = [];

      if (!blocks.some((block) => block.includes("color: var(--cta-text);"))) {
        issues.push(`${file}:${selector}: missing color: var(--cta-text)`);
      }
      if (blocks.some((block) => /color:\s*#fff\b/i.test(block))) {
        issues.push(`${file}:${selector}: uses hardcoded #fff`);
      }

      return issues;
    });

    expect(findings).toEqual([]);
  });

  it("does not use hardcoded hex colors outside token fallback patterns in scanned recent CSS", () => {
    const hexPattern = /#[0-9a-fA-F]{3,8}\b/;
    const findings = recentlyLandedHygieneFiles.flatMap((file) =>
      linesWith(
        readComponentCss(file),
        (line) => hexPattern.test(line) && !line.includes("var(--")
      ).map((line) => `${file}:${line}`)
    );

    expect(findings).toEqual([]);
  });

  it("does not reintroduce raw rgba() calls in scanned recent CSS", () => {
    const findings = recentlyLandedHygieneFiles.flatMap((file) =>
      linesWith(readComponentCss(file), (line) => line.includes("rgba(")).map(
        (line) => `${file}:${line}`
      )
    );

    expect(findings).toEqual([]);
  });

  it("keeps mobile breakpoints in recently landed responsive components", () => {
    const findings = recentlyLandedResponsiveFiles.filter(
      (file) => !readComponentCss(file).includes("@media (max-width: 768px)")
    );

    expect(findings).toEqual([]);
  });

  it("keeps focus-visible coverage for recently landed interactive surfaces", () => {
    const expectedFocusSelectors: Record<string, string[]> = {
      "PluginManager.css": [
        ".plugin-registry-search-input:focus-visible",
        ".plugin-registry-action:focus-visible",
        ".plugin-registry-retry:focus-visible",
      ],
      "WorkflowNodeEditor.css": [
        ".wf-view-mode-option:focus-visible",
        ".wf-template-option:focus-visible",
        ".wf-ai-prompt:focus-visible",
        ".wf-mobile-tab:focus-visible",
        ".wf-mobile-add-option:focus-visible",
        ".wf-mobile-template-option:focus-visible",
      ],
      "TaskDetailModal.css": [
        ".detail-summarize-title-btn:focus-visible",
        ".detail-provenance-link:focus-visible",
        ".detail-priority-select:focus-visible",
        ".detail-source-toggle:focus-visible",
        ".changed-files-back-button:focus-visible",
        ".modal-edit-btn:focus-visible",
        ".detail-tab:focus-visible",
      ],
      "MobileWorkflowGraphView.css": [
        ".mobile-wf-node-main:focus-visible",
        ".mobile-wf-node-expand:focus-visible",
        ".mobile-wf-edge-chip:focus-visible",
      ],
    };

    const missing = Object.entries(expectedFocusSelectors).flatMap(([file, selectors]) => {
      const css = readComponentCss(file);
      return selectors
        .filter((selector) => !css.includes(selector))
        .map((selector) => `${file}: missing ${selector}`);
    });

    expect(missing).toEqual([]);
  });

  it("uses tokenized focus-visible styling in scanned recent CSS", () => {
    const focusRulePattern = /([^{}]*:focus-visible[^{}]*)\{([^{}]*)\}/g;
    const findings = recentlyLandedHygieneFiles.flatMap((file) => {
      const css = readComponentCss(file);
      const issues: string[] = [];

      for (const match of css.matchAll(focusRulePattern)) {
        const selector = match[1].trim().replace(/\s+/g, " ");
        const block = match[2];
        const hasFocusStyling = /(?:outline|box-shadow)\s*:/.test(block);
        const hasRawColor = /(?:#[0-9a-fA-F]{3,8}\b|rgba?\()/.test(block);

        if (hasRawColor) {
          issues.push(`${file}:${selector}: uses raw focus color`);
        }
        if (hasFocusStyling && !block.includes("var(--")) {
          issues.push(`${file}:${selector}: focus styling is not tokenized`);
        }
      }

      return issues;
    });

    expect(findings).toEqual([]);
  });
});
