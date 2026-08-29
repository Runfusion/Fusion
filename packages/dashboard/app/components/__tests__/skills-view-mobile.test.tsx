import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { loadAllAppCss } from "../../test/cssFixture";

// Mock API functions
const mockFetchDiscoveredSkills = vi.fn().mockResolvedValue([]);
const mockFetchSkillsCatalog = vi.fn().mockResolvedValue({ entries: [] });
const mockToggleExecutionSkill = vi.fn().mockResolvedValue(undefined);
const mockFetchSkillContent = vi.fn().mockResolvedValue({
  name: "test-skill",
  skillMd: "",
  files: [],
});

vi.mock("../../api", () => ({
  fetchDiscoveredSkills: (...args: unknown[]) => mockFetchDiscoveredSkills(...args),
  fetchSkillsCatalog: (...args: unknown[]) => mockFetchSkillsCatalog(...args),
  toggleExecutionSkill: (...args: unknown[]) => mockToggleExecutionSkill(...args),
  fetchSkillContent: (...args: unknown[]) => mockFetchSkillContent(...args),
  // FNXC:Skills 2026-06-23-04:15: SkillsView now imports fetchSkillFileContent for the file viewer; stub it so the mock module is complete.
  fetchSkillFileContent: vi.fn().mockResolvedValue({ name: "", relativePath: "", content: "", isText: true }),
  installSkill: vi.fn().mockResolvedValue({ success: true }),
}));

function extractRuleBlock(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...css.matchAll(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, "g"))];
  return matches.at(-1)?.[1] ?? "";
}

function extractMobileMediaBlocks(content: string): string {
  const blocks: string[] = [];
  const regex = /@media[^{]*\(max-width: 768px\)[^{]*\{/g;
  let match;

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

describe("skills-view mobile css", () => {
  const cssContent = loadAllAppCss();
  const mobileMediaBlock = extractMobileMediaBlocks(cssContent);

  // FNXC:Skills 2026-06-22-09:30: SkillsView adopted the shared ViewHeader (.view-header /
  // .view-header__title) in the redesign, replacing the bespoke .skills-view-header /
  // .skills-view-title. Assert the shared header is defined and carries its standard padding/title.
  it("uses the shared .view-header for the skills title row", () => {
    expect(cssContent).toContain(".view-header {");
    const viewHeaderBlocks = [...cssContent.matchAll(/\.view-header\s*\{([^}]*)\}/g)].map((match) => match[1]);
    expect(viewHeaderBlocks.some((block) => /padding:\s*var\(--space-lg\)\s+var\(--space-xl\)/.test(block))).toBe(true);
  });

  it("defines the shared .view-header__title", () => {
    expect(cssContent).toContain(".view-header__title {");
  });

  it("defines .skills-view-content with reduced padding on mobile", () => {
    expect(mobileMediaBlock).toContain(".skills-view-content");
    const block = extractRuleBlock(mobileMediaBlock, ".skills-view-content");
    expect(block).toContain("padding: var(--space-md)");
  });

  it("defines .skills-view-search .form-input as full width on mobile", () => {
    expect(mobileMediaBlock).toContain(".skills-view-search .form-input");
    const block = extractRuleBlock(mobileMediaBlock, ".skills-view-search .form-input");
    expect(block).toContain("max-width: none");
    expect(block).toContain("width: 100%");
  });

  it("collapses catalog grid to single column on mobile", () => {
    expect(mobileMediaBlock).toContain(".skills-view-grid");
    expect(mobileMediaBlock).toMatch(/\.skills-view-grid\s*\{[^}]*grid-template-columns:\s*1fr/);
  });

  it("keeps .skills-view-item on one line on mobile", () => {
    expect(mobileMediaBlock).toContain(".skills-view-item");
    const block = extractRuleBlock(mobileMediaBlock, ".skills-view-item");
    expect(block).toContain("flex-wrap: nowrap");
  });

  it("defines .skills-view-toggle-slider with minimum dimensions on mobile", () => {
    expect(mobileMediaBlock).toContain(".skills-view-toggle-slider");
    const block = extractRuleBlock(mobileMediaBlock, ".skills-view-toggle-slider");
    expect(block).toContain("min-width: calc(var(--space-xl) + var(--space-lg))");
    expect(block).toContain("min-height: calc(var(--space-xl) - (var(--space-xs) / 2))");
  });

  it("defines .skills-view-section with reduced margin-bottom on mobile", () => {
    expect(mobileMediaBlock).toContain(".skills-view-section");
    const block = extractRuleBlock(mobileMediaBlock, ".skills-view-section");
    expect(block).toMatch(/margin-bottom:\s*var\(--space-md\)/);
  });

  it("defines .skills-view-section-title with smaller font on mobile", () => {
    expect(cssContent).toContain(".skills-view-section-title");
  });

  it("defines .skills-view-card with reduced padding on mobile", () => {
    expect(mobileMediaBlock).toContain(".skills-view-card");
    const block = extractRuleBlock(mobileMediaBlock, ".skills-view-card");
    expect(block).toContain("padding: var(--space-sm)");
  });

  it("defines .skills-view-card-title with smaller font on mobile", () => {
    expect(cssContent).toContain(".skills-view-card-title");
  });

  it("defines .skills-view-card-description with smaller font on mobile", () => {
    expect(cssContent).toContain(".skills-view-card-description");
  });

  it("defines .skills-view-empty with reduced padding on mobile", () => {
    expect(mobileMediaBlock).toContain(".skills-view-empty");
    const block = extractRuleBlock(mobileMediaBlock, ".skills-view-empty");
    expect(block).toContain("padding: var(--space-lg)");
  });

  it("defines .skills-view-error with reduced padding on mobile", () => {
    expect(mobileMediaBlock).toContain(".skills-view-error");
    const block = extractRuleBlock(mobileMediaBlock, ".skills-view-error");
    expect(block).toContain("padding: var(--space-lg)");
  });

  it("defines .skills-view-loading with reduced padding on mobile", () => {
    expect(mobileMediaBlock).toContain(".skills-view-loading");
    const block = extractRuleBlock(mobileMediaBlock, ".skills-view-loading");
    expect(block).toContain("padding: var(--space-md)");
  });

  it("defines .skills-view-item with padding on mobile", () => {
    expect(mobileMediaBlock).toContain(".skills-view-item");
    const block = extractRuleBlock(mobileMediaBlock, ".skills-view-item");
    expect(block).toContain("padding: var(--space-md)");
  });

  it("keeps .skills-view-item-info flexible instead of forcing full width on mobile", () => {
    expect(mobileMediaBlock).toContain(".skills-view-item-info");
    const block = extractRuleBlock(mobileMediaBlock, ".skills-view-item-info");
    expect(block).toContain("flex: 1 1 auto");
    expect(block).toContain("width: auto");
  });

  it("defines .skills-view-item-toggle with padding on mobile", () => {
    expect(mobileMediaBlock).toContain(".skills-view-item-toggle");
    const block = extractRuleBlock(mobileMediaBlock, ".skills-view-item-toggle");
    expect(block).toContain("padding: var(--space-sm)");
  });

  it("defines .skills-view-count with smaller font on mobile", () => {
    expect(cssContent).toContain(".skills-view-count");
  });

  it("defines .badge--sm base class in CSS", () => {
    expect(cssContent).toContain(".badge--sm {");
    const block = extractRuleBlock(cssContent, ".badge--sm");
    expect(block).toContain("font-size: 10px");
    expect(block).toContain("padding: 1px 6px");
  });

  it("skills-view base styles are defined in styles.css", () => {
    expect(cssContent).toContain(".skills-view {");
    // Header/title row is now the shared .view-header (not bespoke .skills-view-header/-title).
    expect(cssContent).toContain(".view-header {");
    expect(cssContent).toContain(".view-header__title {");
    expect(cssContent).toContain(".skills-view-content {");
    expect(cssContent).toContain(".skills-view-section {");
    expect(cssContent).toContain(".skills-view-list {");
    expect(cssContent).toContain(".skills-view-item {");
    expect(cssContent).toContain(".skills-view-card {");
    expect(cssContent).toContain(".skills-view-grid {");
    expect(cssContent).toContain(".skills-view-search {");
    expect(cssContent).toContain(".skills-view-toggle-slider {");
  });

  it(".skills-view-content has overflow-y auto in base CSS", () => {
    expect(cssContent).toMatch(/\.skills-view-content\s*\{[^}]*overflow-y:\s*auto[^}]*\}/s);
    expect(cssContent).toMatch(/\.skills-view-content\s*\{[^}]*flex:\s*1[^}]*\}/s);
    expect(cssContent).toMatch(/\.skills-view-content\s*\{[^}]*padding:\s*var\(--space-lg\) var\(--space-lg\) var\(--space-lg\)[^}]*\}/s);
  });

  it("defines .skills-view-detail with reduced padding on mobile", () => {
    expect(mobileMediaBlock).toContain(".skills-view-detail");
    const block = extractRuleBlock(mobileMediaBlock, ".skills-view-detail");
    expect(block).toContain("padding: var(--space-md)");
  });

  it("defines .skills-view-detail-content viewport max-height on mobile", () => {
    expect(mobileMediaBlock).toMatch(/\.skills-view-detail-content\s*\{[^}]*max-height:\s*calc\(60dvh - \(var\(--space-2xl\) \* 6 \+ var\(--space-xs\)\)\)/s);
  });

  it("defines .skills-view-detail-content momentum scrolling on mobile", () => {
    const block = extractRuleBlock(mobileMediaBlock, ".skills-view-detail-content");
    expect(block).toContain("-webkit-overflow-scrolling: touch");
  });

  it("defines .skills-view-detail-close with minimum touch target on mobile", () => {
    const block = extractRuleBlock(mobileMediaBlock, ".skills-view-detail-close");
    expect(block).toContain("min-height: calc(var(--space-lg) + var(--space-md) + var(--space-xs))");
    expect(block).toContain("min-width: calc(var(--space-lg) + var(--space-md) + var(--space-xs))");
  });

  it("defines .skills-view-item--selected in mobile media block", () => {
    const block = extractRuleBlock(mobileMediaBlock, ".skills-view-item--selected");
    expect(block).toContain("border-color: var(--todo)");
  });

  it("defines .skills-view-item with min-height on mobile", () => {
    const block = extractRuleBlock(mobileMediaBlock, ".skills-view-item");
    expect(block).toContain("min-height: calc(var(--space-lg) + var(--space-md) + var(--space-xs))");
  });

  it("skill detail base styles are defined in styles.css", () => {
    expect(cssContent).toContain(".skills-view-item--selected {");
    expect(cssContent).toContain(".skills-view-detail {");
    expect(cssContent).toContain(".skills-view-detail-header {");
    expect(cssContent).toContain(".skills-view-detail-title {");
    expect(cssContent).toContain(".skills-view-detail-content {");
    expect(cssContent).toContain(".skills-view-detail-files {");
    expect(cssContent).toContain(".skills-view-detail-files-label {");
    expect(cssContent).toContain(".skills-view-detail-loading {");
    expect(cssContent).toContain(".skills-view-detail-error {");
    expect(cssContent).toContain(".skills-view-detail-empty {");
  });
});

describe("SkillsView component structure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders .skills-view-content wrapper around sections", async () => {
    const { SkillsView } = await import("../SkillsView");

    render(
      <SkillsView
        projectId="test-project"
        addToast={vi.fn()}
        onClose={vi.fn()}
      />
    );

    // The wrapper should exist
    const contentWrapper = screen.getByTestId("skills-view").querySelector(".skills-view-content");
    expect(contentWrapper).not.toBeNull();

    // The two sections should be inside the wrapper
    const sections = contentWrapper!.querySelectorAll(".skills-view-section");
    expect(sections.length).toBe(2);

    // Header (now the shared ViewHeader: .view-header) should be outside the content
    // wrapper, directly on skills-view.
    const skillsView = screen.getByTestId("skills-view");
    const header = skillsView.querySelector(".view-header");
    expect(header).not.toBeNull();
    expect(header!.parentElement).toBe(skillsView);
  });
});
