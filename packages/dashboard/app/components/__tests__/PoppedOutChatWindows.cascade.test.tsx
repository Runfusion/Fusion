import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardWindowManagerProvider } from "../../context/DashboardWindowManagerContext";
import {
  FLOATING_WINDOW_CASCADE_STEP_PX,
  FLOATING_WINDOW_TASK_STANDARD_HEIGHT,
  FLOATING_WINDOW_TASK_STANDARD_WIDTH,
  FloatingWindow,
} from "../FloatingWindow";
import { expectedOpeningSize } from "./floatingWindowOpeningFixture";
import { PoppedOutChatWindows } from "../PoppedOutChatWindows";

/*
FNXC:ChatWindows 2026-09-14-23:38:
FN-394 removed Chat's private cascade slot and its durable geometry key, so this suite now asserts the
SHARED window contract on detached conversations: every chat window opens at the standard Chat size,
centred in the live work area, ignoring any previously stored geometry; a second still-pristine window
is only DISPLACED by one shared cascade step (never shrunk); and windows of other projects stay unrendered.

FNXC:ChatWindows 2026-09-15-04:01:
FN-401 adds the shared-size symptom assertion: a detached conversation must open at EXACTLY the task-window
standard geometry (it used to open at 980x680 beside an 800x680 task window). The constants are imported
rather than re-typed so a future size change cannot leave this suite asserting a stale literal.

FNXC:ChatWindows 2026-09-15-13:41:
FN-418 caps the standard OPENING height at a proportion of the live work area, so the expected height is
derived from that contract (`openingHeight()`) instead of the raw task-standard constant. The FN-401
invariant is unchanged and still asserted: chat and task windows open at the SAME rectangle.

FNXC:ChatWindows 2026-09-16-05:45:
FN-456 normalizes the opening shape to the shared 1.43 ratio, so the expected rectangle is derived from the
production seam through the shared opening fixture rather than from a local copy of the formula.

FNXC:ChatWindows 2026-09-16-07:38:
FN-460 opens every window 20% larger, so the opening WIDTH is no longer the task-standard constant either.
`chatWidth()` now reads the seam like `openingHeight()` already did. The load-bearing FN-401 invariant is
unchanged and still asserted directly: a detached conversation and a task window open at the SAME rectangle.
*/

vi.mock("../ChatView", () => ({
  ChatView: ({ initialDirectSession }: { initialDirectSession: { id: string } }) => <div>{initialDirectSession.id}</div>,
}));

/** Standard opening size. No landmarks here, so the work area is the whole viewport. */
function openingSize(
  requested = { width: FLOATING_WINDOW_TASK_STANDARD_WIDTH, height: FLOATING_WINDOW_TASK_STANDARD_HEIGHT },
) {
  return expectedOpeningSize(requested, {
    bounds: {
      left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight,
      width: window.innerWidth, height: window.innerHeight,
    },
  });
}

function openingHeight(): number {
  return openingSize().height;
}

function chatWidth(): number {
  return openingSize().width;
}

const entry = (id: string, projectId = "project-a") => ({
  projectId,
  session: {
    id,
    agentId: "agent-1",
    title: id,
    status: "active" as const,
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
  },
  focusNonce: 1,
});

function renderWindows(entries: ReturnType<typeof entry>[]) {
  return render(
    <DashboardWindowManagerProvider>
      <PoppedOutChatWindows
        entries={entries}
        projectId="project-a"
        addToast={vi.fn()}
        onClose={vi.fn()}
        onOpenSessionInNewWindow={vi.fn()}
      />
    </DashboardWindowManagerProvider>,
  );
}

function rectOf(panel: HTMLElement) {
  return {
    left: Number.parseFloat(panel.style.left),
    top: Number.parseFloat(panel.style.top),
    width: Number.parseFloat(panel.style.width),
    height: Number.parseFloat(panel.style.height),
  };
}

describe("PoppedOutChatWindows cascade", () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1600 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 1000 });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("opens stacked chat windows centered and displaces the second by one shared cascade step", async () => {
    renderWindows([entry("first"), entry("second")]);

    const first = screen.getByTestId("floating-window-chat-window-project-a-first");
    const second = screen.getByTestId("floating-window-chat-window-project-a-second");
    await waitFor(() => expect(Number.parseFloat(second.style.width)).toBe(chatWidth()));

    const chatHeight = openingHeight();
    expect(rectOf(first)).toEqual({
      left: (window.innerWidth - chatWidth()) / 2,
      top: (window.innerHeight - chatHeight) / 2,
      width: chatWidth(),
      height: chatHeight,
    });
    // The cascade only moves the second window: it keeps the full standard Chat size.
    expect(rectOf(second)).toEqual({
      left: (window.innerWidth - chatWidth()) / 2 + FLOATING_WINDOW_CASCADE_STEP_PX,
      top: (window.innerHeight - chatHeight) / 2 + FLOATING_WINDOW_CASCADE_STEP_PX,
      width: chatWidth(),
      height: chatHeight,
    });
  });

  it("ignores previously stored chat geometry and never persists a new one", async () => {
    localStorage.setItem("kb-dashboard-chat-floating-window", JSON.stringify({
      size: { width: 420, height: 300 }, position: { x: 12, y: 18 },
    }));
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    renderWindows([entry("first")]);

    const first = screen.getByTestId("floating-window-chat-window-project-a-first");
    await waitFor(() => expect(Number.parseFloat(first.style.width)).toBe(chatWidth()));
    expect(rectOf(first)).toEqual({
      left: (window.innerWidth - chatWidth()) / 2,
      top: (window.innerHeight - openingHeight()) / 2,
      width: chatWidth(),
      height: openingHeight(),
    });
    expect(setItem.mock.calls.some(([key]) => String(key).includes("chat-floating-window"))).toBe(false);
    setItem.mockRestore();
  });

  it("filters another project while keeping the surviving window centered", async () => {
    renderWindows([entry("visible"), entry("hidden", "project-b")]);

    expect(screen.queryByTestId("floating-window-chat-window-project-b-hidden")).toBeNull();
    const visible = screen.getByTestId("floating-window-chat-window-project-a-visible");
    await waitFor(() => expect(Number.parseFloat(visible.style.width)).toBe(chatWidth()));
    expect(rectOf(visible).left).toBe((window.innerWidth - chatWidth()) / 2);
  });

  /*
  FNXC:ChatWindows 2026-09-15-04:01:
  FN-401 symptom assertion (1): render a detached conversation and a task-shaped window in the SAME window
  manager and compare their opening rectangles. Before FN-401 the chat opened 180px wider than the task
  window; they must now be identical.
  */
  it("opens a detached conversation at exactly the task-window standard size", async () => {
    render(
      <DashboardWindowManagerProvider>
        <PoppedOutChatWindows
          entries={[entry("sized")]}
          projectId="project-a"
          addToast={vi.fn()}
          onClose={vi.fn()}
          onOpenSessionInNewWindow={vi.fn()}
        />
        <FloatingWindow
          windowKey="task-standard-probe"
          title="Task"
          onClose={vi.fn()}
          layer="task-detail"
          defaultSize={{ width: FLOATING_WINDOW_TASK_STANDARD_WIDTH, height: FLOATING_WINDOW_TASK_STANDARD_HEIGHT }}
          minSize={{ width: 480, height: 480 }}
        >
          <div />
        </FloatingWindow>
      </DashboardWindowManagerProvider>,
    );

    const chat = screen.getByTestId("floating-window-chat-window-project-a-sized");
    const task = screen.getByTestId("floating-window-task-standard-probe");
    await waitFor(() => expect(Number.parseFloat(chat.style.width)).toBe(chatWidth()));

    const chatRect = rectOf(chat);
    const taskRect = rectOf(task);
    expect(chatRect.width).toBe(taskRect.width);
    expect(chatRect.height).toBe(taskRect.height);
    // FN-460: the opening width is the scaled task-standard width, not the raw host constant.
    expect(chatRect.width).toBe(chatWidth());
    expect(chatRect.height).toBe(openingHeight());
  });
});
