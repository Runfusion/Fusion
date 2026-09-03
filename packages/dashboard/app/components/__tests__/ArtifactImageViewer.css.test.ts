import { describe, expect, it } from "vitest";
import { loadComponentCss } from "../../test/cssFixture";

const css = loadComponentCss("ArtifactImageViewer.css");

function extractRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{[^}]*\\}`));
  expect(match, `missing CSS rule for ${selector}`).not.toBeNull();
  return match?.[0] ?? "";
}

describe("ArtifactImageViewer CSS", () => {
  it("gives the zoom viewport ownership of clipping and touch gestures", () => {
    const viewport = extractRule(".artifact-image-viewer__viewport");
    const image = extractRule(".artifact-image-viewer__image");

    expect(viewport).toMatch(/overflow:\s*hidden;/);
    expect(viewport).toMatch(/touch-action:\s*none;/);
    expect(image).toMatch(/transform-origin:\s*center center;/);
  });

  it("uses token spacing for the toolbar at desktop and mobile sizes", () => {
    const toolbar = extractRule(".artifact-image-viewer__toolbar");
    expect(toolbar).toContain("var(--space-");
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.artifact-image-viewer__toolbar\s*\{[^}]*padding:\s*var\(--space-/);
  });

  it("contains no hardcoded paint or component length values", () => {
    const withoutMediaQueries = css.replace(/@media\s*\([^)]*\)/g, "@media");
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toContain("rgba(");
    expect(withoutMediaQueries).not.toMatch(/\b\d+(?:\.\d+)?px\b/);
  });
});
