import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatView } from "../ChatView";
import { loadAllAppCss } from "../../test/cssFixture";
import * as useChatModule from "../../hooks/useChat";
import * as useChatRoomsModule from "../../hooks/useChatRooms";
import {
  activeSessionFixture,
  defaultChatState,
  defaultRoomsState,
  installChatViewEnv,
  mockDesktopNonTouchViewport,
  mockPhoneLandscapeViewport,
  mockTabletClassTouchViewport,
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
const mockUseChat = vi.mocked(useChatModule.useChat);
const mockUseChatRooms = vi.mocked(useChatRoomsModule.useChatRooms);
installChatViewEnv();

afterEach(() => {
  cleanup();
  document.head.innerHTML = "";
});

async function renderChat(props: Partial<React.ComponentProps<typeof ChatView>> = {}) {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  // Start without a selected session so selecting this row changes activeSession, matching the
  // production transition that re-runs the viewport writer after the thread ref has mounted.
  setupMockChat({ ...defaultChatState, sessions: [activeSessionFixture], filteredSessions: [activeSessionFixture], activeSession: undefined });
  setupMockRooms(defaultRoomsState);
  const view = render(<ChatView projectId="proj-123" addToast={vi.fn()} {...props} />);
  await act(async () => { screen.getByTestId(`chat-session-${activeSessionFixture.id}`).click(); });
  setupMockChat({ ...defaultChatState, sessions: [activeSessionFixture], filteredSessions: [activeSessionFixture], activeSession: activeSessionFixture });
  view.rerender(<ChatView projectId="proj-123" addToast={vi.fn()} {...props} />);
  return screen.getByTestId("chat-input") as HTMLTextAreaElement;
}

function getThread() {
  return screen.getByTestId("chat-input").closest(".chat-thread") as HTMLElement;
}

/** Give the thread the rectangle a browser would lay out, then open the keyboard. */
async function openKeyboard(
  input: HTMLTextAreaElement,
  vv: VisualViewport,
  height: number,
  rect: { top: number; height: number } = { top: 0, height: window.innerHeight },
) {
  stubMeasuredRect(getThread(), rect);
  await act(async () => simulateKeyboardOpen({ input, vv, visualHeight: height }));
}

function readBound() {
  return getThread().style.getPropertyValue("--chat-thread-visible-block-size");
}

function observeKeyboardScroll() {
  const messages = document.querySelector(".chat-messages") as HTMLElement;
  let scrollTop = 0;
  Object.defineProperties(messages, {
    scrollHeight: { value: 1000, configurable: true },
    clientHeight: { value: 300, configurable: true },
    scrollTop: {
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value; },
      configurable: true,
    },
  });
  return () => scrollTop;
}

/*
FNXC:MobileKeyboardViewport 2026-09-17-14:23:
jsdom has no TouchEvent constructor, and a bare `Event("touchmove")` has no `touches` list at all.
The sticky-bottom follow handler reads `event.touches[0]`, so an untyped event threw an unhandled
TypeError out of the listener — the assertion still passed while the suite reported an error. Give
the event a real touch list so the production handler runs the branch the test claims to exercise.
*/
function createTouchMove(clientY: number): Event {
  const event = new Event("touchmove", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", {
    value: [{ clientY, clientX: 0 }],
    configurable: true,
  });
  return event;
}

function isInsideNarrowMediaRule(source: string, ruleIndex: number) {
  const mediaIndex = source.lastIndexOf("@media (max-width: 768px)", ruleIndex);
  if (mediaIndex < 0) return false;
  const openIndex = source.indexOf("{", mediaIndex);
  let depth = 0;
  for (let index = openIndex; index < ruleIndex; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
  }
  return depth > 0;
}

/*
FNXC:MobileKeyboardViewport 2026-09-17-14:23:
FN-512 rewrote the assertions in this file because the mechanism they described was deleted, not
because they were failing. The old contract was `--vv-height` minus a measured thread top, plus a
`translateY(offsetTop)` on `.chat-thread`, plus a constant iOS accessory margin. Those were three
simultaneous adjustments to one rectangle, and the reported defect was their race.

The observable contract is now a single published bound: the thread's own usable height measured
against the visible bottom edge, or nothing at all when an ancestor already bounded it.
*/
describe("FN-9195 Chat composer visual viewport", () => {
  it("preserves the layout-versus-visual viewport helper contract", () => {
    const { vv, restore } = mockVisualViewport({ width: 375, height: 812 });
    try {
      setVisualViewportHeight(vv, 400);
      expect(window.innerHeight).toBe(812);
      expect(document.documentElement.clientHeight).toBe(812);
      expect(vv.height).toBe(400);
      expect(window.innerHeight - vv.offsetTop - vv.height).toBe(412);
      setLayoutViewportHeight(vv, 600);
      expect(window.innerHeight).toBe(600);
      expect(document.documentElement.clientHeight).toBe(600);
      expect(vv.height).toBe(600);
      expect(window.innerHeight - vv.offsetTop - vv.height).toBe(0);
    } finally { restore(); }
  });

  it("bounds the portrait phone thread to the visible area so the composer is not under the keyboard", async () => {
    const viewport = mockVisualViewport({ width: 375, height: 812 });
    const mode = mockViewportMode("mobile");
    try {
      const input = await renderChat();
      expect(window.visualViewport).toBe(viewport.vv);
      await openKeyboard(input, viewport.vv, 400, { top: 0, height: 812 });
      expect(getThread()).toHaveClass("chat-thread--keyboard-active");
      expect(readBound()).toBe("400px");
      expect(getThread().contains(input)).toBe(true);
    } finally { mode.mockRestore(); viewport.restore(); }
  });

  it("subtracts only the part of the thread below the visible bound, not the whole keyboard", async () => {
    const viewport = mockVisualViewport({ width: 375, height: 812 });
    const mode = mockViewportMode("mobile");
    try {
      const input = await renderChat();
      // The thread starts under a 60px host header, as it does in the app shell.
      await openKeyboard(input, viewport.vv, 400, { top: 60, height: 752 });
      expect(readBound()).toBe("340px");
    } finally { mode.mockRestore(); viewport.restore(); }
  });

  it("adds no constant accessory band above the composer", async () => {
    const viewport = mockVisualViewport({ width: 375, height: 812 });
    const mode = mockViewportMode("mobile");
    try {
      const input = await renderChat();
      await openKeyboard(input, viewport.vv, 400, { top: 0, height: 812 });

      expect(getThread()).toHaveClass("chat-thread--keyboard-active");
      const inputRule = css.match(/\.chat-thread--keyboard-active \.chat-input-area\s*\{([^}]*)\}/m);
      expect(inputRule?.[1]).toContain("padding-bottom: var(--space-md)");
      // The removed compensations must not come back under any name.
      expect(inputRule?.[1]).not.toContain("accessory-clearance");
      expect(inputRule?.[1]).not.toContain("env(safe-area-inset-bottom");
      // No stylesheet consumes the removed custom property any more, and nothing writes it.
      expect(css).not.toMatch(/var\(\s*--chat-keyboard-accessory-clearance/);
      expect(getThread().style.getPropertyValue("--chat-keyboard-accessory-clearance")).toBe("");
    } finally { mode.mockRestore(); viewport.restore(); }
  });

  it("reserves NOTHING once the browser already resized the layout viewport", async () => {
    const viewport = mockVisualViewport({ width: 375, height: 812 });
    const mode = mockViewportMode("mobile");
    try {
      const input = await renderChat();
      // Android resizes-content: the thread follows the reduced layout, so nothing is occluded.
      stubMeasuredRect(getThread(), { top: 0, height: 400 });
      await act(async () => {
        input.focus();
        input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
        setLayoutViewportHeight(viewport.vv, 400);
      });

      expect(readBound()).toBe("");
      expect(getThread()).not.toHaveClass("chat-thread--keyboard-active");
    } finally { mode.mockRestore(); viewport.restore(); }
  });

  it("applies the keyboard clamp to a landscape phone outside the narrow media query", async () => {
    const restoreHost = mockPhoneLandscapeViewport();
    const viewport = mockVisualViewport({ width: 932, height: 430 });
    try {
      const input = await renderChat();
      await openKeyboard(input, viewport.vv, 200, { top: 0, height: 430 });
      expect(getThread()).toHaveClass("chat-thread--keyboard-active");
      expect(readBound()).toBe("200px");
      const ruleIndex = css.indexOf(".chat-thread--keyboard-active {");
      expect(ruleIndex).toBeGreaterThan(-1);
      expect(isInsideNarrowMediaRule(css, ruleIndex)).toBe(false);
    } finally { viewport.restore(); restoreHost(); }
  });

  it.each([
    ["tablet viewport mode", () => mockViewportMode("tablet"), 900, 1180, 700],
    ["tablet-class touch viewport", mockTabletClassTouchViewport, 768, 1024, 600],
  ])("tracks the keyboard on %s", async (_name, setup, width, layoutHeight, visualHeight) => {
    const restoreHost = setup();
    const viewport = mockVisualViewport({ width, height: layoutHeight });
    try {
      const input = await renderChat();
      await openKeyboard(input, viewport.vv, visualHeight, { top: 0, height: layoutHeight });
      expect(getThread()).toHaveClass("chat-thread--keyboard-active");
      expect(readBound()).toBe(`${visualHeight}px`);
    } finally { viewport.restore(); restoreHost(); }
  });

  it.each([
    ["compact dock", { compactLayout: true }],
    ["narrow floating Chat", { floating: true }],
  ])("tracks the keyboard in %s", async (_name, props) => {
    const restoreHost = mockDesktopNonTouchViewport();
    const viewport = mockVisualViewport({ width: 1280, height: 900 });
    try {
      const input = await renderChat(props);
      await openKeyboard(input, viewport.vv, 500, { top: 0, height: 900 });
      expect(getThread()).toHaveClass("chat-thread--keyboard-active");
      expect(readBound()).toBe("500px");
      if (props.floating) expect(document.querySelector(".chat-view")).toHaveClass("chat-view--narrow");
    } finally { viewport.restore(); restoreHost(); }
  });

  it("never grows a small dock host up to the viewport", async () => {
    const restoreHost = mockDesktopNonTouchViewport();
    const viewport = mockVisualViewport({ width: 1280, height: 900 });
    try {
      const input = await renderChat({ compactLayout: true });
      await openKeyboard(input, viewport.vv, 500, { top: 100, height: 300 });
      expect(readBound()).toBe("");
      expect(getThread()).not.toHaveClass("chat-thread--keyboard-active");
    } finally { viewport.restore(); restoreHost(); }
  });

  it("does not fabricate keyboard layout state on desktop", async () => {
    const restoreHost = mockDesktopNonTouchViewport();
    const viewport = mockVisualViewport({ width: 1280, height: 900 });
    try {
      const input = await renderChat();
      await openKeyboard(input, viewport.vv, 500, { top: 0, height: 900 });
      expect(getThread()).not.toHaveClass("chat-thread--keyboard-active");
      expect(readBound()).toBe("");
      expect(getThread().style.transform).toBe("");
    } finally { viewport.restore(); restoreHost(); }
  });

  it("makes the landscape keyboard state reachable without pinning the body", async () => {
    const restoreHost = mockPhoneLandscapeViewport();
    const viewport = mockVisualViewport({ width: 932, height: 430 });
    try {
      const input = await renderChat();
      await openKeyboard(input, viewport.vv, 200, { top: 0, height: 430 });
      await act(async () => undefined);
      const outsideMove = createTouchMove(10);
      document.body.dispatchEvent(outsideMove);
      expect(outsideMove.defaultPrevented).toBe(true);
      const messages = document.querySelector(".chat-messages") as HTMLElement;
      const messagesMove = createTouchMove(10);
      messages.dispatchEvent(messagesMove);
      expect(messagesMove.defaultPrevented).toBe(false);
      expect(document.body.style.position).not.toBe("fixed");
    } finally { viewport.restore(); restoreHost(); }
  });

  it("anchors messages after the keyboard opens on landscape, compact dock, and floating hosts", async () => {
    for (const [name, setupHost, props, width, layoutHeight, visualHeight] of [
      ["landscape", mockPhoneLandscapeViewport, {}, 932, 430, 200],
      ["compact dock", mockDesktopNonTouchViewport, { compactLayout: true }, 1280, 900, 500],
      ["narrow floating", mockDesktopNonTouchViewport, { floating: true }, 1280, 900, 500],
    ] as const) {
      const restoreHost = setupHost();
      const viewport = mockVisualViewport({ width, height: layoutHeight });
      try {
        const input = await renderChat(props);
        const readScrollTop = observeKeyboardScroll();
        await openKeyboard(input, viewport.vv, visualHeight, { top: 0, height: layoutHeight });
        expect(readScrollTop(), name).toBe(1000);
      } finally { cleanup(); viewport.restore(); restoreHost(); }
    }
  });

  it("does not fabricate keyboard state for an unshrunk compact host", async () => {
    const restoreHost = mockDesktopNonTouchViewport();
    const viewport = mockVisualViewport({ width: 1280, height: 900 });
    try {
      const input = await renderChat({ compactLayout: true });
      stubMeasuredRect(getThread(), { top: 0, height: 900 });
      await act(async () => input.focus());
      const move = createTouchMove(10);
      document.body.dispatchEvent(move);
      expect(getThread()).not.toHaveClass("chat-thread--keyboard-active");
      expect(move.defaultPrevented).toBe(false);
    } finally { viewport.restore(); restoreHost(); }
  });

  it("never transforms the thread, so it cannot establish a containing block over the composer", async () => {
    const viewport = mockVisualViewport({ width: 375, height: 812 });
    const mode = mockViewportMode("mobile");
    try {
      const input = await renderChat();
      await openKeyboard(input, viewport.vv, 400, { top: 0, height: 812 });
      expect(getThread().style.transform).toBe("");
      await act(async () => setVisualViewportOffsetTop(viewport.vv, 40));
      // A positive offsetTop moves the visible BOUND; it never becomes a translate on an ancestor
      // of the focused composer. WebKit collapses the keyboard when that containing block appears.
      expect(getThread().style.transform).toBe("");
      expect(getThread().style.willChange).toBe("");
      expect(readBound()).toBe("440px");
      expect(css.slice(css.indexOf(".chat-thread--keyboard-active {"), css.indexOf(".chat-thread-header"))).not.toMatch(/\n\s*(transform|will-change)\s*:/);
    } finally { mode.mockRestore(); viewport.restore(); }
  });

  it("does not activate keyboard consumers for pinch zoom", async () => {
    const restoreHost = mockPhoneLandscapeViewport();
    const viewport = mockVisualViewport({ width: 932, height: 430 });
    try {
      const input = await renderChat();
      observeKeyboardScroll();
      Object.defineProperty(viewport.vv, "scale", { value: 1.5, writable: true, configurable: true });
      await openKeyboard(input, viewport.vv, 200, { top: 0, height: 430 });
      const move = createTouchMove(10);
      document.body.dispatchEvent(move);
      expect(move.defaultPrevented).toBe(false);
    } finally { viewport.restore(); restoreHost(); }
  });

  it("no-ops cleanly when visualViewport is unavailable", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "visualViewport");
    const mode = mockViewportMode("mobile");
    try {
      delete (window as { visualViewport?: VisualViewport }).visualViewport;
      const input = await renderChat();
      // With no Visual Viewport API the layout viewport IS the visible rectangle.
      stubMeasuredRect(getThread(), { top: 0, height: document.documentElement.clientHeight });
      await act(async () => input.focus());
      expect(getThread()).not.toHaveClass("chat-thread--keyboard-active");
      expect(readBound()).toBe("");
    } finally {
      mode.mockRestore();
      if (descriptor) Object.defineProperty(window, "visualViewport", descriptor);
    }
  });

  it("clears the bound on blur and on unmount", async () => {
    const viewport = mockVisualViewport({ width: 375, height: 812 });
    const mode = mockViewportMode("mobile");
    try {
      const input = await renderChat();
      await openKeyboard(input, viewport.vv, 400, { top: 0, height: 812 });
      const thread = getThread();
      expect(thread).toHaveClass("chat-thread--keyboard-active");

      await act(async () => input.blur());
      await act(async () => setVisualViewportHeight(viewport.vv, 812));
      expect(thread).not.toHaveClass("chat-thread--keyboard-active");
      expect(thread.style.getPropertyValue("--chat-thread-visible-block-size")).toBe("");
      expect(thread.style.transform).toBe("");

      cleanup();
      expect(thread).not.toHaveClass("chat-thread--keyboard-active");
      expect(thread.style.getPropertyValue("--chat-thread-visible-block-size")).toBe("");
      expect(thread.style.willChange).toBe("");
    } finally { viewport.restore(); mode.mockRestore(); }
  });

  it("stays at its resting geometry when no rectangle can be measured", async () => {
    const viewport = mockVisualViewport({ width: 375, height: 812 });
    const mode = mockViewportMode("mobile");
    try {
      // No stubbed rect: jsdom reports an all-zero box, which proves nothing about occlusion.
      const input = await renderChat();
      await act(async () => simulateKeyboardOpen({ input, vv: viewport.vv, visualHeight: 400 }));
      expect(readBound()).toBe("");
      expect(getThread()).not.toHaveClass("chat-thread--keyboard-active");
      // The CSS fallback keeps the thread filling its parent rather than collapsing.
      expect(css).toContain("var(--chat-thread-visible-block-size, 100%)");
    } finally { mode.mockRestore(); viewport.restore(); }
  });

  it("restores the exact resting state across close → reopen → close", async () => {
    const viewport = mockVisualViewport({ width: 375, height: 812 });
    const mode = mockViewportMode("mobile");
    try {
      const input = await renderChat();
      await openKeyboard(input, viewport.vv, 400, { top: 0, height: 812 });
      expect(readBound()).toBe("400px");

      await act(async () => input.blur());
      await act(async () => setVisualViewportHeight(viewport.vv, 812));
      expect(readBound()).toBe("");

      await act(async () => simulateKeyboardOpen({ input, vv: viewport.vv, visualHeight: 400 }));
      expect(readBound()).toBe("400px");

      await act(async () => input.blur());
      await act(async () => setVisualViewportHeight(viewport.vv, 812));
      expect(readBound()).toBe("");
    } finally { mode.mockRestore(); viewport.restore(); }
  });

  it("keeps the draft, the field identity, and the selection through a keyboard cycle", async () => {
    const viewport = mockVisualViewport({ width: 375, height: 812 });
    const mode = mockViewportMode("mobile");
    try {
      const input = await renderChat();
      await userEvent.type(input, "brouillon");
      await act(async () => input.setSelectionRange(3, 3));
      await openKeyboard(input, viewport.vv, 400, { top: 0, height: 812 });
      await act(async () => setVisualViewportHeight(viewport.vv, 812));

      const current = screen.getByTestId("chat-input") as HTMLTextAreaElement;
      expect(current).toBe(input);
      expect(current.value).toBe("brouillon");
      expect(current.selectionStart).toBe(3);
    } finally { mode.mockRestore(); viewport.restore(); }
  });
});

void mockUseChat;
void mockUseChatRooms;
