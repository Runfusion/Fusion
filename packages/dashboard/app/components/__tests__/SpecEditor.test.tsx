import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { SpecEditor } from "../SpecEditor";

describe("SpecEditor", () => {
  const mockContent = `# KB-001 - Test Task

**Created:** 2026-01-01
**Size:** M

## Mission

Test mission description.

## Steps

### Step 1: Implementation
- [ ] Do something
`;

  const mockOnSave = vi.fn().mockResolvedValue(undefined);
  const mockOnRequestRevision = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders markdown content in view mode by default", () => {
    render(<SpecEditor content={mockContent} />);

    // Should show "View" button as active
    const viewButton = screen.getByText("View");
    expect(viewButton.classList.contains("btn-primary")).toBe(true);

    // Should render markdown content (without leading heading)
    expect(screen.getByText("Test mission description.")).toBeTruthy();

    // Should not show textarea in view mode
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("strips leading heading from markdown rendering", () => {
    render(<SpecEditor content={mockContent} />);

    // The h1 heading should be stripped
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();

    // But other content should be rendered
    expect(screen.getByText("Mission")).toBeTruthy();
  });

  it("shows empty state when no content", () => {
    render(<SpecEditor content="" />);

    expect(screen.getByText("(no specification)")).toBeTruthy();
  });

  it("switches to edit mode when clicking Edit button", () => {
    render(<SpecEditor content={mockContent} onSave={mockOnSave} />);

    fireEvent.click(screen.getByText("Edit"));

    // Edit button should now be active
    const editButton = screen.getByText("Edit");
    expect(editButton.classList.contains("btn-primary")).toBe(true);

    // Textarea should be visible with full content (including heading)
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    expect(textarea.value).toBe(mockContent);
  });

  it("switches back to view mode when clicking View button", () => {
    render(<SpecEditor content={mockContent} onSave={mockOnSave} />);

    // Enter edit mode
    fireEvent.click(screen.getByText("Edit"));
    expect(screen.getByRole("textbox")).toBeTruthy();

    // Click View to cancel
    fireEvent.click(screen.getByText("View"));

    // Should be back in view mode
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("Test mission description.")).toBeTruthy();
  });

  it("disables Edit button when already in edit mode", () => {
    render(<SpecEditor content={mockContent} onSave={mockOnSave} />);

    fireEvent.click(screen.getByText("Edit"));

    const editButton = screen.getByText("Edit") as HTMLButtonElement;
    expect(editButton.disabled).toBe(true);
  });

  it("disables View button when in view mode", () => {
    render(<SpecEditor content={mockContent} onSave={mockOnSave} />);

    const viewButton = screen.getByText("View") as HTMLButtonElement;
    expect(viewButton.disabled).toBe(true);
  });

  it("calls onSave with edited content when clicking Save", async () => {
    render(<SpecEditor content={mockContent} onSave={mockOnSave} />);

    // Enter edit mode
    fireEvent.click(screen.getByText("Edit"));

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    const newContent = "# Updated Content\n\nNew description.";

    fireEvent.change(textarea, { target: { value: newContent } });

    // Save button should be enabled after changes
    const saveButton = screen.getByText("Save") as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);

    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(mockOnSave).toHaveBeenCalledWith(newContent);
    });
  });

  it("disables save button when content is unchanged", () => {
    render(<SpecEditor content={mockContent} onSave={mockOnSave} />);

    fireEvent.click(screen.getByText("Edit"));

    const saveButton = screen.getByText("Save") as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
  });

  it("disables save button when isSaving is true", () => {
    render(<SpecEditor content={mockContent} onSave={mockOnSave} isSaving={true} />);

    fireEvent.click(screen.getByText("Edit"));

    // Make a change
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Changed" } });

    const saveButton = screen.getByText("Saving…") as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
  });

  it("shows saving state on save button", () => {
    render(<SpecEditor content={mockContent} onSave={mockOnSave} isSaving={true} />);

    fireEvent.click(screen.getByText("Edit"));

    expect(screen.getByText("Saving…")).toBeTruthy();
  });

  it("resets content to original when canceling edit", () => {
    render(<SpecEditor content={mockContent} onSave={mockOnSave} />);

    fireEvent.click(screen.getByText("Edit"));

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Changed content" } });

    fireEvent.click(screen.getByText("Cancel"));

    // Re-enter edit mode
    fireEvent.click(screen.getByText("Edit"));

    // Should show original content
    expect((screen.getByRole("textbox") as HTMLTextAreaElement). value).toBe(mockContent);
  });

  it("does not show edit controls in readOnly mode", () => {
    render(<SpecEditor content={mockContent} readOnly={true} />);

    expect(screen.queryByText("Edit")).toBeNull();
    expect(screen.queryByText("Save")).toBeNull();
    expect(screen.queryByText("Cancel")).toBeNull();
  });

  it("shows AI revision section when onRequestRevision is provided", () => {
    render(
      <SpecEditor
        content={mockContent}
        onSave={mockOnSave}
        onRequestRevision={mockOnRequestRevision}
      />
    );

    expect(screen.getByText("Ask AI to Revise")).toBeTruthy();
    expect(screen.getByPlaceholderText(/e.g., 'Add more details/)).toBeTruthy();
    expect(screen.getByText("Request AI Revision")).toBeTruthy();
  });

  it("does not show AI revision section when onRequestRevision is not provided", () => {
    render(<SpecEditor content={mockContent} onSave={mockOnSave} />);

    expect(screen.queryByText("Ask AI to Revise")).toBeNull();
    expect(screen.queryByText("Request AI Revision")).toBeNull();
  });

  it("does not show AI revision section in readOnly mode", () => {
    render(
      <SpecEditor
        content={mockContent}
        readOnly={true}
        onRequestRevision={mockOnRequestRevision}
      />
    );

    expect(screen.queryByText("Ask AI to Revise")).toBeNull();
  });

  it("calls onRequestRevision with feedback when clicking Request AI Revision", async () => {
    render(
      <SpecEditor
        content={mockContent}
        onSave={mockOnSave}
        onRequestRevision={mockOnRequestRevision}
      />
    );

    const feedbackInput = screen.getByPlaceholderText(/e.g., 'Add more details/) as HTMLTextAreaElement;
    const feedbackText = "Please add more details about error handling";

    fireEvent.change(feedbackInput, { target: { value: feedbackText } });
    fireEvent.click(screen.getByText("Request AI Revision"));

    await waitFor(() => {
      expect(mockOnRequestRevision).toHaveBeenCalledWith(feedbackText);
    });
  });

  it("clears feedback after successful revision request", async () => {
    render(
      <SpecEditor
        content={mockContent}
        onSave={mockOnSave}
        onRequestRevision={mockOnRequestRevision}
      />
    );

    const feedbackInput = screen.getByPlaceholderText(/e.g., 'Add more details/) as HTMLTextAreaElement;

    fireEvent.change(feedbackInput, { target: { value: "Some feedback" } });
    fireEvent.click(screen.getByText("Request AI Revision"));

    await waitFor(() => {
      expect(feedbackInput.value).toBe("");
    });
  });

  it("disables revision request button when feedback is empty", () => {
    render(
      <SpecEditor
        content={mockContent}
        onSave={mockOnSave}
        onRequestRevision={mockOnRequestRevision}
      />
    );

    const button = screen.getByText("Request AI Revision") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("disables revision request button when isRequesting is true", () => {
    render(
      <SpecEditor
        content={mockContent}
        onSave={mockOnSave}
        onRequestRevision={mockOnRequestRevision}
        isRequesting={true}
      />
    );

    const feedbackInput = screen.getByPlaceholderText(/e.g., 'Add more details/) as HTMLTextAreaElement;
    fireEvent.change(feedbackInput, { target: { value: "Some feedback" } });

    const button = screen.getByText("Requesting…") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("shows requesting state on revision button", () => {
    render(
      <SpecEditor
        content={mockContent}
        onSave={mockOnSave}
        onRequestRevision={mockOnRequestRevision}
        isRequesting={true}
      />
    );

    expect(screen.getByText("Requesting…")).toBeTruthy();
  });

  it("shows character count for feedback", () => {
    render(
      <SpecEditor
        content={mockContent}
        onSave={mockOnSave}
        onRequestRevision={mockOnRequestRevision}
      />
    );

    const feedbackInput = screen.getByPlaceholderText(/e.g., 'Add more details/) as HTMLTextAreaElement;

    fireEvent.change(feedbackInput, { target: { value: "Hello" } });

    expect(screen.getByText("5/2000")).toBeTruthy();
  });

  it("enforces maxLength on feedback textarea", () => {
    render(
      <SpecEditor
        content={mockContent}
        onSave={mockOnSave}
        onRequestRevision={mockOnRequestRevision}
      />
    );

    const feedbackInput = screen.getByPlaceholderText(/e.g., 'Add more details/) as HTMLTextAreaElement;

    expect(feedbackInput.getAttribute("maxLength")).toBe("2000");
  });

  it("triggers save on Ctrl+Enter keyboard shortcut in edit mode", async () => {
    render(<SpecEditor content={mockContent} onSave={mockOnSave} />);

    fireEvent.click(screen.getByText("Edit"));

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    const newContent = "# Updated Content\n\nNew description.";

    fireEvent.change(textarea, { target: { value: newContent } });

    // Simulate Ctrl+Enter
    await act(async () => {
      fireEvent.keyDown(document, { key: "Enter", ctrlKey: true });
    });

    await waitFor(() => {
      expect(mockOnSave).toHaveBeenCalledWith(newContent);
    });
  });

  it("triggers save on Cmd+Enter keyboard shortcut in edit mode", async () => {
    render(<SpecEditor content={mockContent} onSave={mockOnSave} />);

    fireEvent.click(screen.getByText("Edit"));

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    const newContent = "# Updated Content\n\nNew description.";

    fireEvent.change(textarea, { target: { value: newContent } });

    // Simulate Cmd+Enter
    await act(async () => {
      fireEvent.keyDown(document, { key: "Enter", metaKey: true });
    });

    await waitFor(() => {
      expect(mockOnSave).toHaveBeenCalledWith(newContent);
    });
  });

  it("does not trigger save on Ctrl+Enter when not in edit mode", async () => {
    render(<SpecEditor content={mockContent} onSave={mockOnSave} />);

    // Not in edit mode
    await act(async () => {
      fireEvent.keyDown(document, { key: "Enter", ctrlKey: true });
    });

    expect(mockOnSave).not.toHaveBeenCalled();
  });

  it("does not trigger save on Ctrl+Enter when save button is disabled", async () => {
    render(<SpecEditor content={mockContent} onSave={mockOnSave} />);

    fireEvent.click(screen.getByText("Edit"));
    // No changes made, so save should be disabled

    await act(async () => {
      fireEvent.keyDown(document, { key: "Enter", ctrlKey: true });
    });

    expect(mockOnSave).not.toHaveBeenCalled();
  });

  it("prevents default on Ctrl+Enter keyboard shortcut", async () => {
    render(<SpecEditor content={mockContent} onSave={mockOnSave} />);

    fireEvent.click(screen.getByText("Edit"));

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Changed" } });

    const keyDownEvent = new KeyboardEvent("keydown", {
      key: "Enter",
      ctrlKey: true,
      bubbles: true,
    });
    const preventDefaultSpy = vi.spyOn(keyDownEvent, "preventDefault");

    document.dispatchEvent(keyDownEvent);

    expect(preventDefaultSpy).toHaveBeenCalled();
  });

  it("updates content when prop changes while in view mode", () => {
    const { rerender } = render(<SpecEditor content={mockContent} />);

    expect(screen.getByText("Test mission description.")).toBeTruthy();

    const newContent = "# New Task\n\nUpdated description.";
    rerender(<SpecEditor content={newContent} />);

    expect(screen.getByText("Updated description.")).toBeTruthy();
  });

  it("does not update textarea content when prop changes while in edit mode", () => {
    const { rerender } = render(<SpecEditor content={mockContent} onSave={mockOnSave} />);

    fireEvent.click(screen.getByText("Edit"));

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "User edited content" } });

    // Re-render with different content
    rerender(<SpecEditor content="# Different\n\nDifferent content." onSave={mockOnSave} />);

    // Textarea should still show user's edits
    expect(textarea.value).toBe("User edited content");
  });

  it("shows keyboard hint in edit mode", () => {
    render(<SpecEditor content={mockContent} onSave={mockOnSave} />);

    fireEvent.click(screen.getByText("Edit"));

    // Check for keyboard hint text (use a more specific query)
    expect(screen.getByText(/Press/)).toBeTruthy();
    // Check for individual kbd elements
    const kbdElements = screen.getAllByText("Enter");
    expect(kbdElements.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Ctrl/)).toBeTruthy();
    expect(screen.getByText(/Cmd/)).toBeTruthy();
  });

  it("does not show keyboard hint in view mode", () => {
    render(<SpecEditor content={mockContent} onSave={mockOnSave} />);

    expect(screen.queryByText(/Ctrl/)).toBeNull();
  });
});
