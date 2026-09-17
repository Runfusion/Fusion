import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopOpenDetail,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailModal } from "../TaskDetailModal";
import { ModalDismissPreferenceProvider } from "../../hooks/useOverlayDismiss";
import { refineTask } from "../../api";
import { MAX_TASK_MESSAGE_LENGTH } from "@fusion/core";

setupTaskDetailModalHooks();

const renderDoneTaskDetail = (options: {
  column?: "done" | "in-review";
  addToast?: (message: string, type?: any) => void;
  onClose?: () => void;
  onRefinementCreated?: (task: any) => void;
  dismissPreferenceEnabled?: boolean;
} = {}) => {
  const modal = (
    <TaskDetailModal
      task={makeTask({ id: "FN-001", column: options.column ?? "done", status: options.column === "in-review" ? "review" as any : "done" as any })}
      initialTab="definition"
      onClose={options.onClose ?? noop}
      onRefinementCreated={options.onRefinementCreated}
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
  expect(screen.getByRole("heading", { level: 3, name: "Refine" })).toBeInTheDocument();
  expect(screen.getByPlaceholderText("Enter your feedback here...")).toBeInTheDocument();
};

const refineOverlay = () => {
  const overlay = screen.getByTestId("task-refine-dialog").closest("[data-dashboard-window-surface]");
  expect(overlay).toBeInstanceOf(HTMLElement);
  return overlay as HTMLElement;
};

const parentWindowOverlay = () => screen.getByTestId("floating-window-overlay-task-detail");

const layerOf = (element: HTMLElement) => Number.parseInt(element.style.zIndex, 10);

/*
FNXC:TaskDetailRefine 2026-07-12-00:00:
The refine dialog must stay open across desktop menu clicks, mobile pointer activation, and Android compatibility
mouse events; only explicit controls, Escape, or preference-enabled real backdrop presses may close it.

FNXC:TaskRefine 2026-09-14-22:23:
FN-400: the composer is now the shared standalone TaskRefineDialog. Task Detail keeps only its own header Actions
entry; the one-shot `initialAction` deep link that let a card or list row open this record purely to reach Refine was
deleted, so its case here is removed rather than rewritten. Escape now closes the composer, not the record behind it.
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

  /*
  FNXC:DialogStacking 2026-09-14-17:46:
  FN-392 symptom: Refine opened from a task window was painted UNDER that window, so the operator saw no composer. The
  dialog must be body-portaled and hold a strictly higher layer than its parent window, before and after real pointer
  and keyboard interaction inside the composer, on desktop and on the mobile/drawer presentation.
  */
  it.each([
    ["desktop", 1280],
    ["mobile", 420],
  ])("paints the refine dialog above its parent task window on %s and keeps it there after typing", (_name, width) => {
    const priorWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
    try {
      renderDoneTaskDetail({ column: "done" });
      openRefineFromActionsMenu();
      expectRefineComposerOpen();

      const overlay = refineOverlay();
      expect(overlay.parentElement).toBe(document.body);
      expect(overlay.getAttribute("data-ui-portal")).toBe("true");
      expect(layerOf(overlay)).toBeGreaterThan(layerOf(parentWindowOverlay()));

      const textarea = screen.getByPlaceholderText("Enter your feedback here...");
      fireEvent.pointerDown(textarea, { bubbles: true });
      fireEvent.focus(textarea, { bubbles: true });
      fireEvent.change(textarea, { target: { value: "more tests please" } });

      expect((textarea as HTMLTextAreaElement).value).toBe("more tests please");
      expectRefineComposerOpen();
      expect(layerOf(refineOverlay())).toBeGreaterThan(layerOf(parentWindowOverlay()));
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: priorWidth });
    }
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

  it("preserves explicit close, cancel, and Escape close paths on the composer itself", () => {
    const onClose = vi.fn();
    renderDoneTaskDetail({ onClose });
    openRefineFromActionsMenu();
    const dialog = screen.getByTestId("task-refine-dialog");

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByPlaceholderText("Enter your feedback here...")).not.toBeInTheDocument();

    openRefineFromActionsMenu();
    fireEvent.click(screen.getByTestId("task-refine-cancel"));
    expect(screen.queryByPlaceholderText("Enter your feedback here...")).not.toBeInTheDocument();

    expect(onClose).not.toHaveBeenCalled();

    /*
    FN-400: Escape now reaches the composer itself rather than only the record behind it. The host window keeps its own
    document-level Escape recovery path, exactly as it already does under TaskResetDialog, so both surfaces close.
    */
    openRefineFromActionsMenu();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByPlaceholderText("Enter your feedback here...")).not.toBeInTheDocument();
  });

  it("preserves refinement validation and submit behavior", async () => {
    const user = userEvent.setup();
    const addToast = vi.fn();
    const onRefinementCreated = vi.fn();
    const returnedChild = { id: "FN-002", column: "todo" };
    vi.mocked(refineTask).mockResolvedValue(returnedChild as any);
    renderDoneTaskDetail({ addToast, onRefinementCreated });
    openRefineFromActionsMenu();

    expect(screen.getByRole("button", { name: "Create Refinement Task" })).toBeDisabled();
    expect(refineTask).not.toHaveBeenCalled();

    const tooLongFeedback = "x".repeat(MAX_TASK_MESSAGE_LENGTH + 1);
    fireEvent.change(screen.getByPlaceholderText("Enter your feedback here..."), { target: { value: tooLongFeedback } });
    fireEvent.click(screen.getByRole("button", { name: "Create Refinement Task" }));
    expect(addToast).toHaveBeenCalledWith(`Feedback must be ${MAX_TASK_MESSAGE_LENGTH} characters or less`, "error");
    expect(refineTask).not.toHaveBeenCalled();

    const longFeedback = "x".repeat(5_000);
    fireEvent.change(screen.getByPlaceholderText("Enter your feedback here..."), { target: { value: longFeedback } });
    await user.click(screen.getByRole("button", { name: "Create Refinement Task" }));

    await waitFor(() => {
      expect(refineTask).toHaveBeenCalledWith("FN-001", longFeedback, undefined);
      expect(addToast).toHaveBeenCalledWith("Refinement task created: FN-002", "success");
      expect(onRefinementCreated).toHaveBeenCalledTimes(1);
      expect(onRefinementCreated).toHaveBeenCalledWith(returnedChild);
    });
    expect(screen.queryByPlaceholderText("Enter your feedback here...")).not.toBeInTheDocument();
  });
});
