// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatView } from "../ChatView";
import {
  activeSessionFixture,
  installChatViewEnv,
  renderChatDetailWithAct,
  setupMockChat,
} from "./ChatView.test-harness";

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useNavigationHistory")>()),
  useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn(), removeNav: vi.fn() }),
}));
vi.mock("../../hooks/useModelsCache", () => ({
  useModelsCache: () => ({
    models: [{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }],
    favoriteProviders: [],
    favoriteModels: [],
    defaultProvider: "anthropic",
    defaultModelId: "claude-sonnet-4-5",
    loading: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("../../hooks/useFavorites", () => ({
  useFavorites: () => ({ availableModels: [{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }], favoriteProviders: [], favoriteModels: [], providerInstances: {}, toggleFavoriteProvider: vi.fn(), toggleFavoriteModel: vi.fn() }),
}));
vi.mock("../../api", () => ({
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchGlobalSettings: vi.fn().mockResolvedValue({ chatSnippets: [] }),
  updateGlobalSettings: vi.fn().mockResolvedValue({ chatSnippets: [] }),
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
  fetchChatSession: vi.fn().mockResolvedValue({ session: { memoryFocus: null } }),
}));

installChatViewEnv();

const makeFile = () => new File(["notes"], "note.txt", { type: "text/plain" });

function setupCancellationChat(overrides: Parameters<typeof setupMockChat>[0] = {}) {
  const sendMessage = overrides.sendMessage ?? vi.fn();
  const stopStreaming = overrides.stopStreaming ?? vi.fn().mockResolvedValue(undefined);
  setupMockChat({
    activeSession: activeSessionFixture,
    messages: [],
    pendingQueueAction: true,
    sendMessage,
    stopStreaming,
    ...overrides,
  });
  return { sendMessage, stopStreaming };
}

async function renderChat(addToast = vi.fn()) {
  const view = await renderChatDetailWithAct(
    <ChatView projectId="proj-123" addToast={addToast} />,
  );
  return { view, addToast, textarea: screen.getByTestId("chat-input") };
}

function expectStagedFile() {
  expect(screen.getByTestId("chat-attachment-preview-0")).toHaveTextContent("note.txt");
}

async function expectAttachmentRefusal(addToast: ReturnType<typeof vi.fn>, sendMessage: ReturnType<typeof vi.fn>) {
  expect(sendMessage).not.toHaveBeenCalled();
  await waitFor(() => {
    expect(addToast).toHaveBeenCalledWith(expect.stringMatching(/attachment/i), "warning");
  });
  expectStagedFile();
}

describe("ChatView cancellation barrier attachments", () => {
  it("refuses a pre-staged attachment while preserving its text and preview", async () => {
    const user = userEvent.setup();
    const sendMessage = vi.fn();
    setupCancellationChat({ pendingQueueAction: false, sendMessage });
    const { view, addToast, textarea } = await renderChat();
    await user.upload(screen.getByTestId("chat-file-input"), makeFile());
    expectStagedFile();

    setupCancellationChat({ pendingQueueAction: true, sendMessage });
    view.rerender(<ChatView projectId="proj-123" addToast={addToast} />);
    await user.type(textarea, "Keep this draft");
    await user.click(screen.getByTestId("chat-send-btn"));

    await expectAttachmentRefusal(addToast, sendMessage);
    expect(textarea).toHaveValue("Keep this draft");
  });

  it("allows paste staging during cancellation but refuses its dispatch", async () => {
    const sendMessage = vi.fn();
    setupCancellationChat({ sendMessage });
    const { addToast, textarea } = await renderChat();

    fireEvent.paste(textarea, { clipboardData: { files: [makeFile()] } });
    expectStagedFile();
    fireEvent.change(textarea, { target: { value: "Pasted file draft" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await expectAttachmentRefusal(addToast, sendMessage);
    expect(textarea).toHaveValue("Pasted file draft");
  });

  it("allows drop staging during cancellation but refuses its dispatch", async () => {
    const sendMessage = vi.fn();
    setupCancellationChat({ sendMessage });
    const { addToast, textarea } = await renderChat();
    const wrapper = textarea.closest(".chat-input-wrapper");
    expect(wrapper).not.toBeNull();

    fireEvent.drop(wrapper!, { dataTransfer: { files: [makeFile()] } });
    expectStagedFile();
    fireEvent.change(textarea, { target: { value: "Dropped file draft" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await expectAttachmentRefusal(addToast, sendMessage);
    expect(textarea).toHaveValue("Dropped file draft");
  });

  it("gives attachment-only button and Enter submissions the same explicit refusal", async () => {
    const user = userEvent.setup();
    const sendMessage = vi.fn();
    setupCancellationChat({ sendMessage });
    const { addToast, textarea } = await renderChat();
    await user.upload(screen.getByTestId("chat-file-input"), makeFile());
    const sendButton = screen.getByTestId("chat-send-btn");

    expect(textarea).toHaveValue("");
    expect(sendButton).not.toBeDisabled();
    await user.click(sendButton);
    await waitFor(() => expect(addToast).toHaveBeenCalledTimes(1));
    expect(addToast).toHaveBeenLastCalledWith(expect.stringMatching(/attachment/i), "warning");
    expect(sendMessage).not.toHaveBeenCalled();

    textarea.focus();
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(addToast).toHaveBeenCalledTimes(2));
    expect(addToast).toHaveBeenLastCalledWith(expect.stringMatching(/attachment/i), "warning");
    expect(sendMessage).not.toHaveBeenCalled();
    expectStagedFile();
  });

  it("continues dispatching text-only submissions during cancellation", async () => {
    const user = userEvent.setup();
    const sendMessage = vi.fn();
    setupCancellationChat({ sendMessage });
    const { addToast, textarea } = await renderChat();

    await user.type(textarea, "Queue this text");
    await user.click(screen.getByTestId("chat-send-btn"));

    expect(sendMessage).toHaveBeenCalledWith("Queue this text", [], expect.objectContaining({
      onAccepted: expect.any(Function),
      onDelivered: expect.any(Function),
      onFailed: expect.any(Function),
    }));
    expect(addToast).not.toHaveBeenCalledWith(expect.stringMatching(/attachment/i), "warning");
  });

  it("reuses the current barrier for clear and still rejects clear with staged files", async () => {
    const stopStreaming = vi.fn().mockResolvedValue(undefined);
    setupCancellationChat({ stopStreaming });
    const first = await renderChat();

    fireEvent.change(first.textarea, { target: { value: "/clear" } });
    fireEvent.keyDown(first.textarea, { key: "Enter" });
    await waitFor(() => expect(stopStreaming).toHaveBeenCalledTimes(1));
    expect(first.addToast).not.toHaveBeenCalledWith(expect.any(String), "error");

    first.view.unmount();
    const guardedStopStreaming = vi.fn().mockResolvedValue(undefined);
    const sendMessage = vi.fn();
    setupCancellationChat({ stopStreaming: guardedStopStreaming, sendMessage });
    const second = await renderChat();
    await userEvent.upload(screen.getByTestId("chat-file-input"), makeFile());
    fireEvent.change(second.textarea, { target: { value: "/clear" } });
    fireEvent.keyDown(second.textarea, { key: "Enter" });

    await expectAttachmentRefusal(second.addToast, sendMessage);
    expect(guardedStopStreaming).not.toHaveBeenCalled();
    expect(second.textarea).toHaveValue("/clear");
  });
});
