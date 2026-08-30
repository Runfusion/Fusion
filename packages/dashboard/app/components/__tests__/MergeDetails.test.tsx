import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MergeDetails } from "../MergeDetails";

const makeTask = (overrides: any = {}) => ({
  id: "FN-001",
  description: "Task",
  column: "done",
  dependencies: [],
  steps: [],
  currentStep: 0,
  log: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("MergeDetails", () => {
  it("renders nothing when task is not done", () => {
    const { container } = render(<MergeDetails task={makeTask({ column: "in-review", mergeDetails: { commitSha: "abc1234" } })} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders merge metadata for done task", () => {
    render(
      <MergeDetails
        task={makeTask({
          mergeDetails: {
            commitSha: "abcdef123456",
            filesChanged: 5,
            insertions: 10,
            deletions: 2,
            mergedAt: "2026-01-01T01:00:00.000Z",
            prNumber: 42,
            mergeCommitMessage: "feat(FN-001): merge fusion/fn-001",
            mergeConfirmed: true,
            mergeTargetBranch: "main",
            resolutionStrategy: "ai",
            resolutionMethod: "auto",
            noOpReason: "Already landed",
          },
        })}
      />,
    );

    expect(screen.getByText("Merge Details")).toBeTruthy();
    expect(screen.getByText("abcdef1")).toBeTruthy();
    expect(screen.getByText("Files in merge commit")).toBeTruthy();
    expect(screen.getByText("Merge-commit insertions / deletions")).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
    expect(screen.getByText("+10 / -2")).toBeTruthy();
    expect(screen.getAllByTitle("Final commit shortstat; for the full landed diff across all task commits, see the Changes tab.")).toHaveLength(2);
    expect(screen.getByText("#42")).toBeTruthy();
    expect(screen.getByText("feat(FN-001): merge fusion/fn-001")).toBeTruthy();
    expect(screen.getByText("Merged successfully")).toBeTruthy();
    expect(screen.getByText("Target branch")).toBeTruthy();
    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.getByText("Strategy")).toBeTruthy();
    expect(screen.getByText("ai")).toBeTruthy();
    expect(screen.getByText("Method")).toBeTruthy();
    expect(screen.getByText("auto")).toBeTruthy();
    expect(screen.getByText("No-op reason")).toBeTruthy();
    expect(screen.getByText("Already landed")).toBeTruthy();
  });

  it("omits optional resolution rows when merge details do not carry them", () => {
    render(<MergeDetails task={makeTask({ mergeDetails: { commitSha: "abcdef123456" } })} />);

    expect(screen.queryByText("Target branch")).toBeNull();
    expect(screen.queryByText("Strategy")).toBeNull();
    expect(screen.queryByText("Method")).toBeNull();
    expect(screen.queryByText("No-op reason")).toBeNull();
  });
});
