import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PrSection } from "../PrSection";

// Mock the API module
vi.mock("../../api", () => ({
  createPr: vi.fn(),
  refreshPrStatus: vi.fn(),
}));

import { createPr, refreshPrStatus } from "../../api";

const mockAddToast = vi.fn();
const mockOnPrCreated = vi.fn();
const mockOnPrUpdated = vi.fn();

const mockPrInfo = {
  url: "https://github.com/owner/repo/pull/42",
  number: 42,
  status: "open" as const,
  title: "Fix the bug",
  headBranch: "fusion/fn-001",
  baseBranch: "main",
  commentCount: 3,
  lastCommentAt: "2026-01-01T00:00:00.000Z",
};

describe("PrSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("when task has no PR", () => {
    it("shows create PR button when PR auth is available", () => {
      render(
        <PrSection
          taskId="FN-001"
          prAuthAvailable={true}
          onPrCreated={mockOnPrCreated}
          onPrUpdated={mockOnPrUpdated}
          addToast={mockAddToast}
        />
      );

      expect(screen.getByText("Create PR")).toBeDefined();
    });

    it("shows disabled button and hint when PR auth is unavailable", () => {
      render(
        <PrSection
          taskId="FN-001"
          prAuthAvailable={false}
          onPrCreated={mockOnPrCreated}
          onPrUpdated={mockOnPrUpdated}
          addToast={mockAddToast}
        />
      );

      const button = screen.getByText("Create PR") as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.title).toContain("gh auth login");
      expect(screen.getByText(/gh auth login/i)).toBeDefined();
    });

    it("shows create form when clicking create button", () => {
      render(
        <PrSection
          taskId="FN-001"
          prAuthAvailable={true}
          onPrCreated={mockOnPrCreated}
          onPrUpdated={mockOnPrUpdated}
          addToast={mockAddToast}
        />
      );

      fireEvent.click(screen.getByText("Create PR"));

      expect(screen.getByPlaceholderText("PR title")).toBeDefined();
      expect(screen.getByPlaceholderText("PR description (optional)")).toBeDefined();
      expect(screen.getByText("Cancel")).toBeDefined();
    });

    it("hides form when clicking cancel", () => {
      render(
        <PrSection
          taskId="FN-001"
          prAuthAvailable={true}
          onPrCreated={mockOnPrCreated}
          onPrUpdated={mockOnPrUpdated}
          addToast={mockAddToast}
        />
      );

      fireEvent.click(screen.getByText("Create PR"));
      fireEvent.click(screen.getByText("Cancel"));

      expect(screen.queryByPlaceholderText("PR title")).toBeNull();
    });

    it("creates PR when form is submitted", async () => {
      (createPr as ReturnType<typeof vi.fn>).mockResolvedValue(mockPrInfo);

      render(
        <PrSection
          taskId="FN-001"
          prAuthAvailable={true}
          onPrCreated={mockOnPrCreated}
          onPrUpdated={mockOnPrUpdated}
          addToast={mockAddToast}
        />
      );

      fireEvent.click(screen.getByText("Create PR"));
      fireEvent.change(screen.getByPlaceholderText("PR title"), {
        target: { value: "My PR Title" },
      });
      fireEvent.click(screen.getByText("Create PR"));

      await waitFor(() => {
        expect(createPr).toHaveBeenCalledWith("FN-001", {
          title: "My PR Title",
          body: undefined,
        }, undefined);
      });

      expect(mockOnPrCreated).toHaveBeenCalledWith(mockPrInfo);
      expect(mockAddToast).toHaveBeenCalledWith("Created PR #42", "success");
    });

    it("shows error when PR creation fails", async () => {
      (createPr as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("API error"));

      render(
        <PrSection
          taskId="FN-001"
          prAuthAvailable={true}
          onPrCreated={mockOnPrCreated}
          onPrUpdated={mockOnPrUpdated}
          addToast={mockAddToast}
        />
      );

      fireEvent.click(screen.getByText("Create PR"));
      fireEvent.change(screen.getByPlaceholderText("PR title"), {
        target: { value: "My PR Title" },
      });
      fireEvent.click(screen.getByText("Create PR"));

      await waitFor(() => {
        expect(mockAddToast).toHaveBeenCalledWith("API error", "error");
      });
    });
  });

  describe("when autoMerge is enabled", () => {
    it("hides manual PR controls and shows auto-merge messaging when no PR exists", () => {
      render(
        <PrSection
          taskId="FN-001"
          autoMerge={true}
          prAuthAvailable={true}
          onPrCreated={mockOnPrCreated}
          onPrUpdated={mockOnPrUpdated}
          addToast={mockAddToast}
        />
      );

      expect(screen.queryByRole("button", { name: "Create PR" })).toBeNull();
      expect(screen.queryByText(/gh auth login/i)).toBeNull();
      expect(screen.getByText("Auto-merge will handle this task automatically.")).toBeDefined();
    });

    it("does not show PR auth hint when auto-merge is enabled and PR auth is unavailable", () => {
      render(
        <PrSection
          taskId="FN-001"
          autoMerge={true}
          prAuthAvailable={false}
          onPrCreated={mockOnPrCreated}
          onPrUpdated={mockOnPrUpdated}
          addToast={mockAddToast}
        />
      );

      expect(screen.queryByText(/gh auth login/i)).toBeNull();
      expect(screen.getByText("Auto-merge will handle this task automatically.")).toBeDefined();
    });

    it("still shows the creating-pr automation message when automation is active", () => {
      render(
        <PrSection
          taskId="FN-001"
          autoMerge={true}
          automationStatus="creating-pr"
          prAuthAvailable={false}
          onPrCreated={mockOnPrCreated}
          onPrUpdated={mockOnPrUpdated}
          addToast={mockAddToast}
        />
      );

      expect(screen.getByText(/creating a pull request automatically/i)).toBeDefined();
      expect(screen.queryByText("Auto-merge will handle this task automatically.")).toBeNull();
      expect(screen.queryByRole("button", { name: "Create PR" })).toBeNull();
    });

    it("preserves manual PR creation behavior when auto-merge is disabled", () => {
      render(
        <PrSection
          taskId="FN-001"
          autoMerge={false}
          prAuthAvailable={false}
          onPrCreated={mockOnPrCreated}
          onPrUpdated={mockOnPrUpdated}
          addToast={mockAddToast}
        />
      );

      expect(screen.getByRole("button", { name: "Create PR" })).toBeDefined();
      expect(screen.getByText(/gh auth login/i)).toBeDefined();
      expect(screen.queryByText("Auto-merge will handle this task automatically.")).toBeNull();
    });
  });

  describe("when task has a PR", () => {
    it("displays PR info for open PR", () => {
      render(
        <PrSection
          taskId="FN-001"
          prInfo={mockPrInfo}
          prAuthAvailable={true}
          onPrCreated={mockOnPrCreated}
          onPrUpdated={mockOnPrUpdated}
          addToast={mockAddToast}
        />
      );

      expect(screen.getByText("#42")).toBeDefined();
      expect(screen.getByText("Fix the bug")).toBeDefined();
      expect(screen.getByText("open")).toBeDefined();
      expect(screen.getByText("View on GitHub")).toBeDefined();
    });

    it("shows correct status badge for merged PR", () => {
      render(
        <PrSection
          taskId="FN-001"
          prInfo={{ ...mockPrInfo, status: "merged" }}
          prAuthAvailable={true}
          onPrCreated={mockOnPrCreated}
          onPrUpdated={mockOnPrUpdated}
          addToast={mockAddToast}
        />
      );

      expect(screen.getByText("merged")).toBeDefined();
      expect(screen.getByText(/finish local cleanup and move the task to Done/i)).toBeDefined();
    });

    it("shows correct status badge for closed PR", () => {
      render(
        <PrSection
          taskId="FN-001"
          prInfo={{ ...mockPrInfo, status: "closed" }}
          prAuthAvailable={true}
          onPrCreated={mockOnPrCreated}
          onPrUpdated={mockOnPrUpdated}
          addToast={mockAddToast}
        />
      );

      expect(screen.getByText("closed")).toBeDefined();
    });

    it("displays comment count when PR has comments", () => {
      render(
        <PrSection
          taskId="FN-001"
          prInfo={{ ...mockPrInfo, commentCount: 5 }}
          prAuthAvailable={true}
          onPrCreated={mockOnPrCreated}
          onPrUpdated={mockOnPrUpdated}
          addToast={mockAddToast}
        />
      );

      // The comment count should be rendered
      expect(screen.getByText("5")).toBeDefined();
    });

    it("refreshes PR status when refresh button is clicked", async () => {
      const updatedPr = { ...mockPrInfo, status: "merged" as const };
      (refreshPrStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        prInfo: updatedPr,
        mergeReady: true,
        blockingReasons: [],
        reviewDecision: "APPROVED",
        checks: [{ name: "ci", required: true, state: "success" }],
        automationStatus: null,
      });

      render(
        <PrSection
          taskId="FN-001"
          prInfo={mockPrInfo}
          prAuthAvailable={true}
          onPrCreated={mockOnPrCreated}
          onPrUpdated={mockOnPrUpdated}
          addToast={mockAddToast}
        />
      );

      const refreshButton = screen.getByTitle("Refresh PR status");
      fireEvent.click(refreshButton);

      await waitFor(() => {
        expect(refreshPrStatus).toHaveBeenCalledWith("FN-001", undefined);
      });

      expect(mockOnPrUpdated).toHaveBeenCalledWith(updatedPr);
      expect(mockAddToast).toHaveBeenCalledWith("PR status refreshed", "success");
    });

    it("shows error when refresh fails", async () => {
      (refreshPrStatus as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Network error"));

      render(
        <PrSection
          taskId="FN-001"
          prInfo={mockPrInfo}
          prAuthAvailable={true}
          onPrCreated={mockOnPrCreated}
          onPrUpdated={mockOnPrUpdated}
          addToast={mockAddToast}
        />
      );

      const refreshButton = screen.getByTitle("Refresh PR status");
      fireEvent.click(refreshButton);

      await waitFor(() => {
        expect(mockAddToast).toHaveBeenCalledWith("Network error", "error");
      });
    });

    it("shows automatic PR creation message while PR-first automation is creating a PR", () => {
      render(
        <PrSection
          taskId="FN-001"
          automationStatus="creating-pr"
          prAuthAvailable={true}
          onPrCreated={mockOnPrCreated}
          onPrUpdated={mockOnPrUpdated}
          addToast={mockAddToast}
        />
      );

      expect(screen.getByText(/creating a pull request automatically/i)).toBeDefined();
      expect(screen.queryByText("Create PR")).toBeNull();
    });

    it("shows awaiting-checks messaging from refreshed merge blockers", async () => {
      (refreshPrStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        prInfo: mockPrInfo,
        mergeReady: false,
        blockingReasons: ["required checks not successful: ci (pending)"],
        reviewDecision: null,
        checks: [{ name: "ci", required: true, state: "pending" }],
        automationStatus: "awaiting-pr-checks",
      });

      render(
        <PrSection
          taskId="FN-001"
          prInfo={mockPrInfo}
          automationStatus="awaiting-pr-checks"
          prAuthAvailable={true}
          onPrCreated={mockOnPrCreated}
          onPrUpdated={mockOnPrUpdated}
          addToast={mockAddToast}
        />
      );

      fireEvent.click(screen.getByTitle("Refresh PR status"));

      await waitFor(() => {
        expect(screen.getByText(/Waiting for: required checks not successful: ci \(pending\)/)).toBeDefined();
      });
    });
  });
});
