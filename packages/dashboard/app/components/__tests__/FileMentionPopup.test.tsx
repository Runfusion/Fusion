import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FileMentionPopup } from "../FileMentionPopup";
import type { FileSearchItem, TaskSearchItem } from "../../hooks/useFileMention";
import { loadAllAppCss } from "../../test/cssFixture";

vi.mock("lucide-react", () => ({
  File: () => <span data-testid="file-icon">File</span>,
  Hash: () => <span data-testid="task-icon">Hash</span>,
}));

describe("FileMentionPopup", () => {
  const defaultProps = {
    visible: true,
    position: { top: 100, left: 50 },
    tasks: [] as TaskSearchItem[],
    files: [] as FileSearchItem[],
    selectedIndex: 0,
    onSelectTask: vi.fn(),
    onSelectFile: vi.fn(),
    loading: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when not visible", () => {
    const { container } = render(<FileMentionPopup {...defaultProps} visible={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders loading state", () => {
    render(<FileMentionPopup {...defaultProps} loading />);
    expect(screen.getByTestId("file-mention-loading")).toBeInTheDocument();
  });

  it("renders empty state when no tasks or files exist", () => {
    render(<FileMentionPopup {...defaultProps} />);
    expect(screen.getByTestId("file-mention-empty")).toHaveTextContent("No tasks or files found");
  });

  it("renders only tasks", () => {
    const tasks: TaskSearchItem[] = [
      { id: "FN-5218", title: "Hash entries in chat", column: "todo" },
    ];

    render(<FileMentionPopup {...defaultProps} tasks={tasks} />);

    expect(screen.getByText("Tasks")).toBeInTheDocument();
    expect(screen.queryByText("Files")).not.toBeInTheDocument();
    expect(screen.getByTestId("task-mention-item-0")).toHaveTextContent("FN-5218");
  });

  it("renders only files", () => {
    const files: FileSearchItem[] = [{ path: "src/index.ts", name: "index.ts" }];

    render(<FileMentionPopup {...defaultProps} files={files} />);

    expect(screen.getByText("Files")).toBeInTheDocument();
    expect(screen.queryByText("Tasks")).not.toBeInTheDocument();
    expect(screen.getByTestId("file-mention-item-0")).toHaveTextContent("index.ts");
  });

  it("renders both groups with tasks first and combined indexes", () => {
    const tasks: TaskSearchItem[] = [
      { id: "FN-5218", title: "Hash entries in chat", column: "todo" },
      { id: "FN-5219", title: "Follow-up", column: "done" },
    ];
    const files: FileSearchItem[] = [{ path: "src/index.ts", name: "index.ts" }];

    render(<FileMentionPopup {...defaultProps} tasks={tasks} files={files} selectedIndex={2} />);

    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(screen.getByTestId("task-mention-item-0")).toHaveTextContent("FN-5218");
    expect(screen.getByTestId("task-mention-item-1")).toHaveTextContent("FN-5219");
    expect(screen.getByTestId("file-mention-item-2")).toHaveTextContent("index.ts");
    expect(screen.getByTestId("file-mention-item-2")).toHaveClass("file-mention-popup-item--selected");
  });

  it("fires task and file selection callbacks for their rows", () => {
    const tasks: TaskSearchItem[] = [
      { id: "FN-5218", title: "Hash entries in chat", column: "todo" },
    ];
    const files: FileSearchItem[] = [{ path: "src/index.ts", name: "index.ts" }];
    const onSelectTask = vi.fn();
    const onSelectFile = vi.fn();

    render(
      <FileMentionPopup
        {...defaultProps}
        tasks={tasks}
        files={files}
        onSelectTask={onSelectTask}
        onSelectFile={onSelectFile}
      />,
    );

    fireEvent.click(screen.getByTestId("task-mention-item-0"));
    fireEvent.click(screen.getByTestId("file-mention-item-1"));

    expect(onSelectTask).toHaveBeenCalledWith(tasks[0]);
    expect(onSelectFile).toHaveBeenCalledWith(files[0]);
  });

  it("shows directory path for nested files", () => {
    const files: FileSearchItem[] = [{ path: "src/components/Button.tsx", name: "Button.tsx" }];
    render(<FileMentionPopup {...defaultProps} files={files} />);
    expect(screen.getByText("src/components/")).toBeInTheDocument();
  });

  it("renders task and file icons", () => {
    const tasks: TaskSearchItem[] = [
      { id: "FN-5218", title: "Hash entries in chat", column: "todo" },
    ];
    const files: FileSearchItem[] = [{ path: "src/index.ts", name: "index.ts" }];

    render(<FileMentionPopup {...defaultProps} tasks={tasks} files={files} />);

    expect(screen.getAllByTestId("task-icon")).toHaveLength(1);
    expect(screen.getAllByTestId("file-icon")).toHaveLength(1);
  });

  it("renders with correct position styles", () => {
    const { container } = render(
      <FileMentionPopup {...defaultProps} position={{ top: 200, left: 100 }} />,
    );

    const popup = container.firstChild as HTMLElement;
    expect(popup.style.top).toBe("200px");
    expect(popup.style.left).toBe("100px");
  });
});

describe("FN-4812 mobile anchoring", () => {
  it("anchors file mention popup above the input inside mobile media query", async () => {
    const css = await loadAllAppCss();

    expect(css).toMatch(
      /@media[^{]*\(max-width:\s*768px\)[^{]*\{[^{}]*\.file-mention-popup\s*\{[^}]*top:\s*auto\s*!important;[^}]*bottom:\s*calc\(100%\s*\+\s*var\(--space-xs\)\);[^}]*left:\s*max\(var\(--space-md\),\s*env\(safe-area-inset-left,\s*0px\)\)\s*!important;[^}]*right:\s*max\(var\(--space-md\),\s*env\(safe-area-inset-right,\s*0px\)\);/m,
    );
  });
});
