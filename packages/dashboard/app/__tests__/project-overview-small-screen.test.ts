import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const overviewCss = readFileSync(resolve(__dirname, "../components/ProjectOverview.css"), "utf8");
const cardCss = readFileSync(resolve(__dirname, "../components/ProjectCard.css"), "utf8");
const appSource = readFileSync(resolve(__dirname, "../App.tsx"), "utf8");

function extractMediaBlock(css: string, breakpoint: number): string {
  const match = new RegExp(`@media\\s*\\(max-width:\\s*${breakpoint}px\\)\\s*\\{`).exec(css);
  expect(match, `missing max-width: ${breakpoint}px media block`).not.toBeNull();

  const start = (match?.index ?? 0) + (match?.[0].length ?? 0);
  let depth = 1;
  let end = start;
  while (depth > 0 && end < css.length) {
    if (css[end] === "{") depth += 1;
    if (css[end] === "}") depth -= 1;
    end += 1;
  }

  expect(depth, `unterminated max-width: ${breakpoint}px media block`).toBe(0);
  return css.slice(start, end - 1);
}

function extractRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`))?.[1] ?? "";
}

describe("project overview small-screen reflow", () => {
  it("keeps literal dashboard breakpoints and a single-column grid through 320px", () => {
    for (const css of [overviewCss, cardCss]) {
      expect(css).toContain("@media (max-width: 480px)");
      expect(css).toContain("@media (max-width: 380px)");
    }

    const overview480 = extractMediaBlock(overviewCss, 480);
    const overview380 = extractMediaBlock(overviewCss, 380);
    expect(extractRule(overview480, ".project-grid")).toContain("grid-template-columns: 1fr");
    expect(overview480).toContain(".project-overview__header");
    expect(overview480).toContain(".project-overview__filters");
    expect(overview480).toContain(".project-filter-tabs");
    expect(overview380).toContain(".project-overview__stats-row");
  });

  it("removes desktop card minimums and preserves truncation for populated long-name data", () => {
    const card480 = extractMediaBlock(cardCss, 480);
    const card380 = extractMediaBlock(cardCss, 380);

    expect(extractRule(card480, ".project-card,\n  .project-card-header,\n  .project-card-title-section,\n  .project-card-availability__row,\n  .project-card-skeleton__header,\n  .project-skeleton__text-group")).toContain("min-width: 0");
    expect(card480).toMatch(/\.project-card-name,[\s\S]*?\.project-card-availability__path\s*\{[\s\S]*?overflow:\s*hidden;[\s\S]*?text-overflow:\s*ellipsis;/);
    expect(card380).toContain(".project-card-footer");
    expect(card380).toContain(".project-card-actions");
    expect(card480).not.toMatch(/min-width:\s*(?:2[89]\d|[3-9]\d\d)px/);
  });

  it("keeps empty, filtered-empty, skeleton, health-empty, and availability surfaces shrinkable", () => {
    const overview480 = extractMediaBlock(overviewCss, 480);
    const card480 = extractMediaBlock(cardCss, 480);

    expect(overview480).toContain(".project-empty-state");
    expect(overview480).toContain(".project-overview__no-results");
    expect(overview480).toContain(".project-card--skeleton");
    expect(overview480).toContain(".project-overview__stat-skeleton");
    expect(card480).toContain(".project-card-metric-empty");
    expect(card480).toContain(".project-card-availability__path");
  });

  it("uses tokens in new declaration blocks while allowing literal media conditions", () => {
    for (const css of [overviewCss, cardCss]) {
      for (const breakpoint of [480, 380]) {
        const block = extractMediaBlock(css, breakpoint);
        expect(block).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(/i);
        expect(block).not.toMatch(/\b\d+px\b/);
      }
    }

    const overview480 = extractMediaBlock(overviewCss, 480);
    const card480 = extractMediaBlock(cardCss, 480);
    expect(overview480).toContain("var(--space-sm)");
    expect(card480).toContain("var(--space-md)");
  });

  it("reserves project mobile-nav padding only when the shared nav predicate is visible", () => {
    expect(appSource).toContain('const mobileNavVisible = viewMode === "project" && !!currentProject;');
    expect(appSource).toContain('isMobile && mobileNavVisible && !mobileKeyboardOpen ? " project-content--with-mobile-nav" : ""');
    expect(appSource).toContain("hidden={!mobileNavVisible}");
    expect(appSource).toContain("footerVisible={mobileNavVisible}");
  });
});
