import { describe, expect, it, vi } from "vitest";
import React from "react";
import { screen } from "@testing-library/react";
import { ChatView } from "../ChatView";
import {
  activeSessionFixture,
  defaultChatState,
  installChatViewEnv,
  renderChatDetailWithAct,
  setupMockChat,
  setupMockRooms,
} from "./ChatView.test-harness";

// Factories stay inline: importing the shared harness from a factory creates a TDZ cycle.
vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useChatUnread", () => ({
  useChatUnread: () => ({ isUnread: () => false, markRead: vi.fn() }),
}));
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useNavigationHistory")>()),
  useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
}));
vi.mock("../CustomModelDropdown", () => ({ CustomModelDropdown: () => null }));
vi.mock("lucide-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("lucide-react")>()),
  Target: (props: React.SVGProps<SVGSVGElement>) => React.createElement("svg", props),
}));
vi.mock("../../api", () => ({
  fetchSettings: vi.fn().mockResolvedValue({ experimentalFeatures: { chatFocus: true } }),
  fetchChatSession: vi.fn().mockResolvedValue({ session: { memoryFocus: null } }),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
  updateChatSession: vi.fn(),
}));

installChatViewEnv();

describe("ChatView memory focus chip", () => {
  it("keeps a cleared direct-chat focus control icon-only with its accessible name", async () => {
    const session = { ...activeSessionFixture, id: "session-focus", title: "Focus-free chat" };
    setupMockChat({
      ...defaultChatState,
      activeSession: session,
      sessions: [session],
      filteredSessions: [session],
    });
    setupMockRooms();

    await renderChatDetailWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const chip = screen.getByRole("button", { name: "Memory focus topic" });
    expect(chip.textContent?.trim()).toBe("");
    expect(chip).not.toHaveTextContent(/Focus/);
  });
});
