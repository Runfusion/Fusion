import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { TaskPlannerChatTab } from "../TaskPlannerChatTab";
import * as api from "../../api";

const mocks = vi.hoisted(() => ({
  fetchSettings: vi.fn(),
  fetchTaskPlannerChatSession: vi.fn(),
  fetchChatSession: vi.fn(),
  fetchChatMessages: vi.fn(),
  ensureTaskPlannerChatSession: vi.fn(),
  fetchTaskDetail: vi.fn(),
  updateChatSession: vi.fn(),
  streamChatResponse: vi.fn(),
  attachChatStream: vi.fn(),
  cancelChatResponse: vi.fn(),
  addSteeringComment: vi.fn(),
}));

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  ...mocks,
}));
vi.mock("../../hooks/useModelsCache", () => ({
  useModelsCache: () => ({ models: [], favoriteProviders: [], favoriteModels: [] }),
}));
vi.mock("../CustomModelDropdown", () => ({ CustomModelDropdown: () => null }));
vi.mock("../ChatFocusSelector", () => ({
  ChatFocusSelector: () => <button type="button" data-testid="chat-focus-root" aria-label="Memory focus topic" />,
}));

const task = {
  id: "FN-9209",
  description: "Flag chat focus",
  column: "todo",
  dependencies: [],
  steps: [],
  currentStep: 0,
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:00:00.000Z",
};
const session = {
  id: "planner-session",
  agentId: "task-planner:FN-9209",
  title: "Planner",
  status: "active",
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:00:00.000Z",
  memoryFocus: "auth-northstar",
};

function renderPlanner() {
  return render(
    <TaskPlannerChatTab
      task={task as never}
      active
      projectId="proj-123"
      taskChatModel={{ provider: "anthropic", modelId: "claude" }}
      addToast={vi.fn()}
    />,
  );
}

describe("TaskPlannerChatTab chat focus experimental flag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchSettings.mockResolvedValue({});
    mocks.fetchTaskPlannerChatSession.mockResolvedValue({ session });
    mocks.fetchChatSession.mockResolvedValue({ session });
    mocks.fetchChatMessages.mockResolvedValue({ messages: [] });
    mocks.ensureTaskPlannerChatSession.mockResolvedValue({ session });
    mocks.fetchTaskDetail.mockResolvedValue(task);
    mocks.updateChatSession.mockResolvedValue({ session });
    mocks.streamChatResponse.mockReturnValue({ close: vi.fn(), isConnected: () => true });
    mocks.attachChatStream.mockReturnValue({ close: vi.fn(), isConnected: () => true });
    mocks.cancelChatResponse.mockResolvedValue({ success: true, interrupted: false });
    mocks.addSteeringComment.mockResolvedValue(task);
  });

  it("removes both the chip and its padded wrapper by default", async () => {
    const { container } = renderPlanner();

    await screen.findByLabelText("Message task chat");
    expect(screen.queryByTestId("chat-focus-root")).toBeNull();
    expect(container.querySelector(".task-planner-chat-focus-row")).toBeNull();
  });

  it("does not list /focus in the planner composer while off", async () => {
    renderPlanner();
    const input = await screen.findByLabelText("Message task chat");
    fireEvent.change(input, { target: { value: "/" } });

    expect(await screen.findByText("/steer")).toBeInTheDocument();
    expect(screen.queryByText("/focus")).toBeNull();
  });

  it("restores the wrapper, chip, and command after explicit opt-in", async () => {
    mocks.fetchSettings.mockResolvedValue({ experimentalFeatures: { chatFocus: true } });
    const { container } = renderPlanner();
    const input = await screen.findByLabelText("Message task chat");

    expect(await screen.findByTestId("chat-focus-root")).toBeInTheDocument();
    expect(container.querySelector(".task-planner-chat-focus-row")).not.toBeNull();
    fireEvent.change(input, { target: { value: "/" } });
    expect(await screen.findByText("/focus")).toBeInTheDocument();
  });
});
