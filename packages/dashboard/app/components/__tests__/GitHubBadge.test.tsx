import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { PrInfo } from "@fusion/core";
import { GitHubBadge } from "../GitHubBadge";

const basePrInfo: PrInfo = {
  url: "https://github.com/owner/repo/pull/42",
  number: 42,
  status: "open",
  title: "Fix critical bug",
  headBranch: "feature/bugfix",
  baseBranch: "main",
  commentCount: 5,
  lastCheckedAt: "2026-01-01T00:00:00Z",
};

describe("GitHubBadge PR state + rollup", () => {
  it.each([
    { name: "open", prInfo: { status: "open" as const }, expectedClass: "card-github-badge--open" },
    { name: "draft", prInfo: { status: "open" as const, isDraft: true }, expectedClass: "card-github-badge--draft" },
    { name: "conflicting", prInfo: { status: "open" as const, mergeable: "conflicting" as const }, expectedClass: "card-github-badge--conflicting" },
    { name: "merged", prInfo: { status: "merged" as const }, expectedClass: "card-github-badge--merged" },
    { name: "closed", prInfo: { status: "closed" as const }, expectedClass: "card-github-badge--closed" },
  ])("applies $name modifier class", ({ prInfo, expectedClass }) => {
    const { container } = render(<GitHubBadge prInfo={{ ...basePrInfo, ...prInfo }} />);
    expect(container.querySelector(`.${expectedClass}`)).not.toBeNull();
  });

  it.each([
    { label: "undefined", checkRollup: undefined, expectedClass: null },
    { label: "none", checkRollup: "none" as const, expectedClass: null },
    { label: "success", checkRollup: "success" as const, expectedClass: "card-github-badge__check--success" },
    { label: "failure", checkRollup: "failure" as const, expectedClass: "card-github-badge__check--failure" },
    { label: "pending", checkRollup: "pending" as const, expectedClass: "card-github-badge__check--pending" },
  ])("renders rollup icon class for $label", ({ checkRollup, expectedClass }) => {
    const { container } = render(<GitHubBadge prInfo={{ ...basePrInfo, checkRollup }} />);
    const check = container.querySelector(".card-github-badge__check");
    if (expectedClass === null) {
      expect(check).toBeNull();
      return;
    }
    expect(container.querySelector(`.${expectedClass}`)).not.toBeNull();
  });

  it("preserves link destination and tooltip format", () => {
    render(<GitHubBadge prInfo={{ ...basePrInfo, status: "open", isDraft: true, checkRollup: "pending" }} />);

    const link = screen.getByRole("link", { name: "#42" });
    expect(link).toHaveAttribute("href", basePrInfo.url);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveAttribute("title", "PR #42 (draft): Fix critical bug — checks: pending");
  });

  it("keeps original tooltip format when no extra signal is present", () => {
    render(<GitHubBadge prInfo={basePrInfo} />);
    const link = screen.getByRole("link", { name: "#42" });
    expect(link).toHaveAttribute("title", "PR #42: Fix critical bug");
  });
});
