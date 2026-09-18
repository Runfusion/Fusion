import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("detail-body mobile overflow (FN-1331)", () => {
  it("base .detail-body includes overflow-x: hidden to prevent horizontal scrolling", () => {
    const detailModalCss = readFileSync(
      resolve(__dirname, "../components/TaskDetailModal.css"),
      "utf-8",
    );
    const detailBodyMatch = detailModalCss.match(/\.detail-body\s*\{[^}]*\}/);
    expect(detailBodyMatch).toBeTruthy();
    const rule = detailBodyMatch![0];
    expect(rule).toContain("overflow-x: hidden");
    expect(rule).toContain("overflow-y: auto");
  });

  it("mobile .detail-body includes overflow-x: hidden and preserves overflow-y: auto", () => {
    // Mobile rule lives in TaskDetailModal.css's @media (max-width: 768px) block.
    const detailModalCss = readFileSync(
      resolve(__dirname, "../components/TaskDetailModal.css"),
      "utf-8",
    );
    const mobileBlockMatch = detailModalCss.match(/@media[^{]*\(max-width:\s*768px\)[^{]*\{([\s\S]*)\}/);
    expect(mobileBlockMatch).toBeTruthy();
    const mobileBlock = mobileBlockMatch![1];

    const detailBodyMatch = mobileBlock.match(/\.detail-body\s*\{[^}]*\}/s);
    expect(detailBodyMatch).toBeTruthy();
    const rule = detailBodyMatch![0];
    expect(rule).toContain("overflow-x: hidden");
    expect(rule).toContain("overflow-y: auto");
  });

  it("mobile .detail-body owns its tokenized padding without a wrapper", () => {
    const detailModalCss = readFileSync(
      resolve(__dirname, "../components/TaskDetailModal.css"),
      "utf-8",
    );
    const mobileBlockMatch = detailModalCss.match(/@media[^{]*\(max-width:\s*768px\)[^{]*\{([\s\S]*)\}/);
    expect(mobileBlockMatch).toBeTruthy();
    const mobileBlock = mobileBlockMatch![1];

    const detailBodyMatches = [...mobileBlock.matchAll(/\.detail-body\s*\{[^}]*\}/gs)];
    expect(detailBodyMatches.some((match) => match[0].includes("padding: var(--ui-density-sm);"))).toBe(true);
    expect(mobileBlock).not.toMatch(/\.detail-body-content\s*\{/);
  });
});
