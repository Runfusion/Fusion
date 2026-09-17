import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatView } from "../ChatView";
import { MobileDrawer } from "../MobileDrawer";
import { loadAllAppCss } from "../../test/cssFixture";
import * as useChatModule from "../../hooks/useChat";
import * as useChatRoomsModule from "../../hooks/useChatRooms";
import {
  activeSessionFixture,
  defaultChatState,
  defaultRoomsState,
  installChatViewEnv,
  mockViewportMode,
  mockVisualViewport,
  setLayoutViewportHeight,
  setVisualViewportHeight,
  setVisualViewportOffsetTop,
  setupMockChat,
  setupMockRooms,
  simulateKeyboardOpen,
  stubMeasuredRect,
} from "./ChatView.test-harness";

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useNavigationHistory")>()),
  useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
}));
vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchModels: vi.fn().mockResolvedValue({ models: [] }),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
}));

const css = loadAllAppCss();
installChatViewEnv();
void vi.mocked(useChatModule.useChat);
void vi.mocked(useChatRoomsModule.useChatRooms);

afterEach(() => {
  cleanup();
  document.head.innerHTML = "";
});

/*
FNXC:MobileKeyboardViewport 2026-09-17-14:23:
FN-512 symptom verification for the surface the operator named: the Chat.

Both reported failures are asserted as opposite errors of one measurement:
  - "je vois le clavier par dessus l'input": the field must stay above the visible bottom edge;
  - "un gros espace entre mon clavier et l'input": no band beyond the composer's ordinary spacing.

The decisive case is the nested one: Chat hosted in an already-adapted drawer must publish NO bound
of its own. Two owners adjusting the same rectangle is what made the outcome depend on event order.

jsdom performs no layout, so rectangles are supplied explicitly: this proves the published decision
and the retained draft/focus, not a rendered Safari layout.
*/

async function renderChat(props: Partial<React.ComponentProps<typeof ChatView>> = {}, wrap?: (node: React.ReactNode) => React.ReactNode) {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  setupMockChat({ ...defaultChatState, sessions: [activeSessionFixture], filteredSessions: [activeSessionFixture], activeSession: undefined });
  setupMockRooms(defaultRoomsState);
  const node = <ChatView projectId="proj-123" addToast={vi.fn()} {...props} />;
  const view = render(<>{wrap ? wrap(node) : node}</>);
  await act(async () => { screen.getByTestId(`chat-session-${activeSessionFixture.id}`).click(); });
  setupMockChat({ ...defaultChatState, sessions: [activeSessionFixture], filteredSessions: [activeSessionFixture], activeSession: activeSessionFixture });
  const next = <ChatView projectId="proj-123" addToast={vi.fn()} {...props} />;
  view.rerender(<>{wrap ? wrap(next) : next}</>);
  return screen.getByTestId("chat-input") as HTMLTextAreaElement;
}

function getThread() {
  return screen.getByTestId("chat-input").closest(".chat-thread") as HTMLElement;
}

function readBound() {
  return getThread().style.getPropertyValue("--chat-thread-visible-block-size");
}

describe("Chat keyboard geometry — standalone host", () => {
  it("scenario A: the field stays inside the visible bound when only the visual viewport shrinks", async () => {
    const viewport = mockVisualViewport({ width: 390, height: 844 });
    const mode = mockViewportMode("mobile");
    try {
      const input = await renderChat();
      stubMeasuredRect(getThread(), { top: 0, height: 844 });
      await act(async () => simulateKeyboardOpen({ input, vv: viewport.vv, visualHeight: 500 }));

      expect(readBound()).toBe("500px");
      // Exactly the occluded band is removed, no more: a composer that also reserved a keyboard
      // height would produce a bound far below 500 and the visible empty band.
      expect(Number.parseFloat(readBound())).toBe(viewport.vv.height);
    } finally { mode.mockRestore(); viewport.restore(); }
  });

  it("scenario A with drift: a positive offsetTop moves the bound rather than adding an offset", async () => {
    const viewport = mockVisualViewport({ width: 390, height: 844 });
    const mode = mockViewportMode("mobile");
    try {
      const input = await renderChat();
      stubMeasuredRect(getThread(), { top: 0, height: 844 });
      await act(async () => simulateKeyboardOpen({ input, vv: viewport.vv, visualHeight: 500 }));
      await act(async () => setVisualViewportOffsetTop(viewport.vv, 40));

      expect(readBound()).toBe("540px");
      expect(getThread().style.transform).toBe("");
    } finally { mode.mockRestore(); viewport.restore(); }
  });

  it("scenario B: nothing is reserved once the layout viewport already shrank", async () => {
    const viewport = mockVisualViewport({ width: 390, height: 844 });
    const mode = mockViewportMode("mobile");
    try {
      const input = await renderChat();
      stubMeasuredRect(getThread(), { top: 0, height: 500 });
      await act(async () => {
        input.focus();
        input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
        setLayoutViewportHeight(viewport.vv, 500);
      });

      expect(readBound()).toBe("");
      expect(getThread()).not.toHaveClass("chat-thread--keyboard-active");
    } finally { mode.mockRestore(); viewport.restore(); }
  });

  it("scenario C: a rapid close then refocus converges on the open bound with no stale write", async () => {
    const viewport = mockVisualViewport({ width: 390, height: 844 });
    const mode = mockViewportMode("mobile");
    try {
      const input = await renderChat();
      stubMeasuredRect(getThread(), { top: 0, height: 844 });
      await act(async () => simulateKeyboardOpen({ input, vv: viewport.vv, visualHeight: 500 }));

      await act(async () => input.blur());
      await act(async () => simulateKeyboardOpen({ input, vv: viewport.vv, visualHeight: 500 }));

      expect(readBound()).toBe("500px");
      expect(getThread()).toHaveClass("chat-thread--keyboard-active");
    } finally { mode.mockRestore(); viewport.restore(); }
  });

  it("ignores the transitional impossible sample and keeps the last coherent bound", async () => {
    const viewport = mockVisualViewport({ width: 390, height: 844 });
    const mode = mockViewportMode("mobile");
    try {
      const input = await renderChat();
      stubMeasuredRect(getThread(), { top: 0, height: 844 });
      await act(async () => simulateKeyboardOpen({ input, vv: viewport.vv, visualHeight: 500 }));

      await act(async () => {
        setLayoutViewportHeight(viewport.vv, 500);
        setVisualViewportHeight(viewport.vv, 844);
        setVisualViewportOffsetTop(viewport.vv, 40);
      });

      expect(Number.parseFloat(readBound() || "0")).toBeGreaterThan(0);
    } finally { mode.mockRestore(); viewport.restore(); }
  });
});

describe("Chat keyboard geometry — hosted in an adapted owner", () => {
  const inDrawer = (node: React.ReactNode) => (
    <MobileDrawer open title="Chat" onClose={() => {}} contentOwnsHeader contentOwnsScroll>
      {node}
    </MobileDrawer>
  );

  it("publishes NO bound of its own while the drawer already bounded the visible area", async () => {
    const viewport = mockVisualViewport({ width: 390, height: 844 });
    const mode = mockViewportMode("mobile");
    try {
      const input = await renderChat({}, inDrawer);
      const panel = screen.getByRole("dialog", { name: "Chat" });
      const overlay = panel.parentElement as HTMLElement;
      stubMeasuredRect(panel, { top: 0, height: 844 });
      stubMeasuredRect(overlay, { top: 0, height: 844 });
      stubMeasuredRect(getThread(), { top: 0, height: 844 });

      await act(async () => simulateKeyboardOpen({ input, vv: viewport.vv, visualHeight: 500 }));

      // The drawer overlay is pulled up by the residual inset — the single adaptation for this
      // subtree — and Chat inside it publishes nothing of its own.
      expect(overlay.style.getPropertyValue("--mobile-drawer-keyboard-inset")).toBe("344px");
      expect(readBound()).toBe("");
      expect(getThread()).not.toHaveClass("chat-thread--keyboard-active");
    } finally { mode.mockRestore(); viewport.restore(); }
  });

  it("keeps the composer, its draft, and Send reachable inside the single bounded owner", async () => {
    const viewport = mockVisualViewport({ width: 390, height: 844 });
    const mode = mockViewportMode("mobile");
    try {
      const input = await renderChat({}, inDrawer);
      const panel = screen.getByRole("dialog", { name: "Chat" });
      stubMeasuredRect(panel, { top: 0, height: 844 });
      stubMeasuredRect(panel.parentElement as HTMLElement, { top: 0, height: 844 });

      await userEvent.type(input, "bonjour");
      await act(async () => simulateKeyboardOpen({ input, vv: viewport.vv, visualHeight: 500 }));

      expect(panel.contains(input)).toBe(true);
      expect(input).toHaveValue("bonjour");
      expect(document.activeElement).toBe(input);
    } finally { mode.mockRestore(); viewport.restore(); }
  });

  it("restores the exact resting geometry for both owner and content when the keyboard closes", async () => {
    const viewport = mockVisualViewport({ width: 390, height: 844 });
    const mode = mockViewportMode("mobile");
    try {
      const input = await renderChat({}, inDrawer);
      const panel = screen.getByRole("dialog", { name: "Chat" });
      const overlay = panel.parentElement as HTMLElement;
      stubMeasuredRect(panel, { top: 0, height: 844 });
      stubMeasuredRect(overlay, { top: 0, height: 844 });
      stubMeasuredRect(getThread(), { top: 0, height: 844 });

      await act(async () => simulateKeyboardOpen({ input, vv: viewport.vv, visualHeight: 500 }));
      await act(async () => input.blur());
      await act(async () => setVisualViewportHeight(viewport.vv, 844));

      expect(overlay.style.getPropertyValue("--mobile-drawer-keyboard-inset")).toBe("");
      expect(readBound()).toBe("");
      expect(overlay).not.toHaveClass("mobile-drawer--keyboard-bounded");
    } finally { mode.mockRestore(); viewport.restore(); }
  });
});

/*
FNXC:MobileKeyboardViewport 2026-09-17-15:32:
FN-512 remediation: `keyboardOpen` is derived from `document.activeElement`, so a Chat that is merely
RETAINED (keep-alive route, hidden window) used to pin the document and cancel every touchmove outside
its own message list as soon as the operator focused a field in a VISIBLE form. Those two
document-global effects are bounded to the surface that is actually active.
*/
describe("a retained but inactive Chat does not seize document-global keyboard effects", () => {
  function dispatchTouchMoveOnBody() {
    const event = new Event("touchmove", { bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    return event.defaultPrevented;
  }

  it("leaves touch scrolling and body overflow alone while a visible form owns the focus", async () => {
    const viewport = mockVisualViewport({ width: 390, height: 844 });
    const mode = mockViewportMode("mobile");
    const priorOverflow = document.body.style.overflow;
    try {
      await renderChat({ active: false });
      const visibleField = document.createElement("textarea");
      document.body.append(visibleField);

      await act(async () => simulateKeyboardOpen({ input: visibleField, vv: viewport.vv, visualHeight: 500 }));

      expect(dispatchTouchMoveOnBody()).toBe(false);
      expect(document.body.style.overflow).toBe(priorOverflow);
      visibleField.remove();
    } finally { mode.mockRestore(); viewport.restore(); }
  });

  it("still guards viewport panning for the active Chat surface", async () => {
    const viewport = mockVisualViewport({ width: 390, height: 844 });
    const mode = mockViewportMode("mobile");
    try {
      const input = await renderChat();
      await act(async () => simulateKeyboardOpen({ input, vv: viewport.vv, visualHeight: 500 }));

      expect(dispatchTouchMoveOnBody()).toBe(true);
    } finally { mode.mockRestore(); viewport.restore(); }
  });
});

describe("Chat keyboard CSS contract", () => {
  it("consumes the measured bound and falls back to filling its parent", () => {
    const rule = css.match(/\.chat-thread--keyboard-active\s*\{([^}]*)\}/m)?.[1] ?? "";
    expect(rule).toContain("height: var(--chat-thread-visible-block-size, 100%)");
    expect(rule).toContain("max-height: var(--chat-thread-visible-block-size, 100%)");
    expect(rule).not.toMatch(/transform|will-change/);
  });

  it("no longer derives Chat geometry from a keyboard height or a measured thread top", () => {
    const rule = css.match(/\.chat-thread--keyboard-active\s*\{([^}]*)\}/m)?.[1] ?? "";
    expect(rule).not.toContain("--keyboard-overlap");
    expect(rule).not.toContain("--vv-height");
    expect(rule).not.toContain("--chat-thread-viewport-top");
  });
});
