import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const css = readFileSync(
  resolve(__dirname, "../styles.css"),
  "utf-8",
);

describe("mobile scroll-snap CSS", () => {
  it("contains scroll-snap-type: x mandatory", () => {
    expect(css).toContain("scroll-snap-type: x mandatory");
  });

  it("contains scroll-snap-align: start", () => {
    expect(css).toContain("scroll-snap-align: start");
  });

  it("contains -webkit-overflow-scrolling: touch", () => {
    expect(css).toContain("-webkit-overflow-scrolling: touch");
  });

  it("contains flex-shrink: 0", () => {
    expect(css).toContain("flex-shrink: 0");
  });

  it("scroll-snap rules are inside a @media block", () => {
    // Extract all @media blocks and verify snap rules exist within one
    const mediaBlockRegex = /@media\s*\([^)]*max-width:\s*768px[^)]*\)\s*\{/g;
    const mediaStart = css.search(mediaBlockRegex);
    expect(mediaStart).toBeGreaterThanOrEqual(0);

    // Get the content after the media query opening
    const afterMedia = css.slice(mediaStart);
    // Find the scroll-snap-type within this media block
    expect(afterMedia).toContain("scroll-snap-type: x mandatory");
    expect(afterMedia).toContain("scroll-snap-align: start");
  });
});
