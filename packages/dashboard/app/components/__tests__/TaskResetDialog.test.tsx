import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { readAppFile } from "../../test/cssFixture";
import { TaskResetDialog } from "../TaskResetDialog";

function renderDialog(overrides: Partial<ComponentProps<typeof TaskResetDialog>> = {}) {
  const props = {
    taskId: "FN-233",
    initialDescription: "Original request",
    onReset: vi.fn().mockResolvedValue(undefined),
    addToast: vi.fn(),
    onClose: vi.fn(),
    onResetCompleted: vi.fn(),
    ...overrides,
  };
  const view = render(<TaskResetDialog {...props} />);
  return { ...view, props };
}

describe("TaskResetDialog", () => {
  it("pre-fills the textarea with the current description", () => {
    renderDialog({ initialDescription: "Build the corrected workflow" });

    expect(screen.getByTestId("task-reset-description")).toHaveValue("Build the corrected workflow");
  });

  it("requires a non-whitespace description before reset", async () => {
    const user = userEvent.setup();
    const { props } = renderDialog({ initialDescription: undefined });
    const textarea = screen.getByTestId("task-reset-description");
    const submit = screen.getByTestId("task-reset-submit");

    expect(textarea).toHaveValue("");
    expect(submit).toBeDisabled();
    expect(screen.getByText("A description is required.")).toBeInTheDocument();
    await user.type(textarea, "   ");
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(props.onReset).not.toHaveBeenCalled();
  });

  it("forwards one trimmed edited description and completes", async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();
    const textarea = screen.getByTestId("task-reset-description");
    await user.clear(textarea);
    await user.type(textarea, "  Corrected request  ");
    await user.click(screen.getByTestId("task-reset-submit"));

    await waitFor(() => expect(props.onReset).toHaveBeenCalledWith(
      "FN-233",
      { description: "Corrected request" },
    ));
    expect(props.onReset).toHaveBeenCalledOnce();
    expect(props.addToast).toHaveBeenCalledWith(
      "Reset FN-233 — fresh run will be allocated",
      "success",
    );
    expect(props.onResetCompleted).toHaveBeenCalledOnce();
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("uses the exact legacy call arity for an unchanged description", async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();

    await user.click(screen.getByTestId("task-reset-submit"));

    await waitFor(() => expect(props.onReset).toHaveBeenCalledWith("FN-233"));
    expect(props.onReset.mock.calls[0]).toEqual(["FN-233"]);
  });

  it("keeps the dialog open and reports a rejected reset", async () => {
    const user = userEvent.setup();
    const { props } = renderDialog({ onReset: vi.fn().mockRejectedValue(new Error("cleanup failed")) });

    await user.click(screen.getByTestId("task-reset-submit"));

    await waitFor(() => expect(props.addToast).toHaveBeenCalledWith("cleanup failed", "error"));
    expect(screen.getByTestId("task-reset-dialog")).toBeInTheDocument();
    expect(props.addToast).not.toHaveBeenCalledWith(expect.anything(), "success");
    expect(props.onResetCompleted).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("does not cap or truncate a long description", () => {
    const description = "x".repeat(5_000);
    renderDialog({ initialDescription: description });

    const textarea = screen.getByTestId("task-reset-description");
    expect(textarea).toHaveValue(description);
    expect(textarea).not.toHaveAttribute("maxlength");
  });

  it("re-seeds from the current description after remount", () => {
    const first = renderDialog({ initialDescription: "First request" });
    expect(screen.getByTestId("task-reset-description")).toHaveValue("First request");
    first.unmount();

    renderDialog({ initialDescription: "Updated request" });
    expect(screen.getByTestId("task-reset-description")).toHaveValue("Updated request");
  });

  it("keeps responsive CSS token-only apart from the canonical breakpoint", () => {
    const css = readAppFile("components/TaskResetDialog.css");
    expect(css).toContain("@media (max-width: 768px)");
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toContain("rgba(");
    expect(css.replace("768px", "")).not.toMatch(/(?<![\w-])(?:[1-9]\d*|0?\.\d+)px\b/);
  });
});
