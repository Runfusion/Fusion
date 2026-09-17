import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_TASK_MESSAGE_LENGTH } from "@fusion/core";
import { readAppFile } from "../../test/cssFixture";
import { ModalDismissPreferenceProvider } from "../../hooks/useOverlayDismiss";
import { TaskRefineDialog } from "../TaskRefineDialog";
import { followUpTask, refineTask } from "../../api";

vi.mock("../../api", () => ({
  refineTask: vi.fn(),
  /* FNXC:TaskFollowUp 2026-09-17-18:10: FN-513 routes the same composer's follow-up mode to its own endpoint. */
  followUpTask: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function renderDialog(
  overrides: Partial<ComponentProps<typeof TaskRefineDialog>> = {},
  options: { dismissPreferenceEnabled?: boolean } = {},
) {
  const props = {
    taskId: "FN-400",
    projectId: undefined,
    addToast: vi.fn(),
    onClose: vi.fn(),
    onRefinementCreated: vi.fn(),
    ...overrides,
  } satisfies ComponentProps<typeof TaskRefineDialog>;
  const dialog = <TaskRefineDialog {...props} />;
  const view = render(
    options.dismissPreferenceEnabled === undefined
      ? dialog
      : <ModalDismissPreferenceProvider enabled={options.dismissPreferenceEnabled}>{dialog}</ModalDismissPreferenceProvider>,
  );
  return { ...view, props };
}

const overlay = () => {
  const element = screen.getByTestId("task-refine-dialog").closest("[data-dashboard-window-surface]");
  expect(element).toBeInstanceOf(HTMLElement);
  return element as HTMLElement;
};

/*
FNXC:TaskRefine 2026-09-14-22:23:
FN-400: Refine is now a standalone dialog owned by the card, the list row, and Task Detail. These cases pin the
behaviour that used to live inline in TaskDetailModal — validation, single submission, toasts, backdrop-dismiss
preference, Escape — plus the new centred, unpainted-overlay contract at both breakpoints.
*/
describe("TaskRefineDialog", () => {
  beforeEach(() => {
    vi.mocked(refineTask).mockReset();
    vi.mocked(refineTask).mockResolvedValue({ id: "FN-401", column: "todo" } as never);
  });

  it("disables submission for empty and whitespace-only feedback", async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();

    expect(screen.getByTestId("task-refine-submit")).toBeDisabled();
    await user.type(screen.getByTestId("task-refine-feedback"), "   ");
    expect(screen.getByTestId("task-refine-submit")).toBeDisabled();
    fireEvent.click(screen.getByTestId("task-refine-submit"));
    expect(refineTask).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("refuses feedback longer than the shared message limit", () => {
    const { props } = renderDialog();

    fireEvent.change(screen.getByTestId("task-refine-feedback"), {
      target: { value: "x".repeat(MAX_TASK_MESSAGE_LENGTH + 1) },
    });
    fireEvent.click(screen.getByTestId("task-refine-submit"));

    expect(props.addToast).toHaveBeenCalledWith(
      `Feedback must be ${MAX_TASK_MESSAGE_LENGTH} characters or less`,
      "error",
    );
    expect(refineTask).not.toHaveBeenCalled();
  });

  it("creates the refinement task, reports it, and closes", async () => {
    const user = userEvent.setup();
    const created = { id: "FN-401", column: "todo" };
    vi.mocked(refineTask).mockResolvedValue(created as never);
    const { props } = renderDialog({ projectId: "p1" });

    fireEvent.change(screen.getByTestId("task-refine-feedback"), { target: { value: "  add mobile coverage  " } });
    await user.click(screen.getByTestId("task-refine-submit"));

    await waitFor(() => expect(refineTask).toHaveBeenCalledWith("FN-400", "add mobile coverage", "p1"));
    expect(props.onRefinementCreated).toHaveBeenCalledWith(created);
    expect(props.addToast).toHaveBeenCalledWith("Refinement task created: FN-401", "success");
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("claims the first click synchronously so one frame cannot submit twice", async () => {
    const request = deferred<{ id: string }>();
    vi.mocked(refineTask).mockReturnValue(request.promise as never);
    const { props } = renderDialog();

    fireEvent.change(screen.getByTestId("task-refine-feedback"), { target: { value: "please refine" } });
    const submit = screen.getByTestId("task-refine-submit");
    fireEvent.click(submit);
    fireEvent.click(submit);

    expect(refineTask).toHaveBeenCalledOnce();
    expect(submit).toBeDisabled();
    expect(screen.getByTestId("task-refine-feedback")).toBeDisabled();
    expect(screen.getByTestId("task-refine-cancel")).toBeDisabled();

    request.resolve({ id: "FN-401" });
    await waitFor(() => expect(props.onClose).toHaveBeenCalledOnce());
  });

  it("keeps the dialog retryable after a failed submission", async () => {
    const user = userEvent.setup();
    vi.mocked(refineTask).mockRejectedValue(new Error("refine failed"));
    const { props } = renderDialog();

    fireEvent.change(screen.getByTestId("task-refine-feedback"), { target: { value: "please refine" } });
    await user.click(screen.getByTestId("task-refine-submit"));

    await waitFor(() => expect(props.addToast).toHaveBeenCalledWith("refine failed", "error"));
    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("task-refine-dialog")).toBeInTheDocument();

    await user.click(screen.getByTestId("task-refine-submit"));
    expect(refineTask).toHaveBeenCalledTimes(2);
  });

  it("closes through the explicit Close, Cancel, and Escape exits", () => {
    const first = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(first.props.onClose).toHaveBeenCalledOnce();
    first.unmount();

    const second = renderDialog();
    fireEvent.click(screen.getByTestId("task-refine-cancel"));
    expect(second.props.onClose).toHaveBeenCalledOnce();
    second.unmount();

    const third = renderDialog();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(third.props.onClose).toHaveBeenCalledOnce();
  });

  it("honours the default-off backdrop dismiss preference", () => {
    const disabled = renderDialog({}, { dismissPreferenceEnabled: false });
    const disabledOverlay = overlay();
    fireEvent.mouseDown(disabledOverlay);
    fireEvent.mouseUp(disabledOverlay);
    fireEvent.click(disabledOverlay);
    expect(disabled.props.onClose).not.toHaveBeenCalled();
    disabled.unmount();

    const enabled = renderDialog({}, { dismissPreferenceEnabled: true });
    const enabledOverlay = overlay();
    fireEvent.mouseDown(enabledOverlay);
    fireEvent.mouseUp(enabledOverlay);
    expect(enabled.props.onClose).toHaveBeenCalled();
  });

  it.each([
    ["desktop", 1280],
    ["mobile", 420],
  ])("body-portals the dialog on %s", (_name, width) => {
    const priorWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
    try {
      renderDialog();
      const element = overlay();
      expect(element.parentElement).toBe(document.body);
      expect(element.getAttribute("data-ui-portal")).toBe("true");
      expect(element.className).toContain("task-refine-overlay");
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: priorWidth });
    }
  });
});

/*
FNXC:TaskRefine 2026-09-14-22:23:
FN-400 symptom: the composer was offset below the viewport centre by the shared overlay top padding and sat behind a
painted veil. No browser automation exists in this repository, so the geometry contract is pinned as CSS text.
*/
describe.each([
  ["TaskRefineDialog", "components/TaskRefineDialog.css", "task-refine-overlay", "task-refine-dialog"],
  ["TaskResetDialog", "components/TaskResetDialog.css", "task-reset-overlay", "task-reset-dialog"],
])("%s viewport-centred unpainted overlay contract", (_name, path, overlayClass, dialogClass) => {
  const css = () => readAppFile(path);
  const overlayRule = () => {
    const match = css().match(new RegExp(`\\.modal-overlay\\.${overlayClass}\\s*\\{[^}]*\\}`));
    expect(match).toBeTruthy();
    return match![0];
  };

  it("centres the overlay exactly and cancels the shared top offset", () => {
    const rule = overlayRule();
    expect(rule).toContain("align-items: center;");
    expect(rule).toContain("justify-content: center;");
    expect(rule).toContain("padding-top: 0;");
    expect(rule).toContain("--overlay-padding-top: 0;");
  });

  it("paints nothing on the overlay layer", () => {
    const rule = overlayRule();
    expect(rule.match(/background:[^;]*;/g)).toEqual(["background: transparent;"]);
    expect(rule).toContain("backdrop-filter: none;");
    expect(rule).not.toContain("color-mix(");
  });

  it("keeps the centred contract at the mobile breakpoint", () => {
    const source = css();
    expect(source).toContain("@media (max-width: 768px)");
    const mobileBlock = source.slice(source.indexOf("@media (max-width: 768px)"));
    expect(mobileBlock).toContain(`.modal-overlay.${overlayClass}`);
    expect(mobileBlock).toContain("align-items: center;");
    expect(mobileBlock).toContain(`.modal.${dialogClass}`);
    expect(mobileBlock).toContain("env(safe-area-inset-bottom, 0px)");
  });

  it("stays token-only apart from the canonical breakpoint", () => {
    const source = css();
    expect(source).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(source).not.toContain("rgba(");
    expect(source.replace("768px", "").replace(/env\([^)]*\)/g, "")).not.toMatch(/(?<![\w-])(?:[1-9]\d*|0?\.\d+)px\b/);
  });
});

/*
FNXC:TaskFollowUp 2026-09-17-18:10:
FN-513 — the SAME composer in follow-up mode. What these cases protect is the separation: the mode
decides which endpoint is called and which words are shown, and nothing else about the dialog changes
— so the gestures, the anti-double-submit claim, the draft-on-error behavior, and the accessibility
contract proved above continue to apply unchanged.
*/
describe("TaskRefineDialog in follow-up mode", () => {
  beforeEach(() => {
    vi.mocked(refineTask).mockReset();
    vi.mocked(followUpTask).mockReset();
    vi.mocked(followUpTask).mockResolvedValue({ id: "FN-900", column: "todo" } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const renderFollowUp = (overrides: Partial<ComponentProps<typeof TaskRefineDialog>> = {}) =>
    renderDialog({ mode: "follow-up", ...overrides });

  it("names the successor relationship instead of reusing refinement wording", () => {
    renderFollowUp();
    expect(screen.getByRole("heading", { level: 3, name: "Follow-up" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Describe the follow-up work here...")).toBeInTheDocument();
    expect(screen.getByTestId("task-refine-submit")).toHaveTextContent("Create Follow-up Task");
    // The help text states the three facts the operator needs: separate, linked, planned from the source.
    const help = document.querySelector(".task-refine-dialog__help")!.textContent ?? "";
    expect(help).toContain("separate task");
    expect(help).toContain("linked");
    expect(help).toContain("plan");
    expect(screen.queryByPlaceholderText("Enter your feedback here...")).not.toBeInTheDocument();
  });

  it("posts to the follow-up endpoint with the trimmed request and the project scope", async () => {
    const user = userEvent.setup();
    const { props } = renderFollowUp({ projectId: "project-b" });

    await user.type(screen.getByPlaceholderText("Describe the follow-up work here..."), "  add a CSV export  ");
    await user.click(screen.getByTestId("task-refine-submit"));

    await waitFor(() => expect(followUpTask).toHaveBeenCalledWith("FN-400", "add a CSV export", "project-b"));
    expect(refineTask).not.toHaveBeenCalled();
    expect(props.onRefinementCreated).toHaveBeenCalledWith({ id: "FN-900", column: "todo" });
    expect(props.onClose).toHaveBeenCalled();
  });

  it("claims the first click synchronously so a deferred success cannot create two children", async () => {
    const gate = deferred<{ id: string; column: string }>();
    vi.mocked(followUpTask).mockReturnValue(gate.promise as never);
    renderFollowUp();

    fireEvent.change(screen.getByPlaceholderText("Describe the follow-up work here..."), { target: { value: "one request" } });
    const submit = screen.getByTestId("task-refine-submit");
    fireEvent.click(submit);
    fireEvent.click(submit);
    fireEvent.click(submit);

    expect(followUpTask).toHaveBeenCalledTimes(1);
    gate.resolve({ id: "FN-900", column: "todo" });
    await waitFor(() => expect(followUpTask).toHaveBeenCalledTimes(1));
  });

  it("keeps the draft and the mode after a 409, and never retries on its own", async () => {
    vi.mocked(followUpTask).mockRejectedValueOnce(new Error("Cannot create a follow-up of FN-400: source-terminal"));
    const { props } = renderFollowUp();

    fireEvent.change(screen.getByPlaceholderText("Describe the follow-up work here..."), { target: { value: "worth keeping" } });
    fireEvent.click(screen.getByTestId("task-refine-submit"));

    await waitFor(() => expect(props.addToast).toHaveBeenCalledWith(expect.stringContaining("source-terminal"), "error"));
    expect(props.onClose).not.toHaveBeenCalled();
    expect(props.onRefinementCreated).not.toHaveBeenCalled();
    expect((screen.getByPlaceholderText("Describe the follow-up work here...") as HTMLTextAreaElement).value).toBe("worth keeping");
    expect(screen.getByRole("heading", { level: 3, name: "Follow-up" })).toBeInTheDocument();
    expect(followUpTask).toHaveBeenCalledTimes(1);
  });

  it("refuses blank and over-long requests through the same bounds as Refine", async () => {
    const { props } = renderFollowUp();
    const textarea = screen.getByPlaceholderText("Describe the follow-up work here...") as HTMLTextAreaElement;

    expect(screen.getByTestId("task-refine-submit")).toBeDisabled();
    fireEvent.change(textarea, { target: { value: "   " } });
    expect(screen.getByTestId("task-refine-submit")).toBeDisabled();
    expect(textarea.maxLength).toBe(MAX_TASK_MESSAGE_LENGTH);
    expect(followUpTask).not.toHaveBeenCalled();
    expect(props.onRefinementCreated).not.toHaveBeenCalled();
  });

  it("keeps the same textarea node across an unrelated re-render so typing is never interrupted", async () => {
    const user = userEvent.setup();
    const { rerender } = renderDialog({ mode: "follow-up" });
    const textarea = screen.getByPlaceholderText("Describe the follow-up work here...");

    await user.type(textarea, "abc");
    rerender(
      <TaskRefineDialog
        taskId="FN-400"
        mode="follow-up"
        addToast={vi.fn()}
        onClose={vi.fn()}
        onRefinementCreated={vi.fn()}
      />,
    );
    await user.type(screen.getByPlaceholderText("Describe the follow-up work here..."), "def");

    expect(screen.getByPlaceholderText("Describe the follow-up work here...")).toBe(textarea);
    expect((textarea as HTMLTextAreaElement).value).toBe("abcdef");
  });

  it("leaves the default mode on the historical Refine endpoint", async () => {
    vi.mocked(refineTask).mockResolvedValue({ id: "FN-401", column: "todo" } as never);
    renderDialog();

    fireEvent.change(screen.getByPlaceholderText("Enter your feedback here..."), { target: { value: "ordinary refinement" } });
    fireEvent.click(screen.getByTestId("task-refine-submit"));

    await waitFor(() => expect(refineTask).toHaveBeenCalledWith("FN-400", "ordinary refinement", undefined));
    expect(followUpTask).not.toHaveBeenCalled();
  });
});
