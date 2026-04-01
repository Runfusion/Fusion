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
          },
        })}
      />,
    );

    expect(screen.getByText("Merge Details")).toBeTruthy();
    expect(screen.getByText("abcdef1")).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
    expect(screen.getByText("+10 / -2")).toBeTruthy();
    expect(screen.getByText("#42")).toBeTruthy();
    expect(screen.getByText("feat(FN-001): merge fusion/fn-001")).toBeTruthy();
    expect(screen.getByText("Merged successfully")).toBeTruthy();
  });
});
