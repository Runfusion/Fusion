import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SelectionCommentPopover, composeSelectionCommentDescription } from "../SelectionCommentPopover";

vi.mock("lucide-react", () => ({
  MessageSquarePlus: () => null,
}));

describe("SelectionCommentPopover", () => {
  it("renders a trigger for a selection and submits a composed task description", () => {
    const onSubmit = vi.fn();
    render(
      <SelectionCommentPopover
        selectedText="const answer = 42;"
        anchorRect={new DOMRect(20, 30, 100, 16)}
        filePath="src/example.ts"
        lineRange={{ start: 4, end: 4 }}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /add a comment/i }));
    fireEvent.change(screen.getByLabelText(/comment for the new task/i), {
      target: { value: "Turn this into a configurable value." },
    });
    fireEvent.click(screen.getByRole("button", { name: /send to new task/i }));

    expect(onSubmit).toHaveBeenCalledWith([
      "File: src/example.ts",
      "Lines: 4",
      "",
      "Selected snippet:",
      "```text",
      "const answer = 42;",
      "```",
      "",
      "Comment:",
      "Turn this into a configurable value.",
    ].join("\n"));
  });

  it("cancels cleanly without submitting", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <SelectionCommentPopover
        selectedText="snippet"
        anchorRect={new DOMRect(20, 30, 100, 16)}
        filePath="README.md"
        onSubmit={onSubmit}
        onCancel={onCancel}
        onOpenChange={onOpenChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /add a comment/i }));
    fireEvent.change(screen.getByLabelText(/comment for the new task/i), { target: { value: "A note" } });
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole("button", { name: /add a comment/i })).toBeInTheDocument();
  });

  it("uses a longer markdown fence when the snippet contains backticks", () => {
    expect(composeSelectionCommentDescription({
      filePath: "README.md",
      selectedText: "```js\ncode\n```",
      comment: "Move this example.",
    })).toContain("````text\n```js\ncode\n```\n````");
  });
});
