import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TaskCard } from "./TaskCard";
import type { Task } from "@fusion/core";

// Mock lucide-react to avoid SVG rendering issues in test env
vi.mock("lucide-react", () => ({
  Link: () => null,
  Clock: () => null,
  Pencil: () => null,
  Maximize2: () => null,
  Layers: () => null,
  ChevronDown: () => null,
  Folder: () => null,
  GitPullRequest: () => null,
  CircleDot: () => null,
}));

// Mock the api module
vi.mock("../api", () => ({
  fetchTaskDetail: vi.fn(),
  uploadAttachment: vi.fn(),
}));

import { uploadAttachment } from "../api";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-001",
    title: "Test task",
    column: "in-progress",
    status: undefined as any,
    steps: [],
    dependencies: [],
    description: "",
    ...overrides,
  } as Task;
}

const noop = () => {};

describe("TaskCard", () => {
  it("renders the card ID text", () => {
    render(<TaskCard task={makeTask()} onOpenDetail={noop} addToast={noop} />);
    expect(screen.getByText("FN-001")).toBeDefined();
  });

  it("renders the status badge when task.status is set", () => {
    render(
      <TaskCard
        task={makeTask({ status: "executing" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );
    expect(screen.getByText("executing")).toBeDefined();
  });

  it("renders the status badge after the card ID in DOM order", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({ status: "executing" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );
    const cardId = container.querySelector(".card-id")!;
    const badge = container.querySelector(".card-status-badge")!;
    expect(cardId).toBeDefined();
    expect(badge).toBeDefined();
    // Badge should be the next sibling of card-id
    expect(cardId.nextElementSibling).toBe(badge);
  });

  it("does not render a status badge when task.status is falsy", () => {
    const { container } = render(
      <TaskCard task={makeTask({ status: undefined as any })} onOpenDetail={noop} addToast={noop} />,
    );
    expect(container.querySelector(".card-status-badge")).toBeNull();
  });

  it("shows drop indicator on file dragover and removes on dragleave", () => {
    const { container } = render(
      <TaskCard task={makeTask()} onOpenDetail={noop} addToast={noop} />,
    );
    const card = container.querySelector(".card")!;

    // Simulate file dragover
    fireEvent.dragOver(card, {
      dataTransfer: { types: ["Files"], dropEffect: "none" },
    });
    expect(card.classList.contains("file-drop-target")).toBe(true);

    // Simulate dragleave
    fireEvent.dragLeave(card, {
      dataTransfer: { types: ["Files"] },
    });
    expect(card.classList.contains("file-drop-target")).toBe(false);
  });

  it("does not show drop indicator for non-file drag", () => {
    const { container } = render(
      <TaskCard task={makeTask()} onOpenDetail={noop} addToast={noop} />,
    );
    const card = container.querySelector(".card")!;

    // Simulate card dragover (not files)
    fireEvent.dragOver(card, {
      dataTransfer: { types: ["text/plain"], dropEffect: "none" },
    });
    expect(card.classList.contains("file-drop-target")).toBe(false);
  });

  it("calls uploadAttachment on file drop", async () => {
    const mockUpload = vi.mocked(uploadAttachment);
    mockUpload.mockResolvedValue({
      filename: "abc-test.png",
      originalName: "test.png",
      mimeType: "image/png",
      size: 1024,
      createdAt: new Date().toISOString(),
    });
    const addToast = vi.fn();

    const { container } = render(
      <TaskCard task={makeTask()} onOpenDetail={noop} addToast={addToast} />,
    );
    const card = container.querySelector(".card")!;

    const file = new File(["content"], "test.png", { type: "image/png" });
    fireEvent.drop(card, {
      dataTransfer: { types: ["Files"], files: [file] },
    });

    await waitFor(() => {
      expect(mockUpload).toHaveBeenCalledWith("FN-001", file);
      expect(addToast).toHaveBeenCalledWith(
        expect.stringContaining("Attached test.png"),
        "success",
      );
    });
  });

  it("shows error toast when upload fails", async () => {
    const mockUpload = vi.mocked(uploadAttachment);
    mockUpload.mockRejectedValue(new Error("Upload failed"));
    const addToast = vi.fn();

    const { container } = render(
      <TaskCard task={makeTask()} onOpenDetail={noop} addToast={addToast} />,
    );
    const card = container.querySelector(".card")!;

    const file = new File(["content"], "bad.png", { type: "image/png" });
    fireEvent.drop(card, {
      dataTransfer: { types: ["Files"], files: [file] },
    });

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith(
        expect.stringContaining("Failed to attach bad.png"),
        "error",
      );
    });
  });

  // Size badge positioning regression tests (KB-197)
  it("renders size badge for sized tasks", () => {
    const { container } = render(
      <TaskCard task={makeTask({ size: "S" })} onOpenDetail={noop} addToast={noop} />,
    );
    expect(container.querySelector(".card-size-badge")).not.toBeNull();
    expect(screen.getByText("S")).toBeDefined();
  });

  it("does not render size badge when task has no size", () => {
    const { container } = render(
      <TaskCard task={makeTask({ size: undefined })} onOpenDetail={noop} addToast={noop} />,
    );
    expect(container.querySelector(".card-size-badge")).toBeNull();
  });

  it("renders all three size values with correct CSS classes", () => {
    const sizes: Array<"S" | "M" | "L"> = ["S", "M", "L"];
    const expectedClasses = ["size-s", "size-m", "size-l"];

    sizes.forEach((size, index) => {
      const { container } = render(
        <TaskCard task={makeTask({ size })} onOpenDetail={noop} addToast={noop} />,
      );
      const badge = container.querySelector(".card-size-badge");
      expect(badge).not.toBeNull();
      expect(badge?.classList.contains(expectedClasses[index])).toBe(true);
      // Clean up for next iteration
      container.remove();
    });
  });

  it("places size badge inside card-header-actions container", () => {
    const { container } = render(
      <TaskCard task={makeTask({ size: "M" })} onOpenDetail={noop} addToast={noop} />,
    );
    const actionsContainer = container.querySelector(".card-header-actions");
    const sizeBadge = container.querySelector(".card-size-badge");
    
    expect(actionsContainer).not.toBeNull();
    expect(sizeBadge).not.toBeNull();
    expect(actionsContainer?.contains(sizeBadge)).toBe(true);
  });

  it("places card-header-actions after card-id in DOM order", () => {
    const { container } = render(
      <TaskCard task={makeTask({ size: "S" })} onOpenDetail={noop} addToast={noop} />,
    );
    const cardId = container.querySelector(".card-id")!;
    const actionsContainer = container.querySelector(".card-header-actions")!;
    
    expect(cardId).not.toBeNull();
    expect(actionsContainer).not.toBeNull();
    // The actions container should come after card-id
    expect(
      cardId.compareDocumentPosition(actionsContainer) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("renders edit button inside card-header-actions for editable columns", () => {
    const { container } = render(
      <TaskCard 
        task={makeTask({ column: "todo", size: "S" })} 
        onOpenDetail={noop} 
        addToast={noop}
        onUpdateTask={async () => makeTask()}
      />,
    );
    const actionsContainer = container.querySelector(".card-header-actions");
    const editBtn = container.querySelector(".card-edit-btn");
    
    expect(actionsContainer).not.toBeNull();
    expect(editBtn).not.toBeNull();
    expect(actionsContainer?.contains(editBtn)).toBe(true);
  });

  it("renders archive button inside card-header-actions for done column", () => {
    const { container } = render(
      <TaskCard 
        task={makeTask({ column: "done", size: "L" })} 
        onOpenDetail={noop} 
        addToast={noop}
        onArchiveTask={async () => makeTask()}
      />,
    );
    const actionsContainer = container.querySelector(".card-header-actions");
    const archiveBtn = container.querySelector(".card-archive-btn");
    
    expect(actionsContainer).not.toBeNull();
    expect(archiveBtn).not.toBeNull();
    expect(actionsContainer?.contains(archiveBtn)).toBe(true);
  });
});
