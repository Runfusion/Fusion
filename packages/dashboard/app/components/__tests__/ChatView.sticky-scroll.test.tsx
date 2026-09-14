import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "../ChatView";
import type { ChatMessageInfo } from "../../hooks/useChat";
import {
  activeSessionFixture,
  installChatViewEnv,
  mockViewportMode,
  renderWithAct,
  setupMockChat,
} from "./ChatView.test-harness";
import { readAppFile } from "../../test/cssFixture";

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return {
    ...actual,
    useNavigationHistoryContext: () => ({ pushNav: vi.fn(), removeNav: vi.fn() }),
  };
});
vi.mock("../../api", () => ({
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [], defaultProvider: "", defaultModelId: "" }),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
  fetchChatSession: vi.fn().mockResolvedValue({ session: { memoryFocus: null } }),
}));

installChatViewEnv();
afterEach(() => cleanup());

/*
FNXC:StickyBottomScroll 2026-09-14-20:19:
FN-398 — reproduction exacte du symptôme signalé : dans un chat « magnétisé » au bas, un petit geste de molette
(30 px, soit MOINS que l'ancien seuil de 50 px) ne désengageait pas le suivi, et la croissance de streaming suivante
réécrivait `scrollTop` en bas. Ces cas rejouent ce geste, puis font croître le transcript, et affirment que le viewport
ne bouge plus. Le seuil de proximité ne sert désormais qu'au RÉENGAGEMENT.
*/

function message(id: string, content: string): ChatMessageInfo {
  return {
    id,
    sessionId: activeSessionFixture.id,
    role: "assistant",
    content,
    createdAt: `2026-09-14T20:00:${id.slice(-2)}.000Z`,
  };
}

const longHistory: ChatMessageInfo[] = Array.from({ length: 24 }, (_, index) =>
  message(`message-${String(index).padStart(2, "0")}`, `Message numéro ${index}`));

/** Force a desktop-width measurement; jsdom reports 0 and ChatView would resolve every host as narrow. */
function installWideLayout() {
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function boundingRect(this: HTMLElement) {
    return { width: 1200, height: 800, top: 0, left: 0, right: 1200, bottom: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  return () => { HTMLElement.prototype.getBoundingClientRect = original; };
}

interface TranscriptGeometry {
  readonly scrollTop: number;
  setScrollTop(value: number): void;
  grow(byPx: number): void;
  readonly scrollHeight: number;
}

function installTranscriptGeometry(transcript: HTMLElement, options: { scrollHeight: number; clientHeight: number }): TranscriptGeometry {
  let scrollHeight = options.scrollHeight;
  let scrollTop = scrollHeight - options.clientHeight;
  Object.defineProperties(transcript, {
    clientHeight: { configurable: true, get: () => options.clientHeight },
    scrollHeight: { configurable: true, get: () => scrollHeight },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = Math.max(0, Math.min(value, scrollHeight - options.clientHeight)); },
    },
  });
  return {
    get scrollTop() { return scrollTop; },
    get scrollHeight() { return scrollHeight; },
    setScrollTop(value: number) { scrollTop = value; },
    grow(byPx: number) { scrollHeight += byPx; },
  };
}

async function findTranscript(): Promise<HTMLElement> {
  return waitFor(() => {
    const element = document.querySelector<HTMLElement>(".chat-messages");
    if (!element) throw new Error("Expected the .chat-messages transcript to be mounted");
    return element;
  });
}

async function openConversation() {
  const row = await waitFor(() => {
    const element = document.querySelector<HTMLElement>(".chat-session-item");
    if (!element) throw new Error("Expected a conversation row");
    return element;
  });
  await act(async () => { fireEvent.click(row); });
}

/** A single wheel notch upward — deliberately smaller than the legacy 50px bottom-follow threshold. */
function wheelUp(transcript: HTMLElement, deltaY = -30) {
  const event = new Event("wheel", { bubbles: true });
  Object.defineProperty(event, "deltaY", { value: deltaY });
  Object.defineProperty(event, "target", { value: transcript });
  act(() => { transcript.dispatchEvent(event); });
}

function scrollBy(transcript: HTMLElement, geometry: TranscriptGeometry, deltaPx: number) {
  geometry.setScrollTop(geometry.scrollTop + deltaPx);
  act(() => { fireEvent.scroll(transcript); });
}

/** Run the anchor loop's settle frames so any surviving write would land. */
async function flushAnchorFrames() {
  await act(async () => {
    for (let frame = 0; frame < 8; frame += 1) {
      await new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });
    }
  });
}

async function renderStreamingChat(options: { streamingText: string }) {
  setupMockChat({
    activeSession: activeSessionFixture,
    messages: longHistory,
    isStreaming: true,
    streamingText: options.streamingText,
  });
  return renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
}

async function growStream(rerender: (ui: React.ReactElement) => void, geometry: TranscriptGeometry, text: string) {
  geometry.grow(120);
  setupMockChat({
    activeSession: activeSessionFixture,
    messages: longHistory,
    isStreaming: true,
    streamingText: text,
  });
  await act(async () => { rerender(<ChatView projectId="proj-123" addToast={vi.fn()} />); });
  await flushAnchorFrames();
}

describe("FN-398 ChatView — a manual scroll always wins over bottom anchoring", () => {
  it("keeps the viewport still after a 30px wheel-up, even though the reader is inside the 50px window", async () => {
    const restoreLayout = installWideLayout();
    try {
      const view = await renderStreamingChat({ streamingText: "réponse partielle" });
      await openConversation();
      const transcript = await findTranscript();
      const geometry = installTranscriptGeometry(transcript, { scrollHeight: 4000, clientHeight: 400 });

      // The reader is pinned at the bottom.
      expect(geometry.scrollTop).toBe(3600);

      wheelUp(transcript);
      scrollBy(transcript, geometry, -30);
      const detachedAt = geometry.scrollTop;
      expect(detachedAt).toBe(3570);

      await growStream(view.rerender, geometry, "réponse partielle plus longue");

      expect(geometry.scrollTop).toBe(detachedAt);
    } finally {
      restoreLayout();
    }
  });

  it("keeps the viewport still after the same gesture on a mobile viewport", async () => {
    mockViewportMode("mobile");
    const view = await renderStreamingChat({ streamingText: "partiel" });
    await openConversation();
    const transcript = await findTranscript();
    const geometry = installTranscriptGeometry(transcript, { scrollHeight: 4000, clientHeight: 400 });

    wheelUp(transcript);
    scrollBy(transcript, geometry, -30);
    const detachedAt = geometry.scrollTop;

    await growStream(view.rerender, geometry, "partiel encore");

    expect(geometry.scrollTop).toBe(detachedAt);
  });

  it("keeps the viewport still on a floating host measured at desktop width", async () => {
    const restoreLayout = installWideLayout();
    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: longHistory,
        isStreaming: true,
        streamingText: "flottant",
      });
      const view = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} floating />);
      await openConversation();
      const transcript = await findTranscript();
      const geometry = installTranscriptGeometry(transcript, { scrollHeight: 4000, clientHeight: 400 });

      wheelUp(transcript);
      scrollBy(transcript, geometry, -30);
      const detachedAt = geometry.scrollTop;

      geometry.grow(120);
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: longHistory,
        isStreaming: true,
        streamingText: "flottant plus long",
      });
      await act(async () => { view.rerender(<ChatView projectId="proj-123" addToast={vi.fn()} floating />); });
      await flushAnchorFrames();

      expect(geometry.scrollTop).toBe(detachedAt);
    } finally {
      restoreLayout();
    }
  });

  it("rearms following through the jump-to-latest control, so later growth follows again", async () => {
    const restoreLayout = installWideLayout();
    try {
      const view = await renderStreamingChat({ streamingText: "avant" });
      await openConversation();
      const transcript = await findTranscript();
      const geometry = installTranscriptGeometry(transcript, { scrollHeight: 4000, clientHeight: 400 });

      wheelUp(transcript);
      scrollBy(transcript, geometry, -30);
      expect(geometry.scrollTop).toBe(3570);

      const jumpButton = await waitFor(() => {
        const button = document.querySelector<HTMLElement>(".chat-scroll-bottom-fab, [data-testid='chat-jump-to-latest']");
        if (!button) throw new Error("Expected the jump-to-latest control while detached");
        return button;
      });
      await act(async () => { fireEvent.click(jumpButton); });
      await flushAnchorFrames();

      expect(geometry.scrollTop).toBe(geometry.scrollHeight - 400);

      await growStream(view.rerender, geometry, "après");

      expect(geometry.scrollTop).toBe(geometry.scrollHeight - 400);
    } finally {
      restoreLayout();
    }
  });

  it("writes nothing for an empty transcript", async () => {
    const restoreLayout = installWideLayout();
    try {
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });
      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
      await openConversation();
      const transcript = await findTranscript();
      const geometry = installTranscriptGeometry(transcript, { scrollHeight: 300, clientHeight: 400 });
      geometry.setScrollTop(0);

      wheelUp(transcript);
      await flushAnchorFrames();

      expect(geometry.scrollTop).toBe(0);
    } finally {
      restoreLayout();
    }
  });

  it("does not detach a gesture on a transcript that cannot scroll", async () => {
    const restoreLayout = installWideLayout();
    try {
      const view = await renderStreamingChat({ streamingText: "court" });
      await openConversation();
      const transcript = await findTranscript();
      const geometry = installTranscriptGeometry(transcript, { scrollHeight: 400, clientHeight: 400 });
      geometry.setScrollTop(0);

      wheelUp(transcript);
      // Growth now makes the transcript scrollable; following was never released, so it follows.
      await growStream(view.rerender, geometry, "court mais plus long");

      expect(geometry.scrollTop).toBeGreaterThan(0);
    } finally {
      restoreLayout();
    }
  });

  it("preserves a detached anchor when older history is prepended", async () => {
    const restoreLayout = installWideLayout();
    try {
      const view = await renderStreamingChat({ streamingText: "historique" });
      await openConversation();
      const transcript = await findTranscript();
      const geometry = installTranscriptGeometry(transcript, { scrollHeight: 4000, clientHeight: 400 });

      wheelUp(transcript);
      scrollBy(transcript, geometry, -30);
      const detachedAt = geometry.scrollTop;

      const older = Array.from({ length: 6 }, (_, index) => message(`older-${String(index).padStart(2, "0")}`, `Ancien ${index}`));
      geometry.grow(600);
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [...older, ...longHistory],
        isStreaming: true,
        streamingText: "historique",
      });
      await act(async () => { view.rerender(<ChatView projectId="proj-123" addToast={vi.fn()} />); });
      await flushAnchorFrames();

      // A prepend shifts the anchor but must never REARM following.
      const afterPrepend = geometry.scrollTop;
      expect(afterPrepend).toBeGreaterThanOrEqual(detachedAt);

      await growStream(view.rerender, geometry, "historique et suite");

      expect(geometry.scrollTop).toBe(afterPrepend);
    } finally {
      restoreLayout();
    }
  });
});

describe("FN-398 ChatView CSS", () => {
  it("disables native scroll anchoring on the transcript root", () => {
    const css = readAppFile("components/ChatView.css");
    const baseRule = css.slice(css.indexOf("\n.chat-messages {"), css.indexOf("\n.chat-transcript-row {"));
    expect(baseRule).toContain("overflow-anchor: none;");
  });
});
