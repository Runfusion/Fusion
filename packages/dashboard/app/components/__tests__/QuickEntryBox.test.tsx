import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QuickEntryBox } from "../QuickEntryBox";

function renderQuickEntryBox() {
  const props = {
    onCreate: vi.fn().mockResolvedValue(undefined),
    addToast: vi.fn(),
  };
  const result = render(<QuickEntryBox {...props} />);
  return { ...result, props };
}

describe("QuickEntryBox", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("renders textarea with placeholder", () => {
    renderQuickEntryBox();
    const textarea = screen.getByTestId("quick-entry-input");
    expect(textarea).toBeTruthy();
    expect(textarea.tagName.toLowerCase()).toBe("textarea");
    expect((textarea as HTMLTextAreaElement).placeholder).toBe("Add a task...");
  });

  it("expands on focus", () => {
    renderQuickEntryBox();
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.focus(textarea);

    expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);
  });

  it("collapses on blur when empty", async () => {
    renderQuickEntryBox();
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.focus(textarea);
    expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);

    fireEvent.blur(textarea);
    vi.advanceTimersByTime(250);

    await waitFor(() => {
      expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(false);
    });
  });

  it("stays expanded on blur when has content", async () => {
    renderQuickEntryBox();
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: "Some task" } });

    fireEvent.blur(textarea);
    await vi.advanceTimersByTimeAsync(250);

    // Should stay expanded because there's content
    expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);
  });

  it("creates task on Enter key", async () => {
    const { props } = renderQuickEntryBox();
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.change(textarea, { target: { value: "New task description" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(props.onCreate).toHaveBeenCalledWith("New task description");
    });
  });

  it("allows Shift+Enter to insert newline when expanded", () => {
    renderQuickEntryBox();
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: "Line 1" } });

    // Shift+Enter should not prevent default (allow newline)
    const event = fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

    // Event should not be prevented (returns false if preventDefault was called)
    expect(event).toBe(true);
  });

  it("submits on Enter even when expanded (without Shift)", async () => {
    const { props } = renderQuickEntryBox();
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: "Task to submit" } });

    // Enter without Shift should submit
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(props.onCreate).toHaveBeenCalledWith("Task to submit");
    });
  });

  it("prevents default on Enter key (without Shift)", () => {
    renderQuickEntryBox();
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.change(textarea, { target: { value: "Task" } });
    const event = fireEvent.keyDown(textarea, { key: "Enter" });

    // Event is prevented (returns false)
    expect(event).toBe(false);
  });

  it("shows loading state during creation", async () => {
    const { props } = renderQuickEntryBox();
    // Slow down the promise to see loading state
    props.onCreate.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 100)));

    const textarea = screen.getByTestId("quick-entry-input");
    fireEvent.change(textarea, { target: { value: "New task" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    // Check loading placeholder
    await waitFor(() => {
      expect((textarea as HTMLTextAreaElement).placeholder).toBe("Creating...");
    });

    // Textarea should be disabled during creation
    expect(textarea).toBeDisabled();
  });

  it("clears input after successful creation", async () => {
    const { props } = renderQuickEntryBox();
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.change(textarea, { target: { value: "Task to create" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(props.onCreate).toHaveBeenCalled();
    });

    expect((textarea as HTMLTextAreaElement).value).toBe("");
  });

  it("shows error toast on failure and keeps input content", async () => {
    const { props } = renderQuickEntryBox();
    props.onCreate.mockRejectedValue(new Error("Network error"));

    const textarea = screen.getByTestId("quick-entry-input");
    fireEvent.change(textarea, { target: { value: "Failed task" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(props.addToast).toHaveBeenCalledWith("Network error", "error");
    });

    // Input content should be preserved for retry
    expect((textarea as HTMLTextAreaElement).value).toBe("Failed task");
  });

  it("clears non-empty input on Escape key", () => {
    renderQuickEntryBox();
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.change(textarea, { target: { value: "Some text" } });
    expect((textarea as HTMLTextAreaElement).value).toBe("Some text");

    fireEvent.keyDown(textarea, { key: "Escape" });
    expect((textarea as HTMLTextAreaElement).value).toBe("");
  });

  it("collapses and blurs on Escape key", () => {
    renderQuickEntryBox();
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.focus(textarea);
    expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);

    fireEvent.keyDown(textarea, { key: "Escape" });

    expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(false);
  });

  it("does not clear empty input on Escape key", () => {
    renderQuickEntryBox();
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.keyDown(textarea, { key: "Escape" });
    expect((textarea as HTMLTextAreaElement).value).toBe("");
  });

  it("does not submit on Enter if input is empty", async () => {
    const { props } = renderQuickEntryBox();
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.keyDown(textarea, { key: "Enter" });

    // Wait a bit to ensure no async call happens
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(props.onCreate).not.toHaveBeenCalled();
  });

  it("does not submit on Enter if input is only whitespace", async () => {
    const { props } = renderQuickEntryBox();
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.change(textarea, { target: { value: "   " } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(props.onCreate).not.toHaveBeenCalled();
  });

  it("updates textarea value on change", () => {
    renderQuickEntryBox();
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.change(textarea, { target: { value: "Updated text" } });
    expect((textarea as HTMLTextAreaElement).value).toBe("Updated text");
  });

  it("trims whitespace when creating task", async () => {
    const { props } = renderQuickEntryBox();
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.change(textarea, { target: { value: "  Task with spaces  " } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(props.onCreate).toHaveBeenCalledWith("Task with spaces");
    });
  });

  it("maintains focus after successful creation", async () => {
    const { props } = renderQuickEntryBox();
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.change(textarea, { target: { value: "Task to create" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(props.onCreate).toHaveBeenCalled();
    });

    // After successful creation, focus should be maintained
    expect(document.activeElement).toBe(textarea);
  });
});
