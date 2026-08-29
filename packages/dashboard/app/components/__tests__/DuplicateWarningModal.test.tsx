import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DuplicateWarningModal } from "../DuplicateWarningModal";
import type { DuplicateMatch } from "../../api";

const matches: DuplicateMatch[] = [
  { id: "FN-101", title: "Fix duplicate task flow", description: "Prevent duplicate tasks from the quick entry surface", column: "todo", score: 0.81 },
  { id: "FN-102", title: "Another duplicate", description: "Detect duplicates before saving full dialog tasks", column: "in-progress", score: 0.67 },
];

describe("DuplicateWarningModal", () => {
  it("renders one row per match with id and description", () => {
    render(<DuplicateWarningModal matches={matches} onOpen={vi.fn()} onProceed={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByText("FN-101")).toBeInTheDocument();
    expect(screen.getByText("FN-102")).toBeInTheDocument();
    expect(screen.getByText("Prevent duplicate tasks from the quick entry surface")).toBeInTheDocument();
    expect(screen.getByText("Detect duplicates before saving full dialog tasks")).toBeInTheDocument();
    expect(screen.queryByText("Fix duplicate task flow")).not.toBeInTheDocument();
  });

  it("falls back from empty description to title then No description", () => {
    render(
      <DuplicateWarningModal
        matches={[
          { id: "FN-201", title: "Title fallback", description: "", column: "todo", score: 0.71 },
          { id: "FN-202", title: "", description: "", column: "todo", score: 0.62 },
        ]}
        onOpen={vi.fn()}
        onProceed={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText("Title fallback")).toBeInTheDocument();
    expect(screen.getByText("No description")).toBeInTheDocument();
  });

  it("calls onOpen with the selected id", () => {
    const onOpen = vi.fn();
    render(<DuplicateWarningModal matches={matches} onOpen={onOpen} onProceed={vi.fn()} onCancel={vi.fn()} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Open" })[1]);
    expect(onOpen).toHaveBeenCalledWith("FN-102");
  });

  it("calls onProceed", () => {
    const onProceed = vi.fn();
    render(<DuplicateWarningModal matches={matches} onOpen={vi.fn()} onProceed={onProceed} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Create anyway" }));
    expect(onProceed).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel for cancel click and Escape", () => {
    const onCancel = vi.fn();
    render(<DuplicateWarningModal matches={matches} onOpen={vi.fn()} onProceed={vi.fn()} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(document, { key: "Escape" });

    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
