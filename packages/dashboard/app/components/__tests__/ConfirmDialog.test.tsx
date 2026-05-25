import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConfirmDialog } from "../ConfirmDialog";
import { loadAllAppCss } from "../../test/cssFixture";

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

  it("renders and handles tertiary action when configured", () => {
    const onTertiary = vi.fn();
    render(
      <ConfirmDialog
        isOpen={true}
        options={{ title: "Delete Done", message: "Delete or archive?", tertiaryLabel: "Archive Instead" }}
        onConfirm={vi.fn()}
        onTertiary={onTertiary}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Archive Instead" }));
    expect(onTertiary).toHaveBeenCalledTimes(1);
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

  it("uses compact mobile override classes on overlay and dialog surface", () => {
    const { container } = render(
      <ConfirmDialog
        isOpen={true}
        options={{ title: "Discard", message: "Discard changes?" }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(container.querySelector(".confirm-dialog-overlay")).toBeTruthy();
    expect(container.querySelector(".confirm-dialog.modal")).toBeTruthy();
  });

  it("does not render checkbox when checkboxLabel is omitted", () => {
    render(
      <ConfirmDialog
        isOpen={true}
        options={{ title: "Delete Task", message: "Delete FN-001?", danger: true }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("renders checkbox label and description when provided", () => {
    render(
      <ConfirmDialog
        isOpen={true}
        options={{ title: "Delete Task", message: "Delete FN-001?", danger: true }}
        checkboxLabel="Allow re-creation later"
        checkboxDescription="Keeps this ID unlockable"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole("checkbox")).toBeInTheDocument();
    expect(screen.getByText("Allow re-creation later")).toBeInTheDocument();
    expect(screen.getByText("Keeps this ID unlockable")).toBeInTheDocument();
  });

  it("calls onCheckboxChange when toggled", () => {
    const onCheckboxChange = vi.fn();
    render(
      <ConfirmDialog
        isOpen={true}
        options={{ title: "Delete Task", message: "Delete FN-001?", danger: true }}
        checkboxLabel="Allow re-creation later"
        checkboxChecked={false}
        onCheckboxChange={onCheckboxChange}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox"));
    expect(onCheckboxChange).toHaveBeenCalledWith(true);
  });

  it("uses only token values in confirm-dialog checkbox css rule", () => {
    const css = loadAllAppCss();
    const match = css.match(/\.confirm-dialog__checkbox\s*\{([^}]*)\}/);
    expect(match).toBeTruthy();
    const ruleBody = match?.[1] ?? "";
    expect(ruleBody).toMatch(/var\(--/);
    expect(ruleBody).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(/);
    expect(ruleBody).not.toMatch(/\b(?!0(?:\D|$))\d+(?:\.\d+)?px\b/);
  });
});
