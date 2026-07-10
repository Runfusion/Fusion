import { readFileSync } from "node:fs";
import { join } from "node:path";
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

  /*
  FNXC:ArtifactsView 2026-07-10-16:20:
  Regression guard for the "Add comment does nothing" bug: the trigger is positioned solely
  by its transform translate, and the global `.btn:active { transform: scale(0.97) }` press
  feedback replaced it while pressed, moving the button out from under the cursor so `click`
  never fired. jsdom cannot reproduce hit-testing, so this invariant is asserted on the CSS:
  every `.selection-comment-trigger` transform rule — base AND :active, desktop AND mobile —
  must include the `translate(-50%` positioning component. The popover is shared by
  DocumentsView (plain + markdown preview) and FileEditor (editor + preview), so this one
  stylesheet invariant covers all surfaces.
  */
  it("keeps the positioning translate in every trigger transform, including :active press state", () => {
    const css = readFileSync(join(__dirname, "..", "SelectionCommentPopover.css"), "utf8");
    const uncommented = css.replace(/\/\*[\s\S]*?\*\//g, "");

    // Collect the declaration block of every rule whose selector list targets the trigger.
    const triggerBlocks: Array<{ selector: string; block: string }> = [];
    const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
    for (const match of uncommented.matchAll(rulePattern)) {
      const selector = match[1].trim();
      if (selector.split(",").some((part) => part.trim().startsWith(".selection-comment-trigger"))) {
        triggerBlocks.push({ selector, block: match[2] });
      }
    }

    const transformBlocks = triggerBlocks.filter(({ block }) => /transform\s*:/.test(block));
    // Base + :active on desktop, base + :active in the mobile media query.
    expect(transformBlocks.length).toBeGreaterThanOrEqual(4);

    for (const { selector, block } of transformBlocks) {
      expect(block, `trigger transform for "${selector}" must keep the positioning translate`).toContain("translate(-50%");
    }

    const activeBlocks = transformBlocks.filter(({ selector }) => selector.includes(":active"));
    expect(activeBlocks.length, "both desktop and mobile need an :active override that restates the translate").toBeGreaterThanOrEqual(2);
  });

  it("uses a longer markdown fence when the snippet contains backticks", () => {
    expect(composeSelectionCommentDescription({
      filePath: "README.md",
      selectedText: "```js\ncode\n```",
      comment: "Move this example.",
    })).toContain("````text\n```js\ncode\n```\n````");
  });
});
