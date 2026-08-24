/*
FNXC:ViewportChrome 2026-08-23-17:07:
FN-9200 verifies the rendered cascade because a 768px tablet-class device matches the mobile media
query; without this proof, a mobile full-width rule could silently collapse the docked pane.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { ChatView } from "../ChatView";
import { loadAllAppCss } from "../../test/cssFixture";
import { installChatViewEnv, mockTabletClassTouchViewport, mockViewportMode, setupMockChat } from "./ChatView.test-harness";

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", () => ({ useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }) }));
vi.mock("../../api", () => ({ fetchSettings: vi.fn().mockResolvedValue({}), fetchModels: vi.fn().mockResolvedValue({ models: [] }), fetchAgents: vi.fn().mockResolvedValue([]), fetchDiscoveredSkills: vi.fn().mockResolvedValue([]), fetchTasks: vi.fn().mockResolvedValue([]), searchFiles: vi.fn().mockResolvedValue({ files: [] }) }));

installChatViewEnv();
afterEach(() => { document.head.querySelector("#chat-docked-css")?.remove(); });
const session = { id: "css-session", agentId: "agent-001", status: "active" as const, title: "CSS", createdAt: "2026-08-22T00:00:00.000Z", updatedAt: "2026-08-22T00:00:00.000Z" };

async function renderCss() {
  const style = document.createElement("style"); style.id = "chat-docked-css"; style.textContent = loadAllAppCss(); document.head.appendChild(style);
  setupMockChat({ activeSession: session, sessions: [session], filteredSessions: [session] });
  await act(async () => { render(<ChatView projectId="proj-123" addToast={vi.fn()} />); });
}

describe("ChatView docked sidebar tablet cascade", () => {
  it("preserves inline docked width on a 768px tablet-class device", async () => {
    const restore = mockTabletClassTouchViewport();
    try {
      await renderCss();
      const sidebar = document.querySelector(".chat-sidebar") as HTMLElement;
      const style = getComputedStyle(sidebar);
      expect(sidebar.style.width).toBe("300px");
      expect(style.minWidth).not.toBe("100%");
      expect(style.maxWidth).not.toBe("100%");
      expect(style.width).toBe("300px");
    } finally { restore(); }
  });

  it("keeps the mobile one-pane sidebar full width", async () => {
    const restore = mockViewportMode("mobile");
    try {
      await renderCss();
      const sidebar = document.querySelector(".chat-sidebar") as HTMLElement;
      const style = getComputedStyle(sidebar);
      expect(document.querySelector(".chat-view")).not.toHaveClass("chat-view--docked-list");
      expect(style.width).toBe("100%");
      expect(style.minWidth).toBe("100%");
    } finally { restore(); }
  });
});
