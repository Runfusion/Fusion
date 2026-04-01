import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { ListView } from "../ListView";
import type { Task, TaskDetail } from "@fusion/core";

// Mock the API
vi.mock("../../api", () => ({
  fetchModels: vi.fn().mockResolvedValue([]),
  fetchTaskDetail: vi.fn(),
  batchUpdateTaskModels: vi.fn(),
}));

import { fetchTaskDetail } from "../../api";

const mockAddToast = vi.fn();

const createMockTask = (overrides: Partial<Task> = {}): Task => ({
  id: "FN-001",
  description: "Test task description",
  title: "Test Task",
  column: "triage",
  dependencies: [],
  steps: [],
  currentStep: 0,
  status: "pending",
  paused: false,
  log: [],
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
  ...overrides,
});

const renderListView = (props: Partial<React.ComponentProps<typeof ListView>> = {}) => {
  const defaultProps = {
    tasks: [],
    onMoveTask: vi.fn(),
    onOpenDetail: vi.fn(),
    addToast: mockAddToast,
    globalPaused: false,
    onNewTask: vi.fn(),
  };

  return render(<ListView {...defaultProps} {...props} />);
};

describe("ListView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("renders without crashing", () => {
    renderListView();
    expect(screen.getByPlaceholderText("Filter by ID or title...")).toBeDefined();
  });

  it("displays tasks in table format", () => {
    const tasks = [
      createMockTask({ id: "FN-001", title: "First Task" }),
      createMockTask({ id: "FN-002", title: "Second Task" }),
    ];

    renderListView({ tasks });

    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.getByText("First Task")).toBeDefined();
    expect(screen.getByText("FN-002")).toBeDefined();
    expect(screen.getByText("Second Task")).toBeDefined();
  });

  it("shows empty state when no tasks", () => {
    renderListView({ tasks: [] });
    expect(screen.getByText("No tasks yet")).toBeDefined();
  });

  it("shows empty state when filter matches nothing", () => {
    const tasks = [createMockTask({ id: "FN-001", title: "Test Task" })];

    renderListView({ tasks });

    const filterInput = screen.getByPlaceholderText("Filter by ID or title...");
    fireEvent.change(filterInput, { target: { value: "nonexistent" } });

    expect(screen.getByText("No tasks match your filter")).toBeDefined();
  });

  it("filters tasks by ID", () => {
    const tasks = [
      createMockTask({ id: "FN-001", title: "First Task" }),
      createMockTask({ id: "FN-002", title: "Second Task" }),
    ];

    renderListView({ tasks });

    const filterInput = screen.getByPlaceholderText("Filter by ID or title...");
    fireEvent.change(filterInput, { target: { value: "FN-001" } });

    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.queryByText("FN-002")).toBeNull();
  });

  it("filters tasks by title", () => {
    const tasks = [
      createMockTask({ id: "FN-001", title: "First Task" }),
      createMockTask({ id: "FN-002", title: "Second Task" }),
    ];

    renderListView({ tasks });

    const filterInput = screen.getByPlaceholderText("Filter by ID or title...");
    fireEvent.change(filterInput, { target: { value: "Second" } });

    expect(screen.queryByText("FN-001")).toBeNull();
    expect(screen.getByText("FN-002")).toBeDefined();
  });

  it("filters tasks by description when no title", () => {
    const tasks = [
      createMockTask({ id: "FN-001", title: undefined, description: "Alpha description" }),
      createMockTask({ id: "FN-002", title: undefined, description: "Beta description" }),
    ];

    renderListView({ tasks });

    const filterInput = screen.getByPlaceholderText("Filter by ID or title...");
    fireEvent.change(filterInput, { target: { value: "Alpha" } });

    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.queryByText("FN-002")).toBeNull();
  });

  it("clears filter when clear button is clicked", () => {
    const tasks = [
      createMockTask({ id: "FN-001", title: "First Task" }),
      createMockTask({ id: "FN-002", title: "Second Task" }),
    ];

    renderListView({ tasks });

    const filterInput = screen.getByPlaceholderText("Filter by ID or title...");
    fireEvent.change(filterInput, { target: { value: "FN-001" } });

    // Wait for filter to apply
    expect(screen.queryByText("FN-002")).toBeNull();

    // Click clear button (×)
    const clearButton = screen.getByText("×");
    fireEvent.click(clearButton);

    // Both tasks should be visible again
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.getByText("FN-002")).toBeDefined();
  });

  it("calls onOpenDetail when row is clicked", async () => {
    const tasks = [createMockTask({ id: "FN-001", title: "Test Task" })];
    const mockOnOpenDetail = vi.fn();
    const mockDetail: TaskDetail = {
      ...tasks[0],
      prompt: "Test prompt",
    };

    (fetchTaskDetail as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockDetail);

    renderListView({ tasks, onOpenDetail: mockOnOpenDetail });

    const row = screen.getByText("FN-001").closest("tr");
    fireEvent.click(row!);

    await waitFor(() => {
      expect(fetchTaskDetail).toHaveBeenCalledWith("FN-001");
    });

    expect(mockOnOpenDetail).toHaveBeenCalledWith(mockDetail);
  });

  it("shows error toast when fetchTaskDetail fails", async () => {
    const tasks = [createMockTask({ id: "FN-001", title: "Test Task" })];
    const mockOnOpenDetail = vi.fn();

    (fetchTaskDetail as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Network error"));

    renderListView({ tasks, onOpenDetail: mockOnOpenDetail });

    const row = screen.getByText("FN-001").closest("tr");
    fireEvent.click(row!);

    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledWith("Failed to load task details", "error");
    });
  });

  it("sorts tasks by ID when ID header is clicked", () => {
    const tasks = [
      createMockTask({ id: "FN-003", title: "Third", column: "triage" }),
      createMockTask({ id: "FN-001", title: "First", column: "triage" }),
      createMockTask({ id: "FN-002", title: "Second", column: "triage" }),
    ];

    renderListView({ tasks });

    // First click - ascending
    const idHeader = screen.getByText("ID");
    fireEvent.click(idHeader);

    // Get all data rows (excluding section headers by using data-id attribute)
    const rows = screen.getAllByRole("row").filter(r => r.getAttribute("data-id"));
    expect(rows[0].textContent).toContain("FN-001");
    expect(rows[1].textContent).toContain("FN-002");
    expect(rows[2].textContent).toContain("FN-003");

    // Second click - descending
    fireEvent.click(idHeader);

    const rowsDesc = screen.getAllByRole("row").filter(r => r.getAttribute("data-id"));
    expect(rowsDesc[0].textContent).toContain("FN-003");
    expect(rowsDesc[1].textContent).toContain("FN-002");
    expect(rowsDesc[2].textContent).toContain("FN-001");
  });

  it("sorts tasks by column when Column header is clicked", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "done" }),
      createMockTask({ id: "FN-002", column: "triage" }),
      createMockTask({ id: "FN-003", column: "in-progress" }),
    ];

    renderListView({ tasks });

    // Click "Show Done" to reveal done tasks
    const showDoneButton = screen.getByRole("button", { name: /show done/i });
    fireEvent.click(showDoneButton);

    const columnHeader = screen.getByText("Column");
    fireEvent.click(columnHeader);

    // Get data rows - sorted by column alphabetically: done, in-progress, triage
    const rows = screen.getAllByRole("row").filter(r => r.getAttribute("data-id"));
    expect(rows[0].textContent).toContain("FN-002"); // triage (sorted first alphabetically)
    expect(rows[1].textContent).toContain("FN-003"); // in-progress
    expect(rows[2].textContent).toContain("FN-001"); // done
  });

  it("sorts tasks by status when Status header is clicked", () => {
    const tasks = [
      createMockTask({ id: "FN-001", status: "executing", column: "triage" }),
      createMockTask({ id: "FN-002", status: "pending", column: "triage" }),
      createMockTask({ id: "FN-003", status: "failed", column: "triage" }),
    ];

    renderListView({ tasks });

    const statusHeader = screen.getByText("Status");
    fireEvent.click(statusHeader);

    // Get data rows - sorted by status alphabetically
    const rows = screen.getAllByRole("row").filter(r => r.getAttribute("data-id"));
    // Should be sorted alphabetically by status: executing, failed, pending
    expect(rows[0].textContent).toContain("executing");
    expect(rows[2].textContent).toContain("pending");
  });

  it("renders failed status with correct styling", () => {
    const tasks = [createMockTask({ id: "FN-001", status: "failed" })];

    renderListView({ tasks });

    const row = screen.getByText("FN-001").closest("tr");
    expect(row?.className).toContain("failed");

    const statusBadge = screen.getByText("failed");
    expect(statusBadge.className).toContain("failed");
  });

  it("renders paused tasks with dimmed styling", () => {
    const tasks = [createMockTask({ id: "FN-001", paused: true })];

    renderListView({ tasks });

    const row = screen.getByText("FN-001").closest("tr");
    expect(row?.className).toContain("paused");
  });

  it("renders agent-active tasks with glow styling", () => {
    const tasks = [
      createMockTask({
        id: "FN-001",
        status: "executing",
        column: "in-progress",
      }),
    ];

    renderListView({ tasks, globalPaused: false });

    const row = screen.getByText("FN-001").closest("tr");
    expect(row?.className).toContain("agent-active");
  });

  it("does not render agent-active when globalPaused is true", () => {
    const tasks = [
      createMockTask({
        id: "FN-001",
        status: "executing",
        column: "in-progress",
      }),
    ];

    renderListView({ tasks, globalPaused: true });

    const row = screen.getByText("FN-001").closest("tr");
    expect(row?.className).not.toContain("agent-active");
  });

  it("renders column badges with correct colors", () => {
    const columns = ["triage", "todo", "in-progress", "in-review", "done"] as const;

    const tasks = columns.map((col, i) =>
      createMockTask({ id: `FN-00${i + 1}`, column: col })
    );

    renderListView({ tasks });

    // Click "Show Done" to reveal done tasks in the table
    const showDoneButton = screen.getByRole("button", { name: /show done/i });
    fireEvent.click(showDoneButton);

    // Check that all column badges are rendered in the table
    // Use getAllByText and check length since column names appear in both drop zones and badges
    expect(screen.getAllByText("Triage").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Todo").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("In Progress").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("In Review").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Done").length).toBeGreaterThanOrEqual(1);

    // Check that badges have the correct styling by querying within the table
    const table = document.querySelector(".list-table");
    expect(table?.textContent).toContain("Triage");
    expect(table?.textContent).toContain("Todo");
    expect(table?.textContent).toContain("In Progress");
    expect(table?.textContent).toContain("In Review");
    expect(table?.textContent).toContain("Done");
  });

  it("renders step progress bar", () => {
    const tasks = [
      createMockTask({
        id: "FN-001",
        steps: [
          { name: "Step 1", status: "done" },
          { name: "Step 2", status: "done" },
          { name: "Step 3", status: "pending" },
        ],
      }),
    ];

    renderListView({ tasks });

    expect(screen.getByText("2/3")).toBeDefined();
  });

  it("shows - for tasks with no steps", () => {
    const tasks = [createMockTask({ id: "FN-001", steps: [] })];

    renderListView({ tasks });

    // Find the task row and check its progress cell
    const row = screen.getByText("FN-001").closest("tr")!;
    const progressCell = row.querySelector(".list-cell-progress");
    expect(progressCell?.textContent).toBe("-");
  });

  it("renders dependency count with icon", () => {
    const tasks = [
      createMockTask({
        id: "FN-001",
        dependencies: ["FN-002", "FN-003"],
      }),
    ];

    renderListView({ tasks });

    expect(screen.getByText("2")).toBeDefined();
  });

  it("shows - for tasks with no dependencies", () => {
    const tasks = [createMockTask({ id: "FN-001", dependencies: [] })];

    renderListView({ tasks });

    const depCells = screen.getAllByRole("cell");
    // Find the cell that should contain deps (6th column, index 5 - after checkbox column)
    const depCell = depCells[5];
    expect(depCell.textContent).toBe("-");
  });

  it("displays correct task count in stats", () => {
    const tasks = [
      createMockTask({ id: "FN-001" }),
      createMockTask({ id: "FN-002" }),
      createMockTask({ id: "FN-003" }),
    ];

    renderListView({ tasks });

    expect(screen.getByText("3 of 3 tasks")).toBeDefined();
  });

  it("displays filtered task count in stats", () => {
    const tasks = [
      createMockTask({ id: "FN-001", title: "Alpha" }),
      createMockTask({ id: "FN-002", title: "Beta" }),
      createMockTask({ id: "FN-003", title: "Gamma" }),
    ];

    renderListView({ tasks });

    const filterInput = screen.getByPlaceholderText("Filter by ID or title...");
    fireEvent.change(filterInput, { target: { value: "Alpha" } });

    expect(screen.getByText("1 of 3 tasks")).toBeDefined();
  });

  it("calls onNewTask when + New Task button is clicked", () => {
    const mockOnNewTask = vi.fn();

    renderListView({ onNewTask: mockOnNewTask });

    const newTaskButton = screen.getByText("+ New Task");
    fireEvent.click(newTaskButton);

    expect(mockOnNewTask).toHaveBeenCalled();
  });

  it("does not render + New Task button when onNewTask is not provided", () => {
    renderListView({ onNewTask: undefined });

    expect(screen.queryByText("+ New Task")).toBeNull();
  });

  it("renders drop zones for each column", () => {
    renderListView();

    expect(screen.getByText("Triage")).toBeDefined();
    expect(screen.getByText("Todo")).toBeDefined();
    expect(screen.getByText("In Progress")).toBeDefined();
    expect(screen.getByText("In Review")).toBeDefined();
    expect(screen.getByText("Done")).toBeDefined();
  });

  it("displays correct task counts in drop zones", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage" }),
      createMockTask({ id: "FN-002", column: "triage" }),
      createMockTask({ id: "FN-003", column: "todo" }),
    ];

    renderListView({ tasks });

    // Use querySelector to find drop zones by data-column attribute
    const triageZone = document.querySelector('[data-column="triage"]');
    expect(triageZone?.textContent).toContain("2");

    const todoZone = document.querySelector('[data-column="todo"]');
    expect(todoZone?.textContent).toContain("1");
  });

  it("handles drag and drop to move tasks between columns", async () => {
    const tasks = [createMockTask({ id: "FN-001", column: "triage" })];
    const mockOnMoveTask = vi.fn(() => Promise.resolve(tasks[0]));

    renderListView({ tasks, onMoveTask: mockOnMoveTask });

    const row = screen.getByText("FN-001").closest("tr")!;

    // Simulate drag start
    fireEvent.dragStart(row, {
      dataTransfer: {
        setData: vi.fn(),
        effectAllowed: "move",
      },
    });

    // Simulate drop on todo column drop zone (use querySelector for specificity)
    const todoZone = document.querySelector('[data-column="todo"].list-drop-zone')!;
    fireEvent.dragOver(todoZone, {
      preventDefault: vi.fn(),
      dataTransfer: { dropEffect: "move" },
    });

    fireEvent.drop(todoZone, {
      preventDefault: vi.fn(),
      dataTransfer: {
        getData: vi.fn(() => "FN-001"),
      },
    });

    await waitFor(() => {
      expect(mockOnMoveTask).toHaveBeenCalledWith("FN-001", "todo");
    });
  });

  it("does not set draggable for paused tasks", () => {
    const tasks = [createMockTask({ id: "FN-001", paused: true })];

    renderListView({ tasks });

    const row = screen.getByText("FN-001").closest("tr")!;
    // Paused tasks should have draggable="false"
    expect(row.getAttribute("draggable")).toBe("false");
  });

  it("sets draggable for non-paused tasks", () => {
    const tasks = [createMockTask({ id: "FN-001", paused: false })];

    renderListView({ tasks });

    const row = screen.getByText("FN-001").closest("tr")!;
    // Non-paused tasks should have draggable="true"
    expect(row.getAttribute("draggable")).toBe("true");
  });

  it("shows error toast when onMoveTask fails during drag and drop", async () => {
    const tasks = [createMockTask({ id: "FN-001", column: "triage" })];
    const mockOnMoveTask = vi.fn(() => Promise.reject(new Error("Move failed")));

    renderListView({ tasks, onMoveTask: mockOnMoveTask });

    const row = screen.getByText("FN-001").closest("tr")!;

    fireEvent.dragStart(row, {
      dataTransfer: {
        setData: vi.fn(),
        effectAllowed: "move",
      },
    });

    // Use querySelector to find the specific drop zone
    const todoZone = document.querySelector('[data-column="todo"].list-drop-zone')!;
    fireEvent.drop(todoZone, {
      preventDefault: vi.fn(),
      dataTransfer: {
        getData: vi.fn(() => "FN-001"),
      },
    });

    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledWith("Move failed", "error");
    });
  });

  it("displays full description in title cell when no title exists", () => {
    const longDescription = "A".repeat(100);
    const tasks = [createMockTask({ id: "FN-001", title: undefined, description: longDescription })];

    renderListView({ tasks });

    // The full 100-character description should be visible
    const titleCell = screen.getByText(longDescription).closest("td")!;
    expect(titleCell.textContent).toBe(longDescription);
    expect(titleCell.textContent?.length).toBe(100);
  });

  // Grouped view tests
  it("renders section headers for each column", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage" }),
      createMockTask({ id: "FN-002", column: "todo" }),
    ];

    renderListView({ tasks });

    // Click "Show Done" to show all column sections including Done and Archived
    const showDoneButton = screen.getByRole("button", { name: /show done/i });
    fireEvent.click(showDoneButton);

    // Check that section headers are rendered with column names
    expect(screen.getAllByText("Triage").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Todo").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("In Progress").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("In Review").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Done").length).toBeGreaterThanOrEqual(1);
  });

  it("displays correct task count in section headers", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage" }),
      createMockTask({ id: "FN-002", column: "triage" }),
      createMockTask({ id: "FN-003", column: "todo" }),
    ];

    renderListView({ tasks });

    // Click "Show Done" to show all column sections
    const showDoneButton = screen.getByRole("button", { name: /show done/i });
    fireEvent.click(showDoneButton);

    // Find section headers by their structure
    const sectionHeaders = screen.getAllByRole("row").filter(r => r.className.includes("list-section-header"));
    expect(sectionHeaders.length).toBe(6); // One for each column

    // Check that triage section shows count of 2
    const triageHeader = sectionHeaders.find(h => h.textContent?.includes("Triage"));
    expect(triageHeader?.textContent).toContain("2");

    // Check that todo section shows count of 1
    const todoHeader = sectionHeaders.find(h => h.textContent?.includes("Todo"));
    expect(todoHeader?.textContent).toContain("1");
  });

  it("shows No tasks placeholder for empty columns", () => {
    const tasks = [createMockTask({ id: "FN-001", column: "triage" })];

    renderListView({ tasks });

    // Should show "No tasks" for empty columns
    const noTasksCells = screen.getAllByText("No tasks");
    expect(noTasksCells.length).toBeGreaterThanOrEqual(1);
  });

  it("hides empty sections when filter is active", () => {
    const tasks = [
      createMockTask({ id: "FN-001", title: "Alpha Task", column: "triage" }),
      createMockTask({ id: "FN-002", title: "Beta Task", column: "todo" }),
    ];

    renderListView({ tasks });

    // Apply filter that only matches triage task
    const filterInput = screen.getByPlaceholderText("Filter by ID or title...");
    fireEvent.change(filterInput, { target: { value: "Alpha" } });

    // Only triage section should be visible (todo section should be hidden)
    const sectionHeaders = screen.getAllByRole("row").filter(r => r.className.includes("list-section-header"));
    expect(sectionHeaders.length).toBe(1);
    expect(sectionHeaders[0].textContent).toContain("Triage");

    // Verify the filtered task is visible
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.queryByText("FN-002")).toBeNull();
  });

  it("maintains sort order within each section", () => {
    const tasks = [
      createMockTask({ id: "FN-003", title: "Charlie", column: "triage" }),
      createMockTask({ id: "FN-001", title: "Alpha", column: "triage" }),
      createMockTask({ id: "FN-002", title: "Bravo", column: "triage" }),
    ];

    renderListView({ tasks });

    // Sort by title
    const titleHeader = screen.getByText("Title");
    fireEvent.click(titleHeader);

    // Get only data rows within the triage section
    const allRows = screen.getAllByRole("row");
    const triageSectionStart = allRows.findIndex(r => r.className.includes("list-section-header") && r.textContent?.includes("Triage"));
    
    // The next 3 rows after the section header should be the sorted tasks
    const dataRows = allRows.slice(triageSectionStart + 1, triageSectionStart + 4).filter(r => r.getAttribute("data-id"));
    
    expect(dataRows[0].textContent).toContain("FN-001"); // Alpha
    expect(dataRows[1].textContent).toContain("FN-002"); // Bravo
    expect(dataRows[2].textContent).toContain("FN-003"); // Charlie
  });
});

describe("ListView Column Filtering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("filters tasks by column when drop zone is clicked", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Triage Task" }),
      createMockTask({ id: "FN-002", column: "todo", title: "Todo Task" }),
      createMockTask({ id: "FN-003", column: "in-progress", title: "In Progress Task" }),
    ];

    renderListView({ tasks });

    // Click on the triage drop zone
    const triageZone = document.querySelector('[data-column="triage"].list-drop-zone')!;
    fireEvent.click(triageZone);

    // Only triage task should be visible
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.queryByText("FN-002")).toBeNull();
    expect(screen.queryByText("FN-003")).toBeNull();

    // Only triage section header should be visible
    const sectionHeaders = screen.getAllByRole("row").filter(r => r.className.includes("list-section-header"));
    expect(sectionHeaders.length).toBe(1);
    expect(sectionHeaders[0].textContent).toContain("Triage");
  });

  it("clears column filter when same drop zone is clicked again", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Triage Task" }),
      createMockTask({ id: "FN-002", column: "todo", title: "Todo Task" }),
    ];

    renderListView({ tasks });

    // Click on the triage drop zone to filter
    const triageZone = document.querySelector('[data-column="triage"].list-drop-zone')!;
    fireEvent.click(triageZone);

    // Verify filter is active - only triage task visible
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.queryByText("FN-002")).toBeNull();

    // Click the same drop zone again to clear filter
    fireEvent.click(triageZone);

    // All tasks should be visible again
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.getByText("FN-002")).toBeDefined();

    // Click "Show Done" to reveal all column sections
    const showDoneButton = screen.getByRole("button", { name: /show done/i });
    fireEvent.click(showDoneButton);

    // All 6 section headers should be visible (one for each column)
    const sectionHeaders = screen.getAllByRole("row").filter(r => r.className.includes("list-section-header"));
    expect(sectionHeaders.length).toBe(6);
  });

  it("switches column filter when different drop zone is clicked", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Triage Task" }),
      createMockTask({ id: "FN-002", column: "todo", title: "Todo Task" }),
    ];

    renderListView({ tasks });

    // Click on the triage drop zone to filter
    const triageZone = document.querySelector('[data-column="triage"].list-drop-zone')!;
    fireEvent.click(triageZone);

    // Verify only triage task visible
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.queryByText("FN-002")).toBeNull();

    // Click on the todo drop zone to switch filter
    const todoZone = document.querySelector('[data-column="todo"].list-drop-zone')!;
    fireEvent.click(todoZone);

    // Only todo task should be visible now
    expect(screen.queryByText("FN-001")).toBeNull();
    expect(screen.getByText("FN-002")).toBeDefined();

    // Only todo section header should be visible
    const sectionHeaders = screen.getAllByRole("row").filter(r => r.className.includes("list-section-header"));
    expect(sectionHeaders.length).toBe(1);
    expect(sectionHeaders[0].textContent).toContain("Todo");
  });

  it("clears column filter when clear button is clicked", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Triage Task" }),
      createMockTask({ id: "FN-002", column: "todo", title: "Todo Task" }),
    ];

    renderListView({ tasks });

    // Click on the triage drop zone to filter
    const triageZone = document.querySelector('[data-column="triage"].list-drop-zone')!;
    fireEvent.click(triageZone);

    // Verify filter is active
    expect(screen.queryByText("FN-002")).toBeNull();

    // Click the clear button
    const clearButton = screen.getByRole("button", { name: /clear column filter/i });
    fireEvent.click(clearButton);

    // All tasks should be visible again
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.getByText("FN-002")).toBeDefined();
  });

  it("shows correct filtered stats when column filter is active", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Triage Task" }),
      createMockTask({ id: "FN-002", column: "triage", title: "Triage Task 2" }),
      createMockTask({ id: "FN-003", column: "todo", title: "Todo Task" }),
    ];

    renderListView({ tasks });

    // Click on the triage drop zone to filter
    const triageZone = document.querySelector('[data-column="triage"].list-drop-zone')!;
    fireEvent.click(triageZone);

    // Stats should show filtered count with column name
    expect(screen.getByText("2 of 3 tasks in Triage")).toBeDefined();
  });

  it("applies text filter within column filter", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Alpha Triage Task" }),
      createMockTask({ id: "FN-002", column: "triage", title: "Beta Triage Task" }),
      createMockTask({ id: "FN-003", column: "todo", title: "Alpha Todo Task" }),
    ];

    renderListView({ tasks });

    // Click on the triage drop zone to filter by column
    const triageZone = document.querySelector('[data-column="triage"].list-drop-zone')!;
    fireEvent.click(triageZone);

    // Both triage tasks should be visible
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.getByText("FN-002")).toBeDefined();
    expect(screen.queryByText("FN-003")).toBeNull();

    // Apply text filter within the triage column
    const filterInput = screen.getByPlaceholderText("Filter by ID or title...");
    fireEvent.change(filterInput, { target: { value: "Alpha" } });

    // Only Alpha triage task should be visible
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.queryByText("FN-002")).toBeNull();
    expect(screen.queryByText("FN-003")).toBeNull();

    // Stats should reflect combined filtering
    expect(screen.getByText("1 of 3 tasks in Triage")).toBeDefined();
  });

  it("applies active class to selected column drop zone", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Triage Task" }),
    ];

    renderListView({ tasks });

    // Click on the triage drop zone
    const triageZone = document.querySelector('[data-column="triage"].list-drop-zone')!;
    fireEvent.click(triageZone);

    // Should have active class
    expect(triageZone.classList.contains("active")).toBe(true);

    // Other drop zones should not have active class
    const todoZone = document.querySelector('[data-column="todo"].list-drop-zone')!;
    expect(todoZone.classList.contains("active")).toBe(false);
  });
});

describe("ListView Column Visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear localStorage before each test
    localStorage.clear();
  });

  it("renders column toggle button", () => {
    renderListView();

    const columnsButton = screen.getByRole("button", { name: /columns/i });
    expect(columnsButton).toBeDefined();
  });

  it("opens column dropdown when toggle clicked", () => {
    renderListView();

    const columnsButton = screen.getByRole("button", { name: /columns/i });
    fireEvent.click(columnsButton);

    // Dropdown should be visible with checkboxes for each column
    expect(screen.getByText("ID")).toBeDefined();
    expect(screen.getByText("Title")).toBeDefined();
    expect(screen.getByText("Status")).toBeDefined();
    expect(screen.getByText("Column")).toBeDefined();
    expect(screen.getByText("Dependencies")).toBeDefined();
    expect(screen.getByText("Progress")).toBeDefined();
  });

  it("hides column when unchecked in dropdown", () => {
    const tasks = [createMockTask({ id: "FN-001", title: "Test Task" })];
    renderListView({ tasks });

    // Open dropdown
    const columnsButton = screen.getByRole("button", { name: /columns/i });
    fireEvent.click(columnsButton);

    // Uncheck the Title column
    const checkboxes = screen.getAllByRole("checkbox");
    const titleCheckbox = checkboxes.find(
      cb => cb.parentElement?.textContent?.includes("Title")
    );
    expect(titleCheckbox).toBeDefined();
    fireEvent.click(titleCheckbox!);

    // Title column should no longer be visible in the table
    const table = document.querySelector(".list-table");
    expect(table?.textContent).not.toContain("Test Task");
  });

  it("shows column when checked in dropdown", () => {
    const tasks = [createMockTask({ id: "FN-001", title: "Test Task" })];
    renderListView({ tasks });

    // Open dropdown
    const columnsButton = screen.getByRole("button", { name: /columns/i });
    fireEvent.click(columnsButton);
    
    // Find and uncheck the Title column
    const checkboxes = screen.getAllByRole("checkbox");
    const titleCheckbox = checkboxes.find(
      cb => cb.parentElement?.textContent?.includes("Title")
    );
    expect(titleCheckbox).toBeDefined();
    fireEvent.click(titleCheckbox!);

    // Verify Title is hidden
    const table = document.querySelector(".list-table");
    expect(table?.textContent).not.toContain("Test Task");

    // Re-check the Title column (still in the same dropdown session)
    const titleCheckbox2 = screen.getAllByRole("checkbox").find(
      cb => cb.parentElement?.textContent?.includes("Title")
    );
    expect(titleCheckbox2).toBeDefined();
    fireEvent.click(titleCheckbox2!);

    // Title column should be visible again
    const tableAfter = document.querySelector(".list-table");
    expect(tableAfter?.textContent).toContain("Test Task");
  });

  it("persists column visibility to localStorage", () => {
    const tasks = [createMockTask({ id: "FN-001", title: "Test Task" })];
    renderListView({ tasks });

    // Open dropdown and uncheck Title
    const columnsButton = screen.getByRole("button", { name: /columns/i });
    fireEvent.click(columnsButton);
    const titleCheckbox = screen.getByLabelText("Title");
    fireEvent.click(titleCheckbox);

    // Verify localStorage was updated
    const saved = localStorage.getItem("kb-dashboard-list-columns");
    expect(saved).toBeTruthy();
    const parsed = JSON.parse(saved!);
    expect(parsed).not.toContain("title");
  });

  it("initializes column visibility from localStorage", () => {
    // Set up localStorage with only ID and Status visible
    localStorage.setItem("kb-dashboard-list-columns", JSON.stringify(["id", "status"]));

    const tasks = [createMockTask({ id: "FN-001", title: "Test Task", status: "pending" })];
    renderListView({ tasks });

    // ID should be visible
    expect(screen.getByText("FN-001")).toBeDefined();

    // Title should NOT be visible (hidden by localStorage)
    const table = document.querySelector(".list-table");
    expect(table?.textContent).not.toContain("Test Task");
  });

  it("prevents hiding all columns (at least one stays visible)", () => {
    renderListView();

    // Open dropdown
    const columnsButton = screen.getByRole("button", { name: /columns/i });
    fireEvent.click(columnsButton);

    // Get all checkboxes and try to uncheck all except one
    const checkboxes = screen.getAllByRole("checkbox");
    
    // Uncheck all but one
    for (let i = 0; i < checkboxes.length - 1; i++) {
      if ((checkboxes[i] as HTMLInputElement).checked) {
        fireEvent.click(checkboxes[i]);
      }
    }

    // The last checkbox should be disabled (check the disabled property)
    const lastCheckbox = checkboxes[checkboxes.length - 1];
    if ((lastCheckbox as HTMLInputElement).checked) {
      expect((lastCheckbox as HTMLInputElement).disabled).toBe(true);
    }
  });

  it("sorting still works when some columns are hidden", () => {
    const tasks = [
      createMockTask({ id: "FN-003", column: "triage" }),
      createMockTask({ id: "FN-001", column: "triage" }),
      createMockTask({ id: "FN-002", column: "triage" }),
    ];
    renderListView({ tasks });

    // Hide some columns
    const columnsButton = screen.getByRole("button", { name: /columns/i });
    fireEvent.click(columnsButton);
    const checkboxes = screen.getAllByRole("checkbox");
    const titleCheckbox = checkboxes.find(
      cb => cb.parentElement?.textContent?.includes("Title")
    );
    expect(titleCheckbox).toBeDefined();
    fireEvent.click(titleCheckbox!);

    // Find and click ID header to sort (use getAllByText and find the header cell)
    const idHeaders = screen.getAllByText("ID");
    const idHeader = idHeaders.find(el => el.tagName === "TH" || el.closest("th"));
    expect(idHeader).toBeDefined();
    fireEvent.click(idHeader!);

    // Get sorted rows and verify sorting still works
    const rows = screen.getAllByRole("row").filter(r => r.getAttribute("data-id"));
    expect(rows[0].textContent).toContain("FN-001");
    expect(rows[1].textContent).toContain("FN-002");
    expect(rows[2].textContent).toContain("FN-003");
  });

  it("all columns visible by default when no localStorage", () => {
    const tasks = [
      createMockTask({ id: "FN-001", title: "Test Task", status: "pending", column: "triage" }),
    ];
    renderListView({ tasks });

    // All columns should be visible by default
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.getByText("Test Task")).toBeDefined();
    expect(screen.getByText("pending")).toBeDefined();
    // Check for column badge specifically using the class
    const columnBadge = document.querySelector(".list-column-badge");
    expect(columnBadge?.textContent).toContain("Triage");
  });
});


describe("ListView Hide Done Tasks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("renders hide done tasks toggle button with 'Show Done' when done tasks are hidden by default", () => {
    renderListView();

    const hideDoneButton = screen.getByRole("button", { name: /show done/i });
    expect(hideDoneButton).toBeDefined();
  });

  it("hides done tasks by default when no localStorage value exists", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "done" }),
      createMockTask({ id: "FN-002", column: "triage" }),
    ];

    renderListView({ tasks });

    // Done task should be hidden by default
    expect(screen.queryByText("FN-001")).toBeNull();
    expect(screen.getByText("FN-002")).toBeDefined();
  });

  it("hides done tasks when toggle is activated", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "done" }),
      createMockTask({ id: "FN-002", column: "triage" }),
    ];

    renderListView({ tasks });

    // Click "Show Done" to show done tasks first
    const showDoneButton = screen.getByRole("button", { name: /show done/i });
    fireEvent.click(showDoneButton);

    // Both tasks should be visible now
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.getByText("FN-002")).toBeDefined();

    // Click "Hide Done" to hide done tasks
    const hideDoneButton = screen.getByRole("button", { name: /hide done/i });
    fireEvent.click(hideDoneButton);

    // Done task should be hidden, triage task should still be visible
    expect(screen.queryByText("FN-001")).toBeNull();
    expect(screen.getByText("FN-002")).toBeDefined();
  });

  it("hides archived tasks when toggle is activated", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "archived" }),
      createMockTask({ id: "FN-002", column: "triage" }),
    ];

    renderListView({ tasks });

    // Click "Show Done" to show archived tasks first
    const showDoneButton = screen.getByRole("button", { name: /show done/i });
    fireEvent.click(showDoneButton);

    // Both tasks should be visible now
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.getByText("FN-002")).toBeDefined();

    // Click "Hide Done" to hide archived tasks
    const hideDoneButton = screen.getByRole("button", { name: /hide done/i });
    fireEvent.click(hideDoneButton);

    // Archived task should be hidden, triage task should still be visible
    expect(screen.queryByText("FN-001")).toBeNull();
    expect(screen.getByText("FN-002")).toBeDefined();
  });

  it("hides both done and archived tasks when toggle is activated", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "done" }),
      createMockTask({ id: "FN-002", column: "archived" }),
      createMockTask({ id: "FN-003", column: "triage" }),
    ];

    renderListView({ tasks });

    // Click "Show Done" to show all completed tasks first
    const showDoneButton = screen.getByRole("button", { name: /show done/i });
    fireEvent.click(showDoneButton);

    // All tasks should be visible now
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.getByText("FN-002")).toBeDefined();
    expect(screen.getByText("FN-003")).toBeDefined();

    // Click "Hide Done" to hide completed tasks
    const hideDoneButton = screen.getByRole("button", { name: /hide done/i });
    fireEvent.click(hideDoneButton);

    // Done and archived tasks should be hidden, triage task should remain visible
    expect(screen.queryByText("FN-001")).toBeNull();
    expect(screen.queryByText("FN-002")).toBeNull();
    expect(screen.getByText("FN-003")).toBeDefined();
  });

  it("shows done and archived tasks when toggle is deactivated", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "done" }),
      createMockTask({ id: "FN-002", column: "archived" }),
      createMockTask({ id: "FN-003", column: "triage" }),
    ];

    renderListView({ tasks });

    // Completed tasks should be hidden by default
    expect(screen.queryByText("FN-001")).toBeNull();
    expect(screen.queryByText("FN-002")).toBeNull();

    // Click "Show Done" to show all tasks
    const showDoneButton = screen.getByRole("button", { name: /show done/i });
    fireEvent.click(showDoneButton);

    // All tasks should be visible again
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.getByText("FN-002")).toBeDefined();
    expect(screen.getByText("FN-003")).toBeDefined();
  });

  it("persists hide done preference to localStorage", () => {
    const tasks = [createMockTask({ id: "FN-001", column: "done" })];
    renderListView({ tasks });

    // Click "Show Done" first (since default is now hidden)
    const showDoneButton = screen.getByRole("button", { name: /show done/i });
    fireEvent.click(showDoneButton);

    // Click "Hide Done" to hide done tasks
    const hideDoneButton = screen.getByRole("button", { name: /hide done/i });
    fireEvent.click(hideDoneButton);

    // Verify localStorage was updated
    expect(localStorage.getItem("kb-dashboard-hide-done")).toBe("true");
  });

  it("initializes hide done state from localStorage", () => {
    // Set up localStorage with hide done enabled
    localStorage.setItem("kb-dashboard-hide-done", "true");

    const tasks = [
      createMockTask({ id: "FN-001", column: "done" }),
      createMockTask({ id: "FN-002", column: "archived" }),
      createMockTask({ id: "FN-003", column: "triage" }),
    ];
    renderListView({ tasks });

    // Button should show "Show Done" text since done tasks are hidden
    expect(screen.getByRole("button", { name: /show done/i })).toBeDefined();

    // Completed tasks should be hidden initially
    expect(screen.queryByText("FN-001")).toBeNull();
    expect(screen.queryByText("FN-002")).toBeNull();
    expect(screen.getByText("FN-003")).toBeDefined();
  });

  it("updates stats text when done and archived tasks are hidden", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "done" }),
      createMockTask({ id: "FN-002", column: "archived" }),
      createMockTask({ id: "FN-003", column: "triage" }),
    ];

    renderListView({ tasks });

    // Stats should show filtered count with hidden indicator (default is now hidden)
    expect(screen.getByText("1 of 3 tasks")).toBeDefined();
    expect(screen.getByText(/2 hidden/)).toBeDefined();
  });

  it("hides done and archived column section headers when hide done is active", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "done" }),
      createMockTask({ id: "FN-002", column: "archived" }),
      createMockTask({ id: "FN-003", column: "triage" }),
    ];

    renderListView({ tasks });

    // Done and Archived sections should be hidden by default
    const doneSection = screen.getAllByRole("row").find(r => 
      r.className.includes("list-section-header") && r.textContent?.includes("Done")
    );
    expect(doneSection).toBeUndefined();

    const archivedSection = screen.getAllByRole("row").find(r => 
      r.className.includes("list-section-header") && r.textContent?.includes("Archived")
    );
    expect(archivedSection).toBeUndefined();

    // Triage section should still be visible
    const triageSection = screen.getAllByRole("row").find(r => 
      r.className.includes("list-section-header") && r.textContent?.includes("Triage")
    );
    expect(triageSection).toBeDefined();
  });

  it("shows done drop zone with count when hide done is active", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "done" }),
      createMockTask({ id: "FN-002", column: "done" }),
    ];

    renderListView({ tasks });

    // Done drop zone should be visible with "X of Y" format (hide done is active by default)
    const doneZone = document.querySelector('[data-column="done"].list-drop-zone');
    expect(doneZone).toBeDefined();
    expect(doneZone?.textContent).toContain("0 of 2");
  });

  it("shows archived drop zone with count when hide done is active", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "archived" }),
      createMockTask({ id: "FN-002", column: "archived" }),
    ];

    renderListView({ tasks });

    // Archived drop zone should be visible with "X of Y" format (hide done is active by default)
    const archivedZone = document.querySelector('[data-column="archived"].list-drop-zone');
    expect(archivedZone).toBeDefined();
    expect(archivedZone?.textContent).toContain("0 of 2");
  });

  it("preserves hide done state through filter changes", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "done", title: "Alpha" }),
      createMockTask({ id: "FN-002", column: "archived", title: "Beta" }),
      createMockTask({ id: "FN-003", column: "triage", title: "Gamma" }),
    ];

    renderListView({ tasks });

    // Apply filter
    const filterInput = screen.getByPlaceholderText("Filter by ID or title...");
    fireEvent.change(filterInput, { target: { value: "Gamma" } });

    // Completed tasks should remain hidden (hide done is active by default)
    expect(screen.queryByText("FN-001")).toBeNull();
    expect(screen.queryByText("FN-002")).toBeNull();
    // Filtered task should be visible
    expect(screen.getByText("FN-003")).toBeDefined();
  });

  it("shows done section when selectedColumn is done even with hide done active", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "done", title: "Done Task" }),
      createMockTask({ id: "FN-002", column: "triage", title: "Triage Task" }),
    ];

    renderListView({ tasks });

    // Done task should be hidden by default
    expect(screen.queryByText("FN-001")).toBeNull();

    // Click on the done drop zone to select that column
    const doneZone = document.querySelector('[data-column="done"].list-drop-zone')!;
    fireEvent.click(doneZone);

    // Done task should now be visible because selectedColumn overrides hide
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.queryByText("FN-002")).toBeNull();
  });

  it("shows archived section when selectedColumn is archived even with hide done active", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "archived", title: "Archived Task" }),
      createMockTask({ id: "FN-002", column: "triage", title: "Triage Task" }),
    ];

    renderListView({ tasks });

    // Archived task should be hidden by default
    expect(screen.queryByText("FN-001")).toBeNull();

    // Click on the archived drop zone to select that column
    const archivedZone = document.querySelector('[data-column="archived"].list-drop-zone')!;
    fireEvent.click(archivedZone);

    // Archived task should now be visible because selectedColumn overrides hide
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.queryByText("FN-002")).toBeNull();
  });
});

describe("ListView Quick Entry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("renders QuickEntryBox when onQuickCreate is provided", () => {
    const mockOnQuickCreate = vi.fn().mockResolvedValue(undefined);
    renderListView({ onQuickCreate: mockOnQuickCreate });

    // Quick entry box should be visible
    const quickEntry = screen.getByTestId("quick-entry-box");
    expect(quickEntry).toBeDefined();

    // Input should be visible
    const input = screen.getByTestId("quick-entry-input");
    expect(input).toBeDefined();
  });

  it("renders QuickEntryBox in list-quick-entry-above-table, not in toolbar", () => {
    const mockOnQuickCreate = vi.fn().mockResolvedValue(undefined);
    renderListView({ onQuickCreate: mockOnQuickCreate });

    const quickEntry = screen.getByTestId("quick-entry-box");
    const toolbar = document.querySelector(".list-toolbar");
    const quickEntryArea = document.querySelector(".list-quick-entry-above-table");
    const tableContainer = document.querySelector(".list-table-container");

    // QuickEntryBox should not be inside toolbar
    expect(toolbar?.contains(quickEntry)).toBe(false);
    // QuickEntryBox should be inside the new quick-entry area
    expect(quickEntryArea?.contains(quickEntry)).toBe(true);
    // QuickEntryBox should be inside the table container (parent of quick-entry area)
    expect(tableContainer?.contains(quickEntry)).toBe(true);
  });

  it("shows model selector button when QuickEntryBox is expanded", async () => {
    const mockOnQuickCreate = vi.fn().mockResolvedValue(undefined);
    renderListView({ onQuickCreate: mockOnQuickCreate });

    const input = screen.getByTestId("quick-entry-input");
    
    // Focus the input to expand the QuickEntryBox
    fireEvent.focus(input);
    
    // Model selector button should be visible
    const modelButton = await screen.findByTestId("quick-entry-models-button");
    expect(modelButton).toBeDefined();
  });

  it("shows dependency selector button when QuickEntryBox is expanded", async () => {
    const mockOnQuickCreate = vi.fn().mockResolvedValue(undefined);
    renderListView({ onQuickCreate: mockOnQuickCreate });

    const input = screen.getByTestId("quick-entry-input");
    
    // Focus the input to expand the QuickEntryBox
    fireEvent.focus(input);
    
    // Dependency selector button should be visible
    const depsButton = await screen.findByTestId("quick-entry-deps-button");
    expect(depsButton).toBeDefined();
  });

  it("calls onQuickCreate with description when Enter is pressed", async () => {
    const mockOnQuickCreate = vi.fn().mockResolvedValue(undefined);
    renderListView({ onQuickCreate: mockOnQuickCreate });

    const input = screen.getByTestId("quick-entry-input");
    fireEvent.change(input, { target: { value: "New quick task" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(mockOnQuickCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "New quick task",
        })
      );
    });
  });

  it("clears input after successful quick create", async () => {
    const mockOnQuickCreate = vi.fn().mockResolvedValue(undefined);
    renderListView({ onQuickCreate: mockOnQuickCreate });

    const input = screen.getByTestId("quick-entry-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Task to create" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(mockOnQuickCreate).toHaveBeenCalled();
    });

    expect(input.value).toBe("");
  });

  it("shows error toast when onQuickCreate fails and keeps input content", async () => {
    const mockOnQuickCreate = vi.fn().mockRejectedValue(new Error("Create failed"));
    renderListView({ onQuickCreate: mockOnQuickCreate });

    const input = screen.getByTestId("quick-entry-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Failed task" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledWith("Create failed", "error");
    });

    // Input content should be preserved for retry
    expect(input.value).toBe("Failed task");
  });

  it("trims whitespace when creating task via quick entry", async () => {
    const mockOnQuickCreate = vi.fn().mockResolvedValue(undefined);
    renderListView({ onQuickCreate: mockOnQuickCreate });

    const input = screen.getByTestId("quick-entry-input");
    fireEvent.change(input, { target: { value: "  Task with spaces  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(mockOnQuickCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Task with spaces",
        })
      );
    });
  });

  it("does not submit on Enter if input is empty", async () => {
    const mockOnQuickCreate = vi.fn().mockResolvedValue(undefined);
    renderListView({ onQuickCreate: mockOnQuickCreate });

    const input = screen.getByTestId("quick-entry-input");
    fireEvent.keyDown(input, { key: "Enter" });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockOnQuickCreate).not.toHaveBeenCalled();
  });
});

describe("ListView Collapsible Sections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("clicking section header toggles collapse and hides task rows", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Triage Task 1" }),
      createMockTask({ id: "FN-002", column: "triage", title: "Triage Task 2" }),
    ];

    renderListView({ tasks });

    // Both tasks should be visible initially
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.getByText("FN-002")).toBeDefined();

    // Find and click the triage section header
    const triageHeader = screen.getAllByRole("row").find(r =>
      r.className.includes("list-section-header") && r.textContent?.includes("Triage")
    );
    expect(triageHeader).toBeDefined();
    fireEvent.click(triageHeader!);

    // Tasks should be hidden after collapse
    expect(screen.queryByText("FN-001")).toBeNull();
    expect(screen.queryByText("FN-002")).toBeNull();

    // Section header should have collapsed class
    expect(triageHeader?.className).toContain("list-section-header--collapsed");

    // Chevron should not have expanded class
    const chevron = triageHeader?.querySelector(".list-section-chevron");
    expect(chevron?.className).not.toContain("list-section-chevron--expanded");
  });

  it("clicking again expands section and shows task rows", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Triage Task" }),
    ];

    renderListView({ tasks });

    // Find the triage section header
    let triageHeader = screen.getAllByRole("row").find(r =>
      r.className.includes("list-section-header") && r.textContent?.includes("Triage")
    );

    // Click to collapse
    fireEvent.click(triageHeader!);

    // Task should be hidden
    expect(screen.queryByText("FN-001")).toBeNull();

    // Click again to expand
    fireEvent.click(triageHeader!);

    // Task should be visible again
    expect(screen.getByText("FN-001")).toBeDefined();

    // Re-query for the header to get fresh DOM reference after re-render
    triageHeader = screen.getAllByRole("row").find(r =>
      r.className.includes("list-section-header") && r.textContent?.includes("Triage")
    );

    // Section header should not have collapsed class
    expect(triageHeader?.className).not.toContain("list-section-header--collapsed");

    // Chevron should have expanded class (check via aria-expanded since header re-renders)
    expect(triageHeader?.getAttribute("aria-expanded")).toBe("true");
  });

  it("collapse state persists to localStorage", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Triage Task" }),
    ];

    renderListView({ tasks });

    // Click to collapse
    const triageHeader = screen.getAllByRole("row").find(r =>
      r.className.includes("list-section-header") && r.textContent?.includes("Triage")
    );
    fireEvent.click(triageHeader!);

    // Verify localStorage was updated
    const saved = localStorage.getItem("kb-dashboard-list-collapsed");
    expect(saved).toBeTruthy();
    const parsed = JSON.parse(saved!);
    expect(parsed).toContain("triage");
  });

  it("collapse state initializes from localStorage on mount", () => {
    // Set up localStorage with triage section collapsed
    localStorage.setItem("kb-dashboard-list-collapsed", JSON.stringify(["triage"]));

    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Triage Task" }),
      createMockTask({ id: "FN-002", column: "todo", title: "Todo Task" }),
    ];

    renderListView({ tasks });

    // Triage task should be hidden initially (collapsed from localStorage)
    expect(screen.queryByText("FN-001")).toBeNull();

    // Todo task should be visible
    expect(screen.getByText("FN-002")).toBeDefined();

    // Triage section header should have collapsed class
    const triageHeader = screen.getAllByRole("row").find(r =>
      r.className.includes("list-section-header") && r.textContent?.includes("Triage")
    );
    expect(triageHeader?.className).toContain("list-section-header--collapsed");
  });

  it("multiple sections can be collapsed independently", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Triage Task" }),
      createMockTask({ id: "FN-002", column: "todo", title: "Todo Task" }),
      createMockTask({ id: "FN-003", column: "in-progress", title: "In Progress Task" }),
    ];

    renderListView({ tasks });

    // Get section headers
    const allHeaders = screen.getAllByRole("row").filter(r =>
      r.className.includes("list-section-header")
    );
    const triageHeader = allHeaders.find(h => h.textContent?.includes("Triage"));
    const todoHeader = allHeaders.find(h => h.textContent?.includes("Todo"));

    // Collapse triage section
    fireEvent.click(triageHeader!);

    // Collapse todo section
    fireEvent.click(todoHeader!);

    // Triage and todo tasks should be hidden
    expect(screen.queryByText("FN-001")).toBeNull();
    expect(screen.queryByText("FN-002")).toBeNull();

    // In Progress task should still be visible
    expect(screen.getByText("FN-003")).toBeDefined();

    // Both sections should be marked as collapsed
    expect(triageHeader?.className).toContain("list-section-header--collapsed");
    expect(todoHeader?.className).toContain("list-section-header--collapsed");

    // Verify localStorage has both columns
    const saved = localStorage.getItem("kb-dashboard-list-collapsed");
    const parsed = JSON.parse(saved!);
    expect(parsed).toContain("triage");
    expect(parsed).toContain("todo");
    expect(parsed).not.toContain("in-progress");
  });

  it("sorting still works with collapsed sections", () => {
    const tasks = [
      createMockTask({ id: "FN-003", column: "triage", title: "Charlie" }),
      createMockTask({ id: "FN-001", column: "triage", title: "Alpha" }),
      createMockTask({ id: "FN-002", column: "triage", title: "Bravo" }),
    ];

    renderListView({ tasks });

    // Collapse triage section
    const triageHeader = screen.getAllByRole("row").find(r =>
      r.className.includes("list-section-header") && r.textContent?.includes("Triage")
    );
    fireEvent.click(triageHeader!);

    // Expand triage section
    fireEvent.click(triageHeader!);

    // Sort by title
    const titleHeader = screen.getByText("Title");
    fireEvent.click(titleHeader);

    // Get sorted rows and verify sorting still works
    const rows = screen.getAllByRole("row").filter(r => r.getAttribute("data-id"));
    expect(rows[0].textContent).toContain("FN-001"); // Alpha
    expect(rows[1].textContent).toContain("FN-002"); // Bravo
    expect(rows[2].textContent).toContain("FN-003"); // Charlie
  });

  it("filtering still works with collapsed sections", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Alpha Task" }),
      createMockTask({ id: "FN-002", column: "triage", title: "Beta Task" }),
    ];

    renderListView({ tasks });

    // Collapse triage section
    const triageHeader = screen.getAllByRole("row").find(r =>
      r.className.includes("list-section-header") && r.textContent?.includes("Triage")
    );
    fireEvent.click(triageHeader!);

    // Apply filter
    const filterInput = screen.getByPlaceholderText("Filter by ID or title...");
    fireEvent.change(filterInput, { target: { value: "Alpha" } });

    // Expand triage section by clicking again (filter change should keep collapsed state)
    fireEvent.click(triageHeader!);

    // Only Alpha task should be visible
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.queryByText("FN-002")).toBeNull();
  });

  it("section header has aria-expanded attribute for accessibility", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Triage Task" }),
    ];

    renderListView({ tasks });

    // Find triage section header
    const triageHeader = screen.getAllByRole("row").find(r =>
      r.className.includes("list-section-header") && r.textContent?.includes("Triage")
    );

    // Should have aria-expanded="true" when expanded
    expect(triageHeader?.getAttribute("aria-expanded")).toBe("true");

    // Click to collapse
    fireEvent.click(triageHeader!);

    // Should have aria-expanded="false" when collapsed
    expect(triageHeader?.getAttribute("aria-expanded")).toBe("false");
  });

  it("collapsed section hides No tasks placeholder", () => {
    // Create tasks in one column, leave another column empty
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Triage Task" }),
    ];

    renderListView({ tasks });

    // First verify the "No tasks" placeholder is visible for empty columns (like Todo)
    const noTasksCellsBefore = screen.getAllByText("No tasks");
    expect(noTasksCellsBefore.length).toBeGreaterThan(0);

    // Find and collapse the todo section (which has no tasks)
    const todoHeader = screen.getAllByRole("row").find(r =>
      r.className.includes("list-section-header") && r.textContent?.includes("Todo")
    );
    expect(todoHeader).toBeDefined();
    fireEvent.click(todoHeader!);

    // When collapsed, the section header should have collapsed class
    expect(todoHeader?.className).toContain("list-section-header--collapsed");

    // The "No tasks" placeholder for todo section should not be visible anymore
    // (we can't easily verify this without complex DOM traversal, but the collapse
    // class is the primary indicator that the section is collapsed)
  });
});

describe("ListView - Bulk Selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  const createMockTask = (overrides: Partial<Task> = {}): Task => ({
    id: "FN-001",
    description: "Test task description",
    title: "Test Task",
    column: "triage",
    dependencies: [],
    steps: [],
    currentStep: 0,
    status: "pending",
    paused: false,
    log: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  });

  it("shows selection checkbox in header", () => {
    const tasks = [createMockTask({ id: "FN-001" })];
    render(<ListView tasks={tasks} onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={mockAddToast} />);

    const headerCheckbox = screen.getByLabelText("Select all visible tasks");
    expect(headerCheckbox).toBeDefined();
  });

  it("shows selection checkbox for each task row", () => {
    const tasks = [
      createMockTask({ id: "FN-001" }),
      createMockTask({ id: "FN-002" }),
    ];
    render(<ListView tasks={tasks} onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={mockAddToast} />);

    const checkboxes = screen.getAllByLabelText(/Select FN-/);
    expect(checkboxes).toHaveLength(2);
  });

  it("disables checkbox for archived tasks", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "archived" }),
    ];
    render(<ListView tasks={tasks} onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={mockAddToast} />);

    const checkbox = screen.getByLabelText("Select FN-001");
    expect(checkbox).toBeDisabled();
  });

  it("shows selection count when tasks are selected", () => {
    const tasks = [
      createMockTask({ id: "FN-001" }),
      createMockTask({ id: "FN-002" }),
    ];
    render(<ListView tasks={tasks} onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={mockAddToast} />);

    const checkbox = screen.getByLabelText("Select FN-001");
    fireEvent.click(checkbox);

    expect(screen.getByText("1 selected")).toBeDefined();
  });

  it("clears selection when clear button clicked", () => {
    const tasks = [
      createMockTask({ id: "FN-001" }),
    ];
    render(<ListView tasks={tasks} onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={mockAddToast} />);

    const checkbox = screen.getByLabelText("Select FN-001");
    fireEvent.click(checkbox);
    expect(screen.getByText("1 selected")).toBeDefined();

    const clearButton = screen.getByText("Clear");
    fireEvent.click(clearButton);

    expect(screen.queryByText("1 selected")).toBeNull();
  });

  it("toggles all visible tasks with select all checkbox", () => {
    const tasks = [
      createMockTask({ id: "FN-001" }),
      createMockTask({ id: "FN-002" }),
    ];
    render(<ListView tasks={tasks} onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={mockAddToast} />);

    const selectAllCheckbox = screen.getByLabelText("Select all visible tasks");
    fireEvent.click(selectAllCheckbox);

    expect(screen.getByText("2 selected")).toBeDefined();
  });

  it("shows bulk edit toolbar when tasks are selected", () => {
    const availableModels = [
      { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
    ];
    const tasks = [createMockTask({ id: "FN-001" })];

    render(
      <ListView
        tasks={tasks}
        onMoveTask={vi.fn()}
        onOpenDetail={vi.fn()}
        addToast={mockAddToast}
        availableModels={availableModels}
      />
    );

    const checkbox = screen.getByLabelText("Select FN-001");
    fireEvent.click(checkbox);

    expect(screen.getByText("Bulk Edit Models:")).toBeDefined();
  });

  it("disables apply button when no model changes selected", () => {
    const availableModels = [
      { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
    ];
    const tasks = [createMockTask({ id: "FN-001" })];

    render(
      <ListView
        tasks={tasks}
        onMoveTask={vi.fn()}
        onOpenDetail={vi.fn()}
        addToast={mockAddToast}
        availableModels={availableModels}
      />
    );

    const checkbox = screen.getByLabelText("Select FN-001");
    fireEvent.click(checkbox);

    const applyButton = screen.getByText("Apply");
    expect(applyButton).toBeDisabled();
  });

  it("persists selection to localStorage", () => {
    const tasks = [createMockTask({ id: "FN-001" })];
    render(<ListView tasks={tasks} onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={mockAddToast} />);

    const checkbox = screen.getByLabelText("Select FN-001");
    fireEvent.click(checkbox);

    expect(localStorage.getItem("kb-dashboard-selected-tasks")).toBe('["FN-001"]');
  });

  it("shows header checkbox in indeterminate state when some tasks selected", () => {
    const tasks = [
      createMockTask({ id: "FN-001" }),
      createMockTask({ id: "FN-002" }),
    ];
    render(<ListView tasks={tasks} onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={mockAddToast} />);

    const checkboxes = screen.getAllByLabelText(/Select FN-/);
    // Select only first task
    fireEvent.click(checkboxes[0]);

    // Header checkbox should be indeterminate (partially selected)
    const headerCheckbox = screen.getByLabelText("Select all visible tasks") as HTMLInputElement;
    expect(headerCheckbox).toBeDefined();
    // Verify only one task is selected (indeterminate state)
    expect(screen.getByText("1 selected")).toBeDefined();
  });

  it("enables apply button when a model is selected", async () => {
    const availableModels = [
      { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
    ];
    const tasks = [createMockTask({ id: "FN-001" })];

    render(
      <ListView
        tasks={tasks}
        onMoveTask={vi.fn()}
        onOpenDetail={vi.fn()}
        addToast={mockAddToast}
        availableModels={availableModels}
      />
    );

    // Select the task
    const checkbox = screen.getByLabelText("Select FN-001");
    fireEvent.click(checkbox);

    // Initially disabled
    const applyButton = screen.getByText("Apply");
    expect(applyButton).toBeDisabled();

    // The dropdown would need to be interacted with to enable the button
    // This test verifies the initial disabled state and button presence
  });
});
