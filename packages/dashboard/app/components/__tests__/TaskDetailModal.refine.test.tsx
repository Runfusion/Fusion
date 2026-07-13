import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopMove,
  noopOpenDetail,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailModal } from "../TaskDetailModal";
import { ModalDismissPreferenceProvider } from "../../hooks/useOverlayDismiss";
import { refineTask } from "../../api";

setupTaskDetailModalHooks();

const renderDoneTaskDetail = (options: {
  column?: "done" | "in-review";
  initialAction?: { action: "refine"; requestId: number };
  addToast?: (message: string, type?: any) => void;
  onClose?: () => void;
  dismissPreferenceEnabled?: boolean;
} = {}) => {
  const modal = (
    <TaskDetailModal
      task={makeTask({ id: "FN-001", column: options.column ?? "done", status: options.column === "in-review" ? "review" as any : "done" as any })}
      initialTab="definition"
      initialAction={options.initialAction}
      onClose={options.onClose ?? noop}
      onMoveTask={noopMove}
      onDeleteTask={noopDelete}
      onMergeTask={noopMerge}
      onOpenDetail={noopOpenDetail}
      addToast={options.addToast ?? noop}
    />
  );

  return render(
    options.dismissPreferenceEnabled === undefined
      ? modal
      : <ModalDismissPreferenceProvider enabled={options.dismissPreferenceEnabled}>{modal}</ModalDismissPreferenceProvider>,
  );
};

const openRefineFromActionsMenu = () => {
  fireEvent.click(screen.getByRole("button", { name: "Actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Refine" }));
};

const openRefineFromActionsMenuTouch = () => {
  fireEvent.click(screen.getByRole("button", { name: "Actions" }));
  const refineItem = screen.getByRole("menuitem", { name: "Refine" });
  fireEvent.pointerUp(refineItem, { pointerType: "touch" });
};

const expectRefineComposerOpen = () => {
  expect(screen.getByText("Refine", { selector: "h3" })).toBeInTheDocument();
  expect(screen.getByPlaceholderText("Enter your feedback here...")).toBeInTheDocument();
};

const refineOverlay = () => {
  const overlay = document.querySelector(".detail-refine-overlay");
  expect(overlay).toBeInstanceOf(HTMLElement);
  return overlay as HTMLElement;
};

/*
FNXC:TaskDetailRefine 2026-07-12-00:00:
The refine dialog must stay open across desktop menu clicks, mobile pointer activation, initialAction deep links, and Android compatibility mouse events; only explicit controls, Escape, or preference-enabled real backdrop presses may close it.
*/
describe("TaskDetailModal refine modal dismissal invariant", () => {
  beforeEach(() => {
    vi.mocked(refineTask).mockClear();
    vi.mocked(refineTask).mockResolvedValue({ id: "FN-002", column: "todo" } as any);
  });

  it("keeps the in-modal actions-menu refine dialog open through the desktop opening click", () => {
    renderDoneTaskDetail({ column: "done" });

    openRefineFromActionsMenu();

    expectRefineComposerOpen();
  });

  it("keeps the in-review refine dialog open through mobile touch activation and Android compatibility mouse events", () => {
    renderDoneTaskDetail({ column: "in-review" });

    openRefineFromActionsMenuTouch();
    expectRefineComposerOpen();

    const overlay = refineOverlay();
    fireEvent.touchEnd(document);
    fireEvent.mouseDown(overlay);
    fireEvent.mouseUp(overlay);
    fireEvent.click(overlay);

    expectRefineComposerOpen();
  });

  it("keeps the initialAction refine dialog open through Android compatibility mouse events after touchend", () => {
    renderDoneTaskDetail({ initialAction: { action: "refine", requestId: 1 } });

    expectRefineComposerOpen();
    const overlay = refineOverlay();
    fireEvent.touchEnd(document);
    fireEvent.mouseDown(overlay);
    fireEvent.mouseUp(overlay);
    fireEvent.click(overlay);

    expectRefineComposerOpen();
  });

  it("matches global backdrop-dismiss preference semantics", () => {
    const { unmount } = renderDoneTaskDetail({ dismissPreferenceEnabled: false });
    openRefineFromActionsMenu();
    const disabledOverlay = refineOverlay();

    fireEvent.mouseDown(disabledOverlay);
    fireEvent.mouseUp(disabledOverlay);
    fireEvent.click(disabledOverlay);

    expectRefineComposerOpen();
    unmount();

    renderDoneTaskDetail({ dismissPreferenceEnabled: true });
    openRefineFromActionsMenu();
    const enabledOverlay = refineOverlay();

    fireEvent.mouseDown(enabledOverlay);
    fireEvent.mouseUp(enabledOverlay);

    expect(screen.queryByPlaceholderText("Enter your feedback here...")).not.toBeInTheDocument();
  });

  it("preserves explicit close, cancel, and Escape close paths", () => {
    const firstRender = renderDoneTaskDetail();
    openRefineFromActionsMenu();
    const modal = document.querySelector(".detail-refine-modal");
    expect(modal).toBeInstanceOf(HTMLElement);

    fireEvent.click(within(modal as HTMLElement).getByRole("button", { name: "Close" }));
    expect(screen.queryByPlaceholderText("Enter your feedback here...")).not.toBeInTheDocument();

    openRefineFromActionsMenu();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByPlaceholderText("Enter your feedback here...")).not.toBeInTheDocument();
    firstRender.unmount();

    const onClose = vi.fn();
    renderDoneTaskDetail({ onClose });
    openRefineFromActionsMenu();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("preserves refinement validation and submit behavior", async () => {
    const user = userEvent.setup();
    const addToast = vi.fn();
    const onClose = vi.fn();
    renderDoneTaskDetail({ addToast, onClose });
    openRefineFromActionsMenu();

    expect(screen.getByRole("button", { name: "Create Refinement Task" })).toBeDisabled();
    expect(refineTask).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText("Enter your feedback here..."), { target: { value: "x".repeat(2001) } });
    fireEvent.click(screen.getByRole("button", { name: "Create Refinement Task" }));
    expect(addToast).toHaveBeenCalledWith("Feedback must be 2000 characters or less", "error");
    expect(refineTask).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText("Enter your feedback here..."), { target: { value: "Please add the missing regression coverage" } });
    await user.click(screen.getByRole("button", { name: "Create Refinement Task" }));

    await waitFor(() => {
      expect(refineTask).toHaveBeenCalledWith("FN-001", "Please add the missing regression coverage", undefined);
      expect(addToast).toHaveBeenCalledWith("Refinement task created: FN-002", "success");
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
