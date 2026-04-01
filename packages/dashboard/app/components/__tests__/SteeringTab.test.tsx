import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SteeringTab } from "../SteeringTab";
import type { TaskDetail } from "@fusion/core";

// Mock the API module
vi.mock("../../api", () => ({
  addSteeringComment: vi.fn(),
}));

import { addSteeringComment } from "../../api";

const mockAddToast = vi.fn();

function makeTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-001",
    description: "Test task",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    prompt: "# Test\n\nTest prompt",
    ...overrides,
  };
}

describe("SteeringTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders empty state when no comments", () => {
    render(<SteeringTab task={makeTask()} addToast={mockAddToast} />);

    expect(screen.getByText("Steering Comments")).toBeTruthy();
    expect(screen.getByText(/no steering comments yet/)).toBeTruthy();
  });

  it("renders comments in reverse chronological order", () => {
    const task = makeTask({
      steeringComments: [
        {
          id: "1",
          text: "First comment",
          createdAt: "2024-01-01T00:00:00Z",
          author: "user",
        },
        {
          id: "2",
          text: "Second comment",
          createdAt: "2024-01-02T00:00:00Z",
          author: "agent",
        },
      ],
    });

    render(<SteeringTab task={task} addToast={mockAddToast} />);

    // Comments should be in reverse order (newest first)
    const comments = screen.getAllByText(/comment$/);
    expect(comments.length).toBe(2);
    expect(comments[0].textContent).toBe("Second comment");
    expect(comments[1].textContent).toBe("First comment");
  });

  it("shows author badges for comments", () => {
    const task = makeTask({
      steeringComments: [
        { id: "1", text: "User comment", createdAt: "2024-01-01T00:00:00Z", author: "user" },
        { id: "2", text: "Agent comment", createdAt: "2024-01-02T00:00:00Z", author: "agent" },
      ],
    });

    render(<SteeringTab task={task} addToast={mockAddToast} />);

    expect(screen.getByText("user")).toBeTruthy();
    expect(screen.getByText("agent")).toBeTruthy();
  });

  it("shows character count", () => {
    render(<SteeringTab task={makeTask()} addToast={mockAddToast} />);

    const textarea = screen.getByPlaceholderText(/Add a steering comment/);
    fireEvent.change(textarea, { target: { value: "Hello" } });

    expect(screen.getByText("5 / 2000")).toBeTruthy();
  });

  it("disables submit button when textarea is empty", () => {
    render(<SteeringTab task={makeTask()} addToast={mockAddToast} />);

    const button = screen.getByRole("button", { name: /Add Steering Comment/ });
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("disables submit button when text exceeds 2000 characters", () => {
    render(<SteeringTab task={makeTask()} addToast={mockAddToast} />);

    const textarea = screen.getByPlaceholderText(/Add a steering comment/);
    const longText = "a".repeat(2001);
    fireEvent.change(textarea, { target: { value: longText } });

    const button = screen.getByRole("button", { name: /Add Steering Comment/ });
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("enables submit button when text is valid", () => {
    render(<SteeringTab task={makeTask()} addToast={mockAddToast} />);

    const textarea = screen.getByPlaceholderText(/Add a steering comment/);
    fireEvent.change(textarea, { target: { value: "Valid comment" } });

    const button = screen.getByRole("button", { name: /Add Steering Comment/ });
    expect(button.hasAttribute("disabled")).toBe(false);
  });

  it("submits comment on button click", async () => {
    const mockApi = vi.mocked(addSteeringComment);
    mockApi.mockResolvedValue({
      ...makeTask(),
      steeringComments: [
        {
          id: "new-1",
          text: "New comment",
          createdAt: "2024-01-03T00:00:00Z",
          author: "user",
        },
      ],
    });

    render(<SteeringTab task={makeTask()} addToast={mockAddToast} />);

    const textarea = screen.getByPlaceholderText(/Add a steering comment/);
    fireEvent.change(textarea, { target: { value: "New comment" } });

    const button = screen.getByRole("button", { name: /Add Steering Comment/ });
    fireEvent.click(button);

    await waitFor(() => {
      expect(mockApi).toHaveBeenCalledWith("FN-001", "New comment");
    });
  });

  it("submits comment on Ctrl+Enter", async () => {
    const mockApi = vi.mocked(addSteeringComment);
    mockApi.mockResolvedValue({
      ...makeTask(),
      steeringComments: [
        {
          id: "new-1",
          text: "Keyboard comment",
          createdAt: "2024-01-03T00:00:00Z",
          author: "user",
        },
      ],
    });

    render(<SteeringTab task={makeTask()} addToast={mockAddToast} />);

    const textarea = screen.getByPlaceholderText(/Add a steering comment/);
    fireEvent.change(textarea, { target: { value: "Keyboard comment" } });

    // Ctrl+Enter should submit
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

    await waitFor(() => {
      expect(mockApi).toHaveBeenCalledWith("FN-001", "Keyboard comment");
    });
  });

  it("submits comment on Cmd+Enter (Mac)", async () => {
    const mockApi = vi.mocked(addSteeringComment);
    mockApi.mockResolvedValue({
      ...makeTask(),
      steeringComments: [
        {
          id: "new-1",
          text: "Mac keyboard comment",
          createdAt: "2024-01-03T00:00:00Z",
          author: "user",
        },
      ],
    });

    render(<SteeringTab task={makeTask()} addToast={mockAddToast} />);

    const textarea = screen.getByPlaceholderText(/Add a steering comment/);
    fireEvent.change(textarea, { target: { value: "Mac keyboard comment" } });

    // Cmd+Enter should submit (metaKey is Cmd on Mac)
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });

    await waitFor(() => {
      expect(mockApi).toHaveBeenCalledWith("FN-001", "Mac keyboard comment");
    });
  });

  it("clears textarea after successful submission", async () => {
    const mockApi = vi.mocked(addSteeringComment);
    mockApi.mockResolvedValue({
      ...makeTask(),
      steeringComments: [
        {
          id: "new-1",
          text: "Cleared comment",
          createdAt: "2024-01-03T00:00:00Z",
          author: "user",
        },
      ],
    });

    render(<SteeringTab task={makeTask()} addToast={mockAddToast} />);

    const textarea = screen.getByPlaceholderText(/Add a steering comment/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Cleared comment" } });

    const button = screen.getByRole("button", { name: /Add Steering Comment/ });
    fireEvent.click(button);

    await waitFor(() => {
      expect(textarea.value).toBe("");
    });
  });

  it("shows loading state during submission", async () => {
    const mockApi = vi.mocked(addSteeringComment);
    // Delay the resolution to see loading state
    mockApi.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 100)));

    render(<SteeringTab task={makeTask()} addToast={mockAddToast} />);

    const textarea = screen.getByPlaceholderText(/Add a steering comment/);
    fireEvent.change(textarea, { target: { value: "Loading test" } });

    const button = screen.getByRole("button", { name: /Add Steering Comment/ });
    fireEvent.click(button);

    // Should show loading text
    expect(screen.getByRole("button", { name: /Adding…/ })).toBeTruthy();
  });

  it("shows error toast on API failure", async () => {
    const mockApi = vi.mocked(addSteeringComment);
    mockApi.mockRejectedValue(new Error("Network error"));

    render(<SteeringTab task={makeTask()} addToast={mockAddToast} />);

    const textarea = screen.getByPlaceholderText(/Add a steering comment/);
    fireEvent.change(textarea, { target: { value: "Error test" } });

    const button = screen.getByRole("button", { name: /Add Steering Comment/ });
    fireEvent.click(button);

    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledWith("Network error", "error");
    });
  });

  it("updates comment list after successful submission", async () => {
    const mockApi = vi.mocked(addSteeringComment);
    mockApi.mockResolvedValue({
      ...makeTask(),
      steeringComments: [
        {
          id: "new-1",
          text: "Added comment",
          createdAt: "2024-01-03T00:00:00Z",
          author: "user",
        },
      ],
    });

    render(<SteeringTab task={makeTask()} addToast={mockAddToast} />);

    const textarea = screen.getByPlaceholderText(/Add a steering comment/);
    fireEvent.change(textarea, { target: { value: "Added comment" } });

    const button = screen.getByRole("button", { name: /Add Steering Comment/ });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText("Added comment")).toBeTruthy();
      expect(screen.getByText("user")).toBeTruthy();
    });
  });
});
