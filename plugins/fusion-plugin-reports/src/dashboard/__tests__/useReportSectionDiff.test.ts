import { describe, expect, it } from "vitest";
import { diffReportSections } from "../useReportSectionDiff.js";

describe("diffReportSections", () => {
  it("classifies changed sections", () => {
    const a = { metadata: { wins: ["a"] } } as never;
    const b = { metadata: { wins: ["b"] } } as never;
    const diff = diffReportSections(a, b);
    expect(diff.changed.find((item) => item.id === "system-wins")).toBeTruthy();
  });
});
