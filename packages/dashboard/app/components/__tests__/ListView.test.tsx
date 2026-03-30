import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { ListView } from "../ListView";
import type { Task, TaskDetail } from "@kb/core";

// Mock the API
vi.mock("../../api", () => ({
  fetchTaskDetail: vi.fn(),
}));

import { fetchTaskDetail } from "../../api";

const mockAddToast = vi.fn();

const createMockTask = (overrides: Partial<Task> = {}): Task => ({
  id: "KB-001",
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
  });

  it("renders without crashing", () => {
    renderListView();
    expect(screen.getByPlaceholderText("Filter by ID or title...")).toBeDefined();
  });

  it("displays tasks in table format", () => {
    const tasks = [
      createMockTask({ id: "KB-001", title: "First Task" }),
      createMockTask({ id: "KB-002", title: "Second Task" }),
    ];

    renderListView({ tasks });

    expect(screen.getByText("KB-001")).toBeDefined();
    expect(screen.getByText("First Task")).toBeDefined();
    expect(screen.getByText("KB-002")).toBeDefined();
    expect(screen.getByText("Second Task")).toBeDefined();
  });

  it("shows empty state when no tasks", () => {
    renderListView({ tasks: [] });
    expect(screen.getByText("No tasks yet")).toBeDefined();
  });

  it("shows empty state when filter matches nothing", () => {
    const tasks = [createMockTask({ id: "KB-001", title: "Test Task" })];

    renderListView({ tasks });

    const filterInput = screen.getByPlaceholderText("Filter by ID or title...");
    fireEvent.change(filterInput, { target: { value: "nonexistent" } });

    expect(screen.getByText("No tasks match your filter")).toBeDefined();
  });

  it("filters tasks by ID", () => {
    const tasks = [
      createMockTask({ id: "KB-001", title: "First Task" }),
      createMockTask({ id: "KB-002", title: "Second Task" }),
    ];

    renderListView({ tasks });

    const filterInput = screen.getByPlaceholderText("Filter by ID or title...");
    fireEvent.change(filterInput, { target: { value: "KB-001" } });

    expect(screen.getByText("KB-001")).toBeDefined();
    expect(screen.queryByText("KB-002")).toBeNull();
  });

  it("filters tasks by title", () => {
    const tasks = [
      createMockTask({ id: "KB-001", title: "First Task" }),
      createMockTask({ id: "KB-002", title: "Second Task" }),
    ];

    renderListView({ tasks });

    const filterInput = screen.getByPlaceholderText("Filter by ID or title...");
    fireEvent.change(filterInput, { target: { value: "Second" } });

    expect(screen.queryByText("KB-001")).toBeNull();
    expect(screen.getByText("KB-002")).toBeDefined();
  });

  it("filters tasks by description when no title", () => {
    const tasks = [
      createMockTask({ id: "KB-001", title: undefined, description: "Alpha description" }),
      createMockTask({ id: "KB-002", title: undefined, description: "Beta description" }),
    ];

    renderListView({ tasks });

    const filterInput = screen.getByPlaceholderText("Filter by ID or title...");
    fireEvent.change(filterInput, { target: { value: "Alpha" } });

    expect(screen.getByText("KB-001")).toBeDefined();
    expect(screen.queryByText("KB-002")).toBeNull();
  });

  it("clears filter when clear button is clicked", () => {
    const tasks = [
      createMockTask({ id: "KB-001", title: "First Task" }),
      createMockTask({ id: "KB-002", title: "Second Task" }),
    ];

    renderListView({ tasks });

    const filterInput = screen.getByPlaceholderText("Filter by ID or title...");
    fireEvent.change(filterInput, { target: { value: "KB-001" } });

    // Wait for filter to apply
    expect(screen.queryByText("KB-002")).toBeNull();

    // Click clear button (×)
    const clearButton = screen.getByText("×");
    fireEvent.click(clearButton);

    // Both tasks should be visible again
    expect(screen.getByText("KB-001")).toBeDefined();
    expect(screen.getByText("KB-002")).toBeDefined();
  });

  it("calls onOpenDetail when row is clicked", async () => {
    const tasks = [createMockTask({ id: "KB-001", title: "Test Task" })];
    const mockOnOpenDetail = vi.fn();
    const mockDetail: TaskDetail = {
      ...tasks[0],
      prompt: "Test prompt",
    };

    (fetchTaskDetail as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockDetail);

    renderListView({ tasks, onOpenDetail: mockOnOpenDetail });

    const row = screen.getByText("KB-001").closest("tr");
    fireEvent.click(row!);

    await waitFor(() => {
      expect(fetchTaskDetail).toHaveBeenCalledWith("KB-001");
    });

    expect(mockOnOpenDetail).toHaveBeenCalledWith(mockDetail);
  });

  it("shows error toast when fetchTaskDetail fails", async () => {
    const tasks = [createMockTask({ id: "KB-001", title: "Test Task" })];
    const mockOnOpenDetail = vi.fn();

    (fetchTaskDetail as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Network error"));

    renderListView({ tasks, onOpenDetail: mockOnOpenDetail });

    const row = screen.getByText("KB-001").closest("tr");
    fireEvent.click(row!);

    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledWith("Failed to load task details", "error");
    });
  });

  it("sorts tasks by ID when ID header is clicked", () => {
    const tasks = [
      createMockTask({ id: "KB-003", title: "Third", column: "triage" }),
      createMockTask({ id: "KB-001", title: "First", column: "triage" }),
      createMockTask({ id: "KB-002", title: "Second", column: "triage" }),
    ];

    renderListView({ tasks });

    // First click - ascending
    const idHeader = screen.getByText("ID");
    fireEvent.click(idHeader);

    // Get all data rows (excluding section headers by using data-id attribute)
    const rows = screen.getAllByRole("row").filter(r => r.getAttribute("data-id"));
    expect(rows[0].textContent).toContain("KB-001");
    expect(rows[1].textContent).toContain("KB-002");
    expect(rows[2].textContent).toContain("KB-003");

    // Second click - descending
    fireEvent.click(idHeader);

    const rowsDesc = screen.getAllByRole("row").filter(r => r.getAttribute("data-id"));
    expect(rowsDesc[0].textContent).toContain("KB-003");
    expect(rowsDesc[1].textContent).toContain("KB-002");
    expect(rowsDesc[2].textContent).toContain("KB-001");
  });

  it("sorts tasks by column when Column header is clicked", () => {
    const tasks = [
      createMockTask({ id: "KB-001", column: "done" }),
      createMockTask({ id: "KB-002", column: "triage" }),
      createMockTask({ id: "KB-003", column: "in-progress" }),
    ];

    renderListView({ tasks });

    const columnHeader = screen.getByText("Column");
    fireEvent.click(columnHeader);

    // Get data rows - sorted by column alphabetically: done, in-progress, triage
    const rows = screen.getAllByRole("row").filter(r => r.getAttribute("data-id"));
    expect(rows[0].textContent).toContain("KB-002"); // triage (sorted first alphabetically)
    expect(rows[1].textContent).toContain("KB-003"); // in-progress
    expect(rows[2].textContent).toContain("KB-001"); // done
  });

  it("sorts tasks by status when Status header is clicked", () => {
    const tasks = [
      createMockTask({ id: "KB-001", status: "executing", column: "triage" }),
      createMockTask({ id: "KB-002", status: "pending", column: "triage" }),
      createMockTask({ id: "KB-003", status: "failed", column: "triage" }),
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
    const tasks = [createMockTask({ id: "KB-001", status: "failed" })];

    renderListView({ tasks });

    const row = screen.getByText("KB-001").closest("tr");
    expect(row?.className).toContain("failed");

    const statusBadge = screen.getByText("failed");
    expect(statusBadge.className).toContain("failed");
  });

  it("renders paused tasks with dimmed styling", () => {
    const tasks = [createMockTask({ id: "KB-001", paused: true })];

    renderListView({ tasks });

    const row = screen.getByText("KB-001").closest("tr");
    expect(row?.className).toContain("paused");
  });

  it("renders agent-active tasks with glow styling", () => {
    const tasks = [
      createMockTask({
        id: "KB-001",
        status: "executing",
        column: "in-progress",
      }),
    ];

    renderListView({ tasks, globalPaused: false });

    const row = screen.getByText("KB-001").closest("tr");
    expect(row?.className).toContain("agent-active");
  });

  it("does not render agent-active when globalPaused is true", () => {
    const tasks = [
      createMockTask({
        id: "KB-001",
        status: "executing",
        column: "in-progress",
      }),
    ];

    renderListView({ tasks, globalPaused: true });

    const row = screen.getByText("KB-001").closest("tr");
    expect(row?.className).not.toContain("agent-active");
  });

  it("renders column badges with correct colors", () => {
    const columns = ["triage", "todo", "in-progress", "in-review", "done"] as const;

    const tasks = columns.map((col, i) =>
      createMockTask({ id: `KB-00${i + 1}`, column: col })
    );

    renderListView({ tasks });

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
        id: "KB-001",
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
    const tasks = [createMockTask({ id: "KB-001", steps: [] })];

    renderListView({ tasks });

    // Find the task row and check its progress cell
    const row = screen.getByText("KB-001").closest("tr")!;
    const progressCell = row.querySelector(".list-cell-progress");
    expect(progressCell?.textContent).toBe("-");
  });

  it("renders dependency count with icon", () => {
    const tasks = [
      createMockTask({
        id: "KB-001",
        dependencies: ["KB-002", "KB-003"],
      }),
    ];

    renderListView({ tasks });

    expect(screen.getByText("2")).toBeDefined();
  });

  it("shows - for tasks with no dependencies", () => {
    const tasks = [createMockTask({ id: "KB-001", dependencies: [] })];

    renderListView({ tasks });

    const depCells = screen.getAllByRole("cell");
    // Find the cell that should contain deps (7th column)
    const depCell = depCells[6];
    expect(depCell.textContent).toBe("-");
  });

  it("displays correct task count in stats", () => {
    const tasks = [
      createMockTask({ id: "KB-001" }),
      createMockTask({ id: "KB-002" }),
      createMockTask({ id: "KB-003" }),
    ];

    renderListView({ tasks });

    expect(screen.getByText("3 of 3 tasks")).toBeDefined();
  });

  it("displays filtered task count in stats", () => {
    const tasks = [
      createMockTask({ id: "KB-001", title: "Alpha" }),
      createMockTask({ id: "KB-002", title: "Beta" }),
      createMockTask({ id: "KB-003", title: "Gamma" }),
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
      createMockTask({ id: "KB-001", column: "triage" }),
      createMockTask({ id: "KB-002", column: "triage" }),
      createMockTask({ id: "KB-003", column: "todo" }),
    ];

    renderListView({ tasks });

    // Use querySelector to find drop zones by data-column attribute
    const triageZone = document.querySelector('[data-column="triage"]');
    expect(triageZone?.textContent).toContain("2");

    const todoZone = document.querySelector('[data-column="todo"]');
    expect(todoZone?.textContent).toContain("1");
  });

  it("handles drag and drop to move tasks between columns", async () => {
    const tasks = [createMockTask({ id: "KB-001", column: "triage" })];
    const mockOnMoveTask = vi.fn(() => Promise.resolve(tasks[0]));

    renderListView({ tasks, onMoveTask: mockOnMoveTask });

    const row = screen.getByText("KB-001").closest("tr")!;

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
        getData: vi.fn(() => "KB-001"),
      },
    });

    await waitFor(() => {
      expect(mockOnMoveTask).toHaveBeenCalledWith("KB-001", "todo");
    });
  });

  it("does not set draggable for paused tasks", () => {
    const tasks = [createMockTask({ id: "KB-001", paused: true })];

    renderListView({ tasks });

    const row = screen.getByText("KB-001").closest("tr")!;
    // Paused tasks should have draggable="false"
    expect(row.getAttribute("draggable")).toBe("false");
  });

  it("sets draggable for non-paused tasks", () => {
    const tasks = [createMockTask({ id: "KB-001", paused: false })];

    renderListView({ tasks });

    const row = screen.getByText("KB-001").closest("tr")!;
    // Non-paused tasks should have draggable="true"
    expect(row.getAttribute("draggable")).toBe("true");
  });

  it("shows error toast when onMoveTask fails during drag and drop", async () => {
    const tasks = [createMockTask({ id: "KB-001", column: "triage" })];
    const mockOnMoveTask = vi.fn(() => Promise.reject(new Error("Move failed")));

    renderListView({ tasks, onMoveTask: mockOnMoveTask });

    const row = screen.getByText("KB-001").closest("tr")!;

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
        getData: vi.fn(() => "KB-001"),
      },
    });

    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledWith("Move failed", "error");
    });
  });

  it("formats dates correctly", () => {
    const tasks = [
      createMockTask({
        id: "KB-001",
        createdAt: "2024-03-15T10:30:00Z",
        updatedAt: "2024-03-16T14:45:00Z",
      }),
    ];

    renderListView({ tasks });

    // Check that dates are formatted and displayed
    const cells = screen.getAllByRole("cell");
    // Created and Updated are columns 5 and 6 (0-indexed: 4 and 5)
    const createdCell = cells[4];
    const updatedCell = cells[5];

    // Should contain formatted dates with time
    expect(createdCell.textContent).toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/);
    expect(updatedCell.textContent).toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/);
  });

  it("truncates long descriptions in title cell", () => {
    const longDescription = "A".repeat(100);
    const tasks = [createMockTask({ id: "KB-001", title: undefined, description: longDescription })];

    renderListView({ tasks });

    const titleCell = screen.getByText(/A{60}/).closest("td")!;
    expect(titleCell.textContent).toContain("…");
    expect(titleCell.textContent?.length).toBeLessThan(longDescription.length);
  });

  // Grouped view tests
  it("renders section headers for each column", () => {
    const tasks = [
      createMockTask({ id: "KB-001", column: "triage" }),
      createMockTask({ id: "KB-002", column: "todo" }),
    ];

    renderListView({ tasks });

    // Check that section headers are rendered with column names
    expect(screen.getAllByText("Triage").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Todo").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("In Progress").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("In Review").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Done").length).toBeGreaterThanOrEqual(1);
  });

  it("displays correct task count in section headers", () => {
    const tasks = [
      createMockTask({ id: "KB-001", column: "triage" }),
      createMockTask({ id: "KB-002", column: "triage" }),
      createMockTask({ id: "KB-003", column: "todo" }),
    ];

    renderListView({ tasks });

    // Find section headers by their structure
    const sectionHeaders = screen.getAllByRole("row").filter(r => r.className.includes("list-section-header"));
    expect(sectionHeaders.length).toBe(5); // One for each column

    // Check that triage section shows count of 2
    const triageHeader = sectionHeaders.find(h => h.textContent?.includes("Triage"));
    expect(triageHeader?.textContent).toContain("2");

    // Check that todo section shows count of 1
    const todoHeader = sectionHeaders.find(h => h.textContent?.includes("Todo"));
    expect(todoHeader?.textContent).toContain("1");
  });

  it("shows No tasks placeholder for empty columns", () => {
    const tasks = [createMockTask({ id: "KB-001", column: "triage" })];

    renderListView({ tasks });

    // Should show "No tasks" for empty columns
    const noTasksCells = screen.getAllByText("No tasks");
    expect(noTasksCells.length).toBeGreaterThanOrEqual(1);
  });

  it("hides empty sections when filter is active", () => {
    const tasks = [
      createMockTask({ id: "KB-001", title: "Alpha Task", column: "triage" }),
      createMockTask({ id: "KB-002", title: "Beta Task", column: "todo" }),
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
    expect(screen.getByText("KB-001")).toBeDefined();
    expect(screen.queryByText("KB-002")).toBeNull();
  });

  it("maintains sort order within each section", () => {
    const tasks = [
      createMockTask({ id: "KB-003", title: "Charlie", column: "triage" }),
      createMockTask({ id: "KB-001", title: "Alpha", column: "triage" }),
      createMockTask({ id: "KB-002", title: "Bravo", column: "triage" }),
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
    
    expect(dataRows[0].textContent).toContain("KB-001"); // Alpha
    expect(dataRows[1].textContent).toContain("KB-002"); // Bravo
    expect(dataRows[2].textContent).toContain("KB-003"); // Charlie
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
    expect(screen.getByText("Created")).toBeDefined();
    expect(screen.getByText("Updated")).toBeDefined();
    expect(screen.getByText("Dependencies")).toBeDefined();
    expect(screen.getByText("Progress")).toBeDefined();
  });

  it("hides column when unchecked in dropdown", () => {
    const tasks = [createMockTask({ id: "KB-001", title: "Test Task" })];
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
    const tasks = [createMockTask({ id: "KB-001", title: "Test Task" })];
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
    const tasks = [createMockTask({ id: "KB-001", title: "Test Task" })];
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

    const tasks = [createMockTask({ id: "KB-001", title: "Test Task", status: "pending" })];
    renderListView({ tasks });

    // ID should be visible
    expect(screen.getByText("KB-001")).toBeDefined();

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
      createMockTask({ id: "KB-003", column: "triage" }),
      createMockTask({ id: "KB-001", column: "triage" }),
      createMockTask({ id: "KB-002", column: "triage" }),
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
    expect(rows[0].textContent).toContain("KB-001");
    expect(rows[1].textContent).toContain("KB-002");
    expect(rows[2].textContent).toContain("KB-003");
  });

  it("all columns visible by default when no localStorage", () => {
    const tasks = [
      createMockTask({ id: "KB-001", title: "Test Task", status: "pending", column: "triage" }),
    ];
    renderListView({ tasks });

    // All columns should be visible by default
    expect(screen.getByText("KB-001")).toBeDefined();
    expect(screen.getByText("Test Task")).toBeDefined();
    expect(screen.getByText("pending")).toBeDefined();
    // Check for column badge specifically using the class
    const columnBadge = document.querySelector(".list-column-badge");
    expect(columnBadge?.textContent).toContain("Triage");
  });
});

describe("ListView Collapsible Sections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear localStorage before each test
    localStorage.clear();
  });

  it("collapses and expands section when header is clicked", () => {
    const tasks = [
      createMockTask({ id: "KB-001", title: "Task 1", column: "triage" }),
      createMockTask({ id: "KB-002", title: "Task 2", column: "triage" }),
    ];

    renderListView({ tasks });

    // Initially, task should be visible
    expect(screen.getByText("KB-001")).toBeDefined();
    expect(screen.getByText("KB-002")).toBeDefined();

    // Find and click the triage section header
    const sectionHeaders = screen.getAllByRole("row").filter(r => r.className.includes("list-section-header"));
    const triageHeader = sectionHeaders.find(h => h.textContent?.includes("Triage"));
    expect(triageHeader).toBeDefined();
    fireEvent.click(triageHeader!);

    // After collapse, tasks should be hidden but header still visible
    expect(screen.queryByText("KB-001")).toBeNull();
    expect(screen.queryByText("KB-002")).toBeNull();
    expect(triageHeader).toBeDefined();

    // Click header again to expand
    fireEvent.click(triageHeader!);

    // Tasks should be visible again
    expect(screen.getByText("KB-001")).toBeDefined();
    expect(screen.getByText("KB-002")).toBeDefined();
  });

  it("persists section expansion state to localStorage", () => {
    const tasks = [
      createMockTask({ id: "KB-001", title: "Task 1", column: "triage" }),
    ];

    renderListView({ tasks });

    // Collapse the triage section
    const sectionHeaders = screen.getAllByRole("row").filter(r => r.className.includes("list-section-header"));
    const triageHeader = sectionHeaders.find(h => h.textContent?.includes("Triage"));
    fireEvent.click(triageHeader!);

    // Verify localStorage was updated with only expanded columns
    const saved = localStorage.getItem("kb-dashboard-list-sections");
    expect(saved).toBeTruthy();
    const parsed = JSON.parse(saved!) as string[];
    expect(parsed).not.toContain("triage");
    // Other columns should still be expanded
    expect(parsed).toContain("todo");
    expect(parsed).toContain("in-progress");
    expect(parsed).toContain("in-review");
    expect(parsed).toContain("done");
  });

  it("restores section expansion state from localStorage on mount", () => {
    // Set up localStorage with only todo expanded (triage collapsed)
    localStorage.setItem("kb-dashboard-list-sections", JSON.stringify(["todo", "in-progress", "in-review", "done"]));

    const tasks = [
      createMockTask({ id: "KB-001", title: "Triage Task", column: "triage" }),
      createMockTask({ id: "KB-002", title: "Todo Task", column: "todo" }),
    ];

    renderListView({ tasks });

    // Triage task should be hidden (collapsed)
    expect(screen.queryByText("KB-001")).toBeNull();

    // Todo task should be visible (expanded)
    expect(screen.getByText("KB-002")).toBeDefined();

    // Triage header should still be visible with collapsed styling
    const triageHeader = screen.getAllByRole("row")
      .find(r => r.className.includes("list-section-header") && r.textContent?.includes("Triage"));
    expect(triageHeader).toBeDefined();
    expect(triageHeader?.className).toContain("list-section-header--collapsed");
  });

  it("expand all button expands all collapsed sections", () => {
    const tasks = [
      createMockTask({ id: "KB-001", title: "Triage Task", column: "triage" }),
      createMockTask({ id: "KB-002", title: "Todo Task", column: "todo" }),
    ];

    renderListView({ tasks });

    // Collapse triage section
    const sectionHeaders = screen.getAllByRole("row").filter(r => r.className.includes("list-section-header"));
    const triageHeader = sectionHeaders.find(h => h.textContent?.includes("Triage"));
    fireEvent.click(triageHeader!);

    // Verify triage task is hidden
    expect(screen.queryByText("KB-001")).toBeNull();

    // Click Expand All button
    const expandAllButton = screen.getByText("Expand All");
    fireEvent.click(expandAllButton);

    // All tasks should be visible now
    expect(screen.getByText("KB-001")).toBeDefined();
    expect(screen.getByText("KB-002")).toBeDefined();

    // Verify localStorage has all columns
    const saved = localStorage.getItem("kb-dashboard-list-sections");
    const parsed = JSON.parse(saved!) as string[];
    expect(parsed).toContain("triage");
    expect(parsed).toContain("todo");
  });

  it("collapse all button collapses all expanded sections", () => {
    const tasks = [
      createMockTask({ id: "KB-001", title: "Triage Task", column: "triage" }),
      createMockTask({ id: "KB-002", title: "Todo Task", column: "todo" }),
    ];

    renderListView({ tasks });

    // Initially tasks should be visible
    expect(screen.getByText("KB-001")).toBeDefined();
    expect(screen.getByText("KB-002")).toBeDefined();

    // Click Collapse All button
    const collapseAllButton = screen.getByText("Collapse All");
    fireEvent.click(collapseAllButton);

    // All tasks should be hidden now
    expect(screen.queryByText("KB-001")).toBeNull();
    expect(screen.queryByText("KB-002")).toBeNull();

    // Section headers should still be visible
    const sectionHeaders = screen.getAllByRole("row").filter(r => r.className.includes("list-section-header"));
    expect(sectionHeaders.length).toBe(5); // All 5 columns

    // Verify localStorage is empty (no expanded sections)
    const saved = localStorage.getItem("kb-dashboard-list-sections");
    const parsed = JSON.parse(saved!) as string[];
    expect(parsed.length).toBe(0);
  });

  it("collapsed sections hide task rows but keep header visible", () => {
    const tasks = [
      createMockTask({ id: "KB-001", title: "Task 1", column: "triage" }),
    ];

    renderListView({ tasks });

    // Get the triage section header
    const sectionHeaders = screen.getAllByRole("row").filter(r => r.className.includes("list-section-header"));
    const triageHeader = sectionHeaders.find(h => h.textContent?.includes("Triage"));
    expect(triageHeader).toBeDefined();

    // Verify task is visible before collapse
    expect(screen.getByText("KB-001")).toBeDefined();

    // Collapse the section
    fireEvent.click(triageHeader!);

    // Header should still be visible
    expect(triageHeader).toBeDefined();
    // But with collapsed class
    expect(triageHeader?.className).toContain("list-section-header--collapsed");

    // Task should be hidden
    expect(screen.queryByText("KB-001")).toBeNull();

    // Count badge should still show "1 task"
    expect(triageHeader?.textContent).toContain("1 task");
  });

  it("drag and drop still works in expanded sections", () => {
    const tasks = [createMockTask({ id: "KB-001", column: "triage" })];
    const mockOnMoveTask = vi.fn(() => Promise.resolve(tasks[0]));

    renderListView({ tasks, onMoveTask: mockOnMoveTask });

    // Find the task row
    const row = screen.getByText("KB-001").closest("tr")!;

    // Simulate drag start
    fireEvent.dragStart(row, {
      dataTransfer: {
        setData: vi.fn(),
        effectAllowed: "move",
      },
    });

    // Simulate drop on todo column drop zone
    const todoZone = document.querySelector('[data-column="todo"].list-drop-zone')!;
    fireEvent.drop(todoZone, {
      preventDefault: vi.fn(),
      dataTransfer: {
        getData: vi.fn(() => "KB-001"),
      },
    });

    // Verify onMoveTask was called
    expect(mockOnMoveTask).toHaveBeenCalledWith("KB-001", "todo");
  });

  it("shows No tasks placeholder for empty expanded sections", () => {
    // Create tasks only in triage, so other columns show "No tasks" placeholders
    const tasks = [createMockTask({ id: "KB-001", column: "triage" })];

    renderListView({ tasks });

    // Should see 4 "No tasks" placeholders for empty columns (todo, in-progress, in-review, done)
    const noTasksCells = screen.getAllByText("No tasks");
    expect(noTasksCells.length).toBe(4);
  });

  it("hides No tasks placeholder when section is collapsed", () => {
    // Create tasks only in triage
    const tasks = [createMockTask({ id: "KB-001", column: "triage" })];

    renderListView({ tasks });

    // Initially 4 sections show "No tasks" (todo, in-progress, in-review, done)
    let noTasksCells = screen.getAllByText("No tasks");
    expect(noTasksCells.length).toBe(4);

    // Collapse the todo section (which has "No tasks" placeholder)
    const sectionHeaders = screen.getAllByRole("row").filter(r => r.className.includes("list-section-header"));
    const todoHeader = sectionHeaders.find(h => h.textContent?.includes("Todo"));
    fireEvent.click(todoHeader!);

    // Now should only show 3 "No tasks" placeholders (todo is collapsed)
    noTasksCells = screen.getAllByText("No tasks");
    expect(noTasksCells.length).toBe(3);
  });

  it("all sections expanded by default when no localStorage", () => {
    const tasks = [
      createMockTask({ id: "KB-001", column: "triage" }),
      createMockTask({ id: "KB-002", column: "todo" }),
    ];

    renderListView({ tasks });

    // All tasks should be visible by default
    expect(screen.getByText("KB-001")).toBeDefined();
    expect(screen.getByText("KB-002")).toBeDefined();

    // Verify localStorage was initialized with all columns
    const saved = localStorage.getItem("kb-dashboard-list-sections");
    expect(saved).toBeTruthy();
    const parsed = JSON.parse(saved!) as string[];
    expect(parsed).toContain("triage");
    expect(parsed).toContain("todo");
    expect(parsed).toContain("in-progress");
    expect(parsed).toContain("in-review");
    expect(parsed).toContain("done");
  });
});
