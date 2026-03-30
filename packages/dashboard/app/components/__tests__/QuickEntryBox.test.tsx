import { describe, it, expect, vi } from "vitest";
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
  it("renders input with placeholder", () => {
    renderQuickEntryBox();
    const input = screen.getByTestId("quick-entry-input");
    expect(input).toBeTruthy();
    expect((input as HTMLInputElement).placeholder).toBe("Add a task...");
  });

  it("creates task on Enter key", async () => {
    const { props } = renderQuickEntryBox();
    const input = screen.getByTestId("quick-entry-input");

    fireEvent.change(input, { target: { value: "New task description" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(props.onCreate).toHaveBeenCalledWith("New task description");
    });
  });

  it("shows loading state during creation", async () => {
    const { props } = renderQuickEntryBox();
    // Slow down the promise to see loading state
    props.onCreate.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 100)));

    const input = screen.getByTestId("quick-entry-input");
    fireEvent.change(input, { target: { value: "New task" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Check loading placeholder
    await waitFor(() => {
      expect((input as HTMLInputElement).placeholder).toBe("Creating...");
    });

    // Input should be disabled during creation
    expect(input).toBeDisabled();
  });

  it("clears input after successful creation", async () => {
    const { props } = renderQuickEntryBox();
    const input = screen.getByTestId("quick-entry-input");

    fireEvent.change(input, { target: { value: "Task to create" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(props.onCreate).toHaveBeenCalled();
    });

    expect((input as HTMLInputElement).value).toBe("");
  });

  it("shows error toast on failure and keeps input content", async () => {
    const { props } = renderQuickEntryBox();
    props.onCreate.mockRejectedValue(new Error("Network error"));

    const input = screen.getByTestId("quick-entry-input");
    fireEvent.change(input, { target: { value: "Failed task" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(props.addToast).toHaveBeenCalledWith("Network error", "error");
    });

    // Input content should be preserved for retry
    expect((input as HTMLInputElement).value).toBe("Failed task");
  });

  it("clears non-empty input on Escape key", () => {
    renderQuickEntryBox();
    const input = screen.getByTestId("quick-entry-input");

    fireEvent.change(input, { target: { value: "Some text" } });
    expect((input as HTMLInputElement).value).toBe("Some text");

    fireEvent.keyDown(input, { key: "Escape" });
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("does not clear empty input on Escape key", () => {
    renderQuickEntryBox();
    const input = screen.getByTestId("quick-entry-input");

    fireEvent.keyDown(input, { key: "Escape" });
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("does not submit on Enter if input is empty", async () => {
    const { props } = renderQuickEntryBox();
    const input = screen.getByTestId("quick-entry-input");

    fireEvent.keyDown(input, { key: "Enter" });

    // Wait a bit to ensure no async call happens
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(props.onCreate).not.toHaveBeenCalled();
  });

  it("does not submit on Enter if input is only whitespace", async () => {
    const { props } = renderQuickEntryBox();
    const input = screen.getByTestId("quick-entry-input");

    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(props.onCreate).not.toHaveBeenCalled();
  });

  it("prevents default on Enter key", () => {
    renderQuickEntryBox();
    const input = screen.getByTestId("quick-entry-input");

    fireEvent.change(input, { target: { value: "Task" } });
    const prevented = !fireEvent.keyDown(input, { key: "Enter" });

    expect(prevented).toBe(true);
  });

  it("updates input value on change", () => {
    renderQuickEntryBox();
    const input = screen.getByTestId("quick-entry-input");

    fireEvent.change(input, { target: { value: "Updated text" } });
    expect((input as HTMLInputElement).value).toBe("Updated text");
  });

  it("trims whitespace when creating task", async () => {
    const { props } = renderQuickEntryBox();
    const input = screen.getByTestId("quick-entry-input");

    fireEvent.change(input, { target: { value: "  Task with spaces  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(props.onCreate).toHaveBeenCalledWith("Task with spaces");
    });
  });
});
