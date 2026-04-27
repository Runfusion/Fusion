import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConfirmDialog } from "../ConfirmDialog";

describe("ConfirmDialog", () => {
  it("renders title and message", () => {
    render(
      <ConfirmDialog
        isOpen={true}
        options={{ title: "Delete Task", message: "Delete FN-001?", danger: true }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Delete Task" })).toBeInTheDocument();
    expect(screen.getByText("Delete FN-001?")).toBeInTheDocument();
  });

  it("calls onConfirm when confirm button clicked", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        isOpen={true}
        options={{ title: "Merge Task", message: "Merge now?" }}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when cancel button clicked", () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        isOpen={true}
        options={{ title: "Discard", message: "Discard changes?" }}
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel on Escape key", () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        isOpen={true}
        options={{ title: "Discard", message: "Discard changes?" }}
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when overlay clicked", () => {
    const onCancel = vi.fn();
    const { container } = render(
      <ConfirmDialog
        isOpen={true}
        options={{ title: "Discard", message: "Discard changes?" }}
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );

    const overlay = container.querySelector(".modal-overlay");
    expect(overlay).toBeTruthy();
    fireEvent.click(overlay as Element);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("focuses cancel button on mount", () => {
    render(
      <ConfirmDialog
        isOpen={true}
        options={{ title: "Discard", message: "Discard changes?" }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });
});
