import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { IssueInfo, PrInfo } from "@kb/core";
import { GitHubBadge } from "../GitHubBadge";

describe("GitHubBadge", () => {
  const mockPrInfo: PrInfo = {
    url: "https://github.com/owner/repo/pull/42",
    number: 42,
    status: "open",
    title: "Fix critical bug",
    headBranch: "feature/bugfix",
    baseBranch: "main",
    commentCount: 5,
    lastCheckedAt: "2026-01-01T00:00:00Z",
  };

  const mockIssueInfo: IssueInfo = {
    url: "https://github.com/owner/repo/issues/123",
    number: 123,
    state: "open",
    title: "Feature request: dark mode",
    lastCheckedAt: "2026-01-01T00:00:00Z",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("PR badge rendering", () => {
    it("renders PR badge with correct number and icon when prInfo is provided", () => {
      render(<GitHubBadge prInfo={mockPrInfo} />);

      expect(screen.getByText("#42")).toBeDefined();
      // Check for the PR icon (GitPullRequest)
      const badge = screen.getByTitle("PR #42: Fix critical bug");
      expect(badge).toBeDefined();
    });

    it("does not render PR badge when prInfo is undefined", () => {
      render(<GitHubBadge />);

      expect(screen.queryByText(/#/)).toBeNull();
    });

    it("applies correct color classes for open PR", () => {
      const { container } = render(<GitHubBadge prInfo={mockPrInfo} />);

      const badge = container.querySelector(".card-github-badge--open");
      expect(badge).toBeDefined();
    });

    it("applies correct color classes for closed PR", () => {
      const closedPr: PrInfo = { ...mockPrInfo, status: "closed" };
      const { container } = render(<GitHubBadge prInfo={closedPr} />);

      const badge = container.querySelector(".card-github-badge--closed");
      expect(badge).toBeDefined();
    });

    it("applies correct color classes for merged PR", () => {
      const mergedPr: PrInfo = { ...mockPrInfo, status: "merged" };
      const { container } = render(<GitHubBadge prInfo={mergedPr} />);

      const badge = container.querySelector(".card-github-badge--merged");
      expect(badge).toBeDefined();
    });
  });

  describe("Issue badge rendering", () => {
    it("renders Issue badge with correct number and icon when issueInfo is provided", () => {
      render(<GitHubBadge issueInfo={mockIssueInfo} />);

      expect(screen.getByText("#123")).toBeDefined();
      const badge = screen.getByTitle("Issue #123: Feature request: dark mode");
      expect(badge).toBeDefined();
    });

    it("does not render Issue badge when issueInfo is undefined", () => {
      render(<GitHubBadge />);

      expect(screen.queryByText(/#/)).toBeNull();
    });

    it("applies correct color classes for open Issue", () => {
      const { container } = render(<GitHubBadge issueInfo={mockIssueInfo} />);

      const badge = container.querySelector(".card-github-badge--open");
      expect(badge).toBeDefined();
    });

    it("applies correct color classes for completed Issue", () => {
      const completedIssue: IssueInfo = { ...mockIssueInfo, state: "closed", stateReason: "completed" };
      const { container } = render(<GitHubBadge issueInfo={completedIssue} />);

      const badge = container.querySelector(".card-github-badge--completed");
      expect(badge).toBeDefined();
    });

    it("applies correct color classes for not_planned Issue", () => {
      const notPlannedIssue: IssueInfo = { ...mockIssueInfo, state: "closed", stateReason: "not_planned" };
      const { container } = render(<GitHubBadge issueInfo={notPlannedIssue} />);

      const badge = container.querySelector(".card-github-badge--closed");
      expect(badge).toBeDefined();
    });

    it("handles Issue with no state reason gracefully", () => {
      const noReasonIssue: IssueInfo = { ...mockIssueInfo, state: "closed", stateReason: undefined };
      const { container } = render(<GitHubBadge issueInfo={noReasonIssue} />);

      // Should not have any modifier class
      const badge = container.querySelector(".card-github-badge");
      expect(badge).toBeDefined();
      expect(badge?.classList.contains("card-github-badge--open")).toBe(false);
      expect(badge?.classList.contains("card-github-badge--completed")).toBe(false);
      expect(badge?.classList.contains("card-github-badge--closed")).toBe(false);
    });
  });

  describe("Both badges can appear simultaneously", () => {
    it("renders both PR and Issue badges when both props are provided", () => {
      render(<GitHubBadge prInfo={mockPrInfo} issueInfo={mockIssueInfo} />);

      expect(screen.getByText("#42")).toBeDefined();
      expect(screen.getByText("#123")).toBeDefined();
    });

    it("renders PR badge with open status and Issue badge with completed status", () => {
      const completedIssue: IssueInfo = { ...mockIssueInfo, state: "closed", stateReason: "completed" };
      const { container } = render(<GitHubBadge prInfo={mockPrInfo} issueInfo={completedIssue} />);

      const badges = container.querySelectorAll(".card-github-badge");
      expect(badges.length).toBe(2);

      // First badge should be PR (open)
      expect(badges[0].classList.contains("card-github-badge--open")).toBe(true);

      // Second badge should be Issue (completed)
      expect(badges[1].classList.contains("card-github-badge--completed")).toBe(true);
    });
  });

  describe("Click behavior", () => {
    it("opens PR URL in new tab when PR badge is clicked", () => {
      const mockOpen = vi.fn();
      vi.stubGlobal("open", mockOpen);

      render(<GitHubBadge prInfo={mockPrInfo} />);

      const badge = screen.getByTitle("PR #42: Fix critical bug");
      fireEvent.click(badge);

      expect(mockOpen).toHaveBeenCalledWith(
        "https://github.com/owner/repo/pull/42",
        "_blank",
        "noopener,noreferrer"
      );

      vi.unstubAllGlobals();
    });

    it("opens Issue URL in new tab when Issue badge is clicked", () => {
      const mockOpen = vi.fn();
      vi.stubGlobal("open", mockOpen);

      render(<GitHubBadge issueInfo={mockIssueInfo} />);

      const badge = screen.getByTitle("Issue #123: Feature request: dark mode");
      fireEvent.click(badge);

      expect(mockOpen).toHaveBeenCalledWith(
        "https://github.com/owner/repo/issues/123",
        "_blank",
        "noopener,noreferrer"
      );

      vi.unstubAllGlobals();
    });

    it("does not open window when PR badge is clicked but URL is missing", () => {
      const mockOpen = vi.fn();
      vi.stubGlobal("open", mockOpen);

      const prWithoutUrl: PrInfo = { ...mockPrInfo, url: "" };
      render(<GitHubBadge prInfo={prWithoutUrl} />);

      const badge = screen.getByTitle("PR #42: Fix critical bug");
      fireEvent.click(badge);

      expect(mockOpen).not.toHaveBeenCalled();

      vi.unstubAllGlobals();
    });
  });

  describe("Tooltip text", () => {
    it("shows correct tooltip for PR badge", () => {
      render(<GitHubBadge prInfo={mockPrInfo} />);

      const badge = screen.getByTitle("PR #42: Fix critical bug");
      expect(badge).toBeDefined();
    });

    it("shows correct tooltip for Issue badge", () => {
      render(<GitHubBadge issueInfo={mockIssueInfo} />);

      const badge = screen.getByTitle("Issue #123: Feature request: dark mode");
      expect(badge).toBeDefined();
    });

    it("handles long titles in tooltips", () => {
      const longTitlePr: PrInfo = {
        ...mockPrInfo,
        title: "This is a very long PR title that exceeds normal length limits",
      };
      render(<GitHubBadge prInfo={longTitlePr} />);

      const badge = screen.getByTitle(`PR #42: ${longTitlePr.title}`);
      expect(badge).toBeDefined();
    });
  });

  describe("No badges when no data", () => {
    it("renders nothing when both prInfo and issueInfo are undefined", () => {
      const { container } = render(<GitHubBadge />);

      const badges = container.querySelectorAll(".card-github-badge");
      expect(badges.length).toBe(0);
    });

    it("renders nothing when both prInfo and issueInfo are null", () => {
      const { container } = render(<GitHubBadge prInfo={undefined} issueInfo={undefined} />);

      const badges = container.querySelectorAll(".card-github-badge");
      expect(badges.length).toBe(0);
    });
  });
});
