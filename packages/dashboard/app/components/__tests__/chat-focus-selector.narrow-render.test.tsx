import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChatFocusSelector } from "../ChatFocusSelector";
import { loadAllAppCss } from "../../test/cssFixture";

vi.mock("../../api", () => ({
  updateChatSession: vi.fn(),
}));

import { updateChatSession } from "../../api";

/*
FNXC:ChatMemoryFocusSelector 2026-08-24-03:40:
The focus popover must use its full-width composer row as its containing block. These
rendered host chains prevent a chip-sized positioned wrapper from collapsing the mobile
popover into a vertical sliver.
*/

const appCss = loadAllAppCss();
const mockUpdateChatSession = vi.mocked(updateChatSession);
const focusStates = [null, "", "all", "*", "a deliberately long memory focus topic for the narrow two-button state"];

afterEach(() => {
  cleanup();
  document.head.querySelector("style[data-chat-focus-css]")?.remove();
});

beforeEach(() => {
  mockUpdateChatSession.mockReset();
});

function renderWithCss(ui: JSX.Element) {
  const style = document.createElement("style");
  style.dataset.chatFocusCss = "true";
  style.textContent = appCss;
  document.head.appendChild(style);
  return render(ui);
}

function nearestPositionedAncestor(element: HTMLElement): HTMLElement | null {
  let current = element.parentElement;
  while (current) {
    if (getComputedStyle(current).position !== "static") return current;
    current = current.parentElement;
  }
  return null;
}

function FocusSelector({ memoryFocus = null }: { memoryFocus?: string | null }) {
  return (
    <ChatFocusSelector
      sessionId="SES-1"
      memoryFocus={memoryFocus}
      onPersist={() => undefined}
      addToast={() => undefined}
    />
  );
}

function openPopover() {
  fireEvent.click(screen.getByTestId("chat-focus-chip"));
  return screen.getByTestId("chat-focus-popover");
}

function expectPopoverGeometry(anchorClass: string) {
  const popover = openPopover();
  const root = screen.getByTestId("chat-focus-root");
  const positionedAncestor = nearestPositionedAncestor(popover);
  const popoverStyle = getComputedStyle(popover);

  expect(positionedAncestor).toHaveClass(anchorClass);
  expect(positionedAncestor).not.toBe(root);
  expect(positionedAncestor).not.toHaveClass("task-planner-chat");
  expect(getComputedStyle(root).position).toBe("static");
  expect(popoverStyle.maxBlockSize || popoverStyle.maxHeight).not.toBe("");
  expect(popoverStyle.overflowY).toBe("auto");
}

function renderChatHost({ narrow, memoryFocus }: { narrow: boolean; memoryFocus: string | null }) {
  return renderWithCss(
    <div className={`chat-view${narrow ? " chat-view--narrow" : ""}`}>
      <div className="chat-thread">
        <div className="chat-input-area">
          <div className="chat-input-row"><FocusSelector memoryFocus={memoryFocus} /></div>
        </div>
      </div>
    </div>,
  );
}

function renderPlannerHost(memoryFocus: string | null) {
  return renderWithCss(
    <div className="task-planner-chat">
      <div className="task-planner-chat-focus-row"><FocusSelector memoryFocus={memoryFocus} /></div>
      <div className="task-planner-chat-composer" />
    </div>,
  );
}

describe("ChatFocusSelector narrow host geometry", () => {
  it.each([false, true])("anchors ChatView focus popovers to the composer area when narrow=%s", (narrow) => {
    renderChatHost({ narrow, memoryFocus: null });
    expectPopoverGeometry("chat-input-area");
  });

  it("anchors the planner focus popover to its composer row instead of the pane", () => {
    renderPlannerHost(null);
    expectPopoverGeometry("task-planner-chat-focus-row");
  });

  it.each(focusStates)("keeps the bounded ChatView popover usable for memoryFocus=%j", (memoryFocus) => {
    renderChatHost({ narrow: true, memoryFocus });
    expectPopoverGeometry("chat-input-area");

    if (memoryFocus && memoryFocus !== "all" && memoryFocus !== "*") {
      expect(screen.getByTestId("chat-focus-save")).toBeInTheDocument();
      expect(screen.getByTestId("chat-focus-clear")).toBeInTheDocument();
      expect(getComputedStyle(screen.getByTestId("chat-focus-save").parentElement as HTMLElement).flexWrap).toBe("wrap");
    } else {
      expect(screen.getByTestId("chat-focus-save")).toBeInTheDocument();
      expect(screen.queryByTestId("chat-focus-clear")).not.toBeInTheDocument();
    }
  });

  it("keeps the bounded planner popover usable for every focus state", () => {
    for (const memoryFocus of focusStates) {
      renderPlannerHost(memoryFocus);
      expectPopoverGeometry("task-planner-chat-focus-row");
      cleanup();
    }
  });

  it("dismisses the popover by keyboard and pointer without changing its host geometry", () => {
    renderChatHost({ narrow: true, memoryFocus: null });
    expectPopoverGeometry("chat-input-area");

    fireEvent.keyDown(screen.getByTestId("chat-focus-input"), { key: "Escape" });
    expect(screen.queryByTestId("chat-focus-popover")).not.toBeInTheDocument();

    openPopover();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId("chat-focus-popover")).not.toBeInTheDocument();
  });

  it("disables both actions while a focus update is saving", () => {
    mockUpdateChatSession.mockReturnValueOnce(new Promise(() => undefined));
    renderChatHost({ narrow: true, memoryFocus: "active topic" });
    openPopover();

    fireEvent.click(screen.getByTestId("chat-focus-save"));
    expect(screen.getByTestId("chat-focus-save")).toBeDisabled();
    expect(screen.getByTestId("chat-focus-clear")).toBeDisabled();
  });

  it("does not render a popover for a missing session", () => {
    renderWithCss(
      <div className="chat-input-area">
        <div className="chat-input-row">
          <ChatFocusSelector sessionId={null} memoryFocus={null} onPersist={() => undefined} addToast={() => undefined} />
        </div>
      </div>,
    );

    expect(screen.getByTestId("chat-focus-chip")).toBeDisabled();
    expect(screen.queryByTestId("chat-focus-popover")).not.toBeInTheDocument();
  });
});
