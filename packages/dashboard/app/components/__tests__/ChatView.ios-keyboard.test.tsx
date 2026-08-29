import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ChatView } from "../ChatView";
import { loadAllAppCss } from "../../test/cssFixture";
import * as useChatModule from "../../hooks/useChat";
import * as useChatRoomsModule from "../../hooks/useChatRooms";
import {
  activeSessionFixture,
  createRoomFixture,
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

async function openKeyboard(input: HTMLTextAreaElement, vv: VisualViewport, height: number) {
  await act(async () => simulateKeyboardOpen({ input, vv, visualHeight: height }));
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

  it("keeps the portrait phone composer in a keyboard-active thread", async () => {
    const viewport = mockVisualViewport({ width: 375, height: 812 });
    const mode = mockViewportMode("mobile");
    try {
      const input = await renderChat();
      expect(window.visualViewport).toBe(viewport.vv);
      await openKeyboard(input, viewport.vv, 400);
      expect(getThread()).toHaveClass("chat-thread--keyboard-active");
      expect(getThread().style.getPropertyValue("--vv-height")).toBe("400px");
      expect(getThread().style.getPropertyValue("--keyboard-overlap")).toBe("412px");
      expect(getThread().contains(input)).toBe(true);
    } finally { mode.mockRestore(); viewport.restore(); }
  });

  it("applies the keyboard clamp to a landscape phone outside the narrow media query", async () => {
    const restoreHost = mockPhoneLandscapeViewport();
    const viewport = mockVisualViewport({ width: 932, height: 430 });
    try {
      const input = await renderChat();
      await openKeyboard(input, viewport.vv, 200);
      expect(getThread()).toHaveClass("chat-thread--keyboard-active");
      expect(getThread().style.getPropertyValue("--vv-height")).toBe("200px");
      expect(getThread().style.getPropertyValue("--keyboard-overlap")).toBe("230px");
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
      await openKeyboard(input, viewport.vv, visualHeight);
      expect(getThread()).toHaveClass("chat-thread--keyboard-active");
      expect(getThread().style.getPropertyValue("--vv-height")).toBe(`${visualHeight}px`);
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
      await openKeyboard(input, viewport.vv, 500);
      expect(getThread()).toHaveClass("chat-thread--keyboard-active");
      if (props.floating) expect(document.querySelector(".chat-view")).toHaveClass("chat-view--narrow");
    } finally { viewport.restore(); restoreHost(); }
  });

  it("does not fabricate keyboard layout state on desktop", async () => {
    const restoreHost = mockDesktopNonTouchViewport();
    const viewport = mockVisualViewport({ width: 1280, height: 900 });
    try {
      const input = await renderChat();
      await openKeyboard(input, viewport.vv, 500);
      expect(getThread()).not.toHaveClass("chat-thread--keyboard-active");
      expect(getThread().style.getPropertyValue("--vv-height")).toBe("");
      expect(getThread().style.transform).toBe("");
    } finally { viewport.restore(); restoreHost(); }
  });

  it("makes the landscape keyboard state reachable without pinning the body", async () => {
    const restoreHost = mockPhoneLandscapeViewport();
    const viewport = mockVisualViewport({ width: 932, height: 430 });
    try {
      const input = await renderChat();
      await openKeyboard(input, viewport.vv, 200);
      await act(async () => undefined);
      const outsideMove = new Event("touchmove", { bubbles: true, cancelable: true });
      document.body.dispatchEvent(outsideMove);
      expect(outsideMove.defaultPrevented).toBe(true);
      const messages = document.querySelector(".chat-messages") as HTMLElement;
      const messagesMove = new Event("touchmove", { bubbles: true, cancelable: true });
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
        await openKeyboard(input, viewport.vv, visualHeight);
        expect(readScrollTop(), name).toBe(1000);
      } finally { cleanup(); viewport.restore(); restoreHost(); }
    }
  });

  it("keeps the active room-thread render path keyboard-active", async () => {
    const restoreHost = mockDesktopNonTouchViewport();
    const viewport = mockVisualViewport({ width: 1280, height: 900 });
    const room = createRoomFixture("keyboard-room");
    try {
      localStorage.setItem("fusion:chat-scope", "rooms");
      setupMockChat({ sessions: [], filteredSessions: [] });
      setupMockRooms({ rooms: [room], activeRoom: null });
      const style = document.createElement("style");
      style.textContent = css;
      document.head.append(style);
      const view = render(<ChatView projectId="proj-123" addToast={vi.fn()} compactLayout />);
      await act(async () => { screen.getByTestId("chat-room-item-keyboard-room").click(); });
      setupMockRooms({ rooms: [room], activeRoom: room });
      view.rerender(<ChatView projectId="proj-123" addToast={vi.fn()} compactLayout />);
      const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
      expect(getThread().querySelector(".chat-room-thread-header")).toBeTruthy();
      await openKeyboard(input, viewport.vv, 500);
      expect(getThread()).toHaveClass("chat-thread--keyboard-active");
      expect(getThread().querySelector(".chat-room-thread-header")).toBeTruthy();
    } finally { viewport.restore(); restoreHost(); }
  });

  it("does not fabricate keyboard state for an unshrunk compact host", async () => {
    const restoreHost = mockDesktopNonTouchViewport();
    const viewport = mockVisualViewport({ width: 1280, height: 900 });
    try {
      const input = await renderChat({ compactLayout: true });
      await act(async () => input.focus());
      const move = new Event("touchmove", { bubbles: true, cancelable: true });
      document.body.dispatchEvent(move);
      expect(getThread()).not.toHaveClass("chat-thread--keyboard-active");
      expect(move.defaultPrevented).toBe(false);
    } finally { viewport.restore(); restoreHost(); }
  });

  it("only applies drift compensation when visual viewport offset is nonzero", async () => {
    const viewport = mockVisualViewport({ width: 375, height: 812 });
    const mode = mockViewportMode("mobile");
    try {
      const input = await renderChat();
      await openKeyboard(input, viewport.vv, 400);
      expect(getThread().style.transform).toBe("");
      await act(async () => setVisualViewportOffsetTop(viewport.vv, 40));
      expect(getThread().style.transform).toBe("translateY(40px)");
      expect(getThread().style.willChange).toBe("transform");
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
      await openKeyboard(input, viewport.vv, 200);
      const move = new Event("touchmove", { bubbles: true, cancelable: true });
      document.body.dispatchEvent(move);
      // The visual-viewport writer deliberately remains scale-agnostic; this verifies the shared
      // keyboard hook does not turn a pinch sample into touch keyboard state.
      expect(move.defaultPrevented).toBe(false);
    } finally { viewport.restore(); restoreHost(); }
  });

  it("no-ops cleanly when visualViewport is unavailable", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "visualViewport");
    const mode = mockViewportMode("mobile");
    try {
      delete (window as { visualViewport?: VisualViewport }).visualViewport;
      const input = await renderChat();
      await act(async () => input.focus());
      expect(getThread()).not.toHaveClass("chat-thread--keyboard-active");
    } finally {
      mode.mockRestore();
      if (descriptor) Object.defineProperty(window, "visualViewport", descriptor);
    }
  });

  it("clears keyboard layout state during blur suppression and unmount", async () => {
    const viewport = mockVisualViewport({ width: 375, height: 812 });
    const mode = mockViewportMode("mobile");
    try {
      const input = await renderChat();
      await openKeyboard(input, viewport.vv, 400);
      const thread = getThread();
      expect(thread).toHaveClass("chat-thread--keyboard-active");
      await act(async () => input.blur());
      await act(async () => setVisualViewportHeight(viewport.vv, 400));
      expect(thread).not.toHaveClass("chat-thread--keyboard-active");
      expect(thread.style.getPropertyValue("--chat-keyboard-accessory-clearance")).toBe("0px");
      expect(thread.style.transform).toBe("");
      cleanup();
      expect(thread).not.toHaveClass("chat-thread--keyboard-active");
      expect(thread.style.getPropertyValue("--chat-keyboard-accessory-clearance")).toBe("0px");
      expect(thread.style.willChange).toBe("");
    } finally { viewport.restore(); mode.mockRestore(); }
  });

  it("uses the header fallback when a test layout has no measurable thread rectangle", async () => {
    const viewport = mockVisualViewport({ width: 375, height: 812 });
    const mode = mockViewportMode("mobile");
    try {
      const input = await renderChat();
      await openKeyboard(input, viewport.vv, 400);
      expect(getThread().style.getPropertyValue("--chat-thread-viewport-top")).toBe("");
      expect(css).toContain("var(--chat-thread-viewport-top, var(--header-height))");
    } finally { mode.mockRestore(); viewport.restore(); }
  });
});

void mockUseChat;
void mockUseChatRooms;
