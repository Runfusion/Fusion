import { describe, expect, it } from "vitest";
import { getPrBadgeModifierClass } from "../prBadgeClass";

describe("getPrBadgeModifierClass", () => {
  it.each([
    { name: "open", prInfo: { status: "open" as const }, expectedClass: "card-github-badge--open" },
    { name: "open isDraft", prInfo: { status: "open" as const, isDraft: true }, expectedClass: "card-github-badge--draft" },
    { name: "open draft", prInfo: { status: "open" as const, draft: true }, expectedClass: "card-github-badge--draft" },
    { name: "draft status", prInfo: { status: "draft" as const }, expectedClass: "card-github-badge--draft" },
    { name: "merged", prInfo: { status: "merged" as const }, expectedClass: "card-github-badge--merged" },
    { name: "closed", prInfo: { status: "closed" as const }, expectedClass: "card-github-badge--closed" },
    { name: "conflicting", prInfo: { status: "open" as const, mergeable: "conflicting" as const }, expectedClass: "card-github-badge--conflicting" },
    { name: "blocked", prInfo: { status: "open" as const, mergeable: "blocked" as const }, expectedClass: "card-github-badge--conflicting" },
  ])("maps $name PR state to $expectedClass", ({ prInfo, expectedClass }) => {
    expect(getPrBadgeModifierClass(prInfo)).toBe(expectedClass);
  });

  it("prioritizes open conflicts over draft and open status colors", () => {
    expect(getPrBadgeModifierClass({ status: "open", isDraft: true, mergeable: "conflicting" })).toBe("card-github-badge--conflicting");
    expect(getPrBadgeModifierClass({ status: "open", draft: true, mergeable: "blocked" })).toBe("card-github-badge--conflicting");
  });
});
