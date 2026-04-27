import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TodoView } from "../TodoView";

const mockUseTodoLists = vi.fn();

vi.mock("../../hooks/useTodoLists", () => ({
  useTodoLists: (...args: unknown[]) => mockUseTodoLists(...args),
}));

const mockConfirm = vi.fn();

vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: mockConfirm }),
}));

vi.mock("lucide-react", () => ({
  Plus: () => <span data-testid="icon-plus" />,
  Trash2: () => <span data-testid="icon-trash" />,
  Pencil: () => <span data-testid="icon-pencil" />,
  Check: () => <span data-testid="icon-check" />,
  X: () => <span data-testid="icon-x" />,
  ChevronUp: () => <span data-testid="icon-chevron-up" />,
  ChevronDown: () => <span data-testid="icon-chevron-down" />,
  Loader2: () => <span data-testid="icon-loader" />,
  ListChecks: () => <span data-testid="icon-list-checks" />,
}));

function createMockTodoLists(overrides: Record<string, unknown> = {}) {
  return {
    lists: [
      { id: "list-1", title: "My List", createdAt: "2026-04-25T00:00:00.000Z" },
      { id: "list-2", title: "Work Tasks", createdAt: "2026-04-25T00:00:00.000Z" },
    ],
    items: [
      { id: "item-1", listId: "list-1", text: "Buy groceries", completed: false, sortOrder: 0 },
      { id: "item-2", listId: "list-1", text: "Clean house", completed: true, sortOrder: 1 },
      { id: "item-3", listId: "list-2", text: "Write report", completed: false, sortOrder: 0 },
    ],
    loading: false,
    error: null,
    selectedListId: "list-1",
    setSelectedListId: vi.fn(),
    createList: vi.fn().mockResolvedValue(undefined),
    renameList: vi.fn().mockResolvedValue(undefined),
    deleteList: vi.fn().mockResolvedValue(undefined),
    createItem: vi.fn().mockResolvedValue(undefined),
    updateItem: vi.fn().mockResolvedValue(undefined),
    toggleItem: vi.fn().mockResolvedValue(undefined),
    deleteItem: vi.fn().mockResolvedValue(undefined),
    reorderItems: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("TodoView", () => {
  const addToast = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfirm.mockReset();
    mockConfirm.mockResolvedValue(true);
    mockUseTodoLists.mockReturnValue(createMockTodoLists());
  });

  it("renders header with Todos heading", () => {
    render(<TodoView addToast={addToast} />);
    expect(screen.getByRole("heading", { name: "Todos" })).toBeInTheDocument();
  });

  it("renders sidebar with list names", () => {
    render(<TodoView addToast={addToast} />);
    expect(screen.getByTestId("todo-list-list-1")).toHaveTextContent("My List");
    expect(screen.getByTestId("todo-list-list-2")).toHaveTextContent("Work Tasks");
  });

  it("renders only items for the selected list", () => {
    render(<TodoView addToast={addToast} />);
    expect(screen.getByText("Buy groceries")).toBeInTheDocument();
    expect(screen.getByText("Clean house")).toBeInTheDocument();
    expect(screen.queryByText("Write report")).not.toBeInTheDocument();
  });

  it("shows loading spinner when loading is true", () => {
    mockUseTodoLists.mockReturnValue(createMockTodoLists({ loading: true }));
    render(<TodoView addToast={addToast} />);
    expect(screen.getByText("Loading todos...")).toBeInTheDocument();
    expect(screen.getByTestId("icon-loader")).toBeInTheDocument();
  });

  it("shows error message when error is set", () => {
    mockUseTodoLists.mockReturnValue(createMockTodoLists({ error: "Something went wrong" }));
    render(<TodoView addToast={addToast} />);
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("shows empty state when no lists exist", () => {
    mockUseTodoLists.mockReturnValue(createMockTodoLists({ lists: [], items: [], selectedListId: null }));
    render(<TodoView addToast={addToast} />);
    expect(screen.getByText("No todo lists yet. Create one to get started.")).toBeInTheDocument();
  });

  it("shows empty state when selected list has no items", () => {
    mockUseTodoLists.mockReturnValue(createMockTodoLists({ items: [] }));
    render(<TodoView addToast={addToast} />);
    expect(screen.getByText("No items in this list. Add one above.")).toBeInTheDocument();
  });

  it("shows select-list empty state when no list is selected", () => {
    mockUseTodoLists.mockReturnValue(createMockTodoLists({ selectedListId: null }));
    render(<TodoView addToast={addToast} />);
    expect(screen.getByText("Select a list from the sidebar")).toBeInTheDocument();
  });

  it("clicking a list item calls setSelectedListId", () => {
    const state = createMockTodoLists();
    mockUseTodoLists.mockReturnValue(state);

    render(<TodoView addToast={addToast} />);
    fireEvent.click(screen.getByTestId("todo-list-list-2"));

    expect(state.setSelectedListId).toHaveBeenCalledWith("list-2");
  });

  it.each([
    { key: "Enter", shouldCreate: true },
    { key: "Escape", shouldCreate: false },
  ])("new list input keyboard behavior: $key", ({ key, shouldCreate }) => {
    const state = createMockTodoLists();
    mockUseTodoLists.mockReturnValue(state);

    render(<TodoView addToast={addToast} />);
    fireEvent.click(screen.getByTestId("add-list-button"));

    const input = screen.getByTestId("new-list-input");
    fireEvent.change(input, { target: { value: "Weekend" } });
    fireEvent.keyDown(input, { key });

    if (shouldCreate) {
      expect(state.createList).toHaveBeenCalledWith("Weekend");
    } else {
      expect(state.createList).not.toHaveBeenCalled();
    }
  });

  it.each([
    { key: "Enter", shouldRename: true },
    { key: "Escape", shouldRename: false },
  ])("list rename keyboard behavior: $key", ({ key, shouldRename }) => {
    const state = createMockTodoLists();
    mockUseTodoLists.mockReturnValue(state);

    render(<TodoView addToast={addToast} />);
    fireEvent.click(screen.getByTestId("rename-list-button-list-1"));

    const input = screen.getByTestId("rename-list-input-list-1");
    fireEvent.change(input, { target: { value: "Renamed List" } });
    fireEvent.keyDown(input, { key });

    if (shouldRename) {
      expect(state.renameList).toHaveBeenCalledWith("list-1", "Renamed List");
    } else {
      expect(state.renameList).not.toHaveBeenCalled();
    }
  });

  it("clicking trash icon on list calls deleteList", async () => {
    const state = createMockTodoLists();
    mockUseTodoLists.mockReturnValue(state);

    render(<TodoView addToast={addToast} />);
    fireEvent.click(screen.getByTestId("delete-list-button-list-1"));

    await waitFor(() => {
      expect(state.deleteList).toHaveBeenCalledWith("list-1");
    });
    expect(mockConfirm).toHaveBeenCalledWith({
      title: "Delete List",
      message: "Delete this list and all its items?",
      danger: true,
    });
  });

  it("does not delete a list when confirmation is canceled", async () => {
    mockConfirm.mockResolvedValueOnce(false);
    const state = createMockTodoLists();
    mockUseTodoLists.mockReturnValue(state);

    render(<TodoView addToast={addToast} />);
    fireEvent.click(screen.getByTestId("delete-list-button-list-1"));

    await waitFor(() => {
      expect(mockConfirm).toHaveBeenCalled();
    });
    expect(state.deleteList).not.toHaveBeenCalled();
  });

  it("typing add-item input and pressing Enter calls createItem", () => {
    const state = createMockTodoLists();
    mockUseTodoLists.mockReturnValue(state);

    render(<TodoView addToast={addToast} />);

    const input = screen.getByTestId("new-item-input");
    fireEvent.change(input, { target: { value: "Pack bags" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(state.createItem).toHaveBeenCalledWith("Pack bags");
  });

  it("pressing Escape in add-item input clears the pending draft", () => {
    const state = createMockTodoLists();
    mockUseTodoLists.mockReturnValue(state);

    render(<TodoView addToast={addToast} />);

    const input = screen.getByTestId("new-item-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Pack bags" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(state.createItem).not.toHaveBeenCalled();
    expect(input.value).toBe("");
  });

  it("clicking checkbox calls toggleItem with item ID", () => {
    const state = createMockTodoLists();
    mockUseTodoLists.mockReturnValue(state);

    render(<TodoView addToast={addToast} />);
    fireEvent.click(screen.getByTestId("toggle-item-item-1"));

    expect(state.toggleItem).toHaveBeenCalledWith("item-1");
  });

  it("completed items have strikethrough class", () => {
    render(<TodoView addToast={addToast} />);
    expect(screen.getByText("Clean house")).toHaveClass("todo-item-text--completed");
  });

  it.each([
    { key: "Enter", shouldSave: true },
    { key: "Escape", shouldSave: false },
  ])("item edit keyboard behavior: $key", ({ key, shouldSave }) => {
    const state = createMockTodoLists();
    mockUseTodoLists.mockReturnValue(state);

    render(<TodoView addToast={addToast} />);

    fireEvent.click(screen.getByText("Buy groceries"));
    const input = screen.getByTestId("edit-item-input-item-1");
    fireEvent.change(input, { target: { value: "Buy vegetables" } });
    fireEvent.keyDown(input, { key });

    if (shouldSave) {
      expect(state.updateItem).toHaveBeenCalledWith("item-1", { text: "Buy vegetables" });
    } else {
      expect(state.updateItem).not.toHaveBeenCalled();
    }
  });

  it.each([
    { testId: "move-down-item-1", expected: ["item-2", "item-1"], message: "move down" },
    { testId: "move-up-item-2", expected: ["item-2", "item-1"], message: "move up" },
  ])("clicking reorder button ($message) calls reorderItems", ({ testId, expected }) => {
    const state = createMockTodoLists();
    mockUseTodoLists.mockReturnValue(state);

    render(<TodoView addToast={addToast} />);
    fireEvent.click(screen.getByTestId(testId));

    expect(state.reorderItems).toHaveBeenCalledWith(expected);
  });

  it("disables boundary reorder controls for first and last items", () => {
    render(<TodoView addToast={addToast} />);

    expect(screen.getByRole("button", { name: "Move Buy groceries up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Clean house down" })).toBeDisabled();
  });

  it("clicking trash icon on item calls deleteItem", () => {
    const state = createMockTodoLists();
    mockUseTodoLists.mockReturnValue(state);

    render(<TodoView addToast={addToast} />);
    fireEvent.click(screen.getByTestId("delete-item-item-1"));

    expect(state.deleteItem).toHaveBeenCalledWith("item-1");
  });

  it("trims surrounding whitespace before creating a list", () => {
    const state = createMockTodoLists();
    mockUseTodoLists.mockReturnValue(state);

    render(<TodoView addToast={addToast} />);
    fireEvent.click(screen.getByTestId("add-list-button"));

    const input = screen.getByTestId("new-list-input");
    fireEvent.change(input, { target: { value: "   Weekend   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(state.createList).toHaveBeenCalledWith("Weekend");
  });

  it("trims surrounding whitespace before creating an item", () => {
    const state = createMockTodoLists();
    mockUseTodoLists.mockReturnValue(state);

    render(<TodoView addToast={addToast} />);
    const input = screen.getByTestId("new-item-input");
    fireEvent.change(input, { target: { value: "   Pack bags   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(state.createItem).toHaveBeenCalledWith("Pack bags");
  });

  it("trims surrounding whitespace before renaming a list", () => {
    const state = createMockTodoLists();
    mockUseTodoLists.mockReturnValue(state);

    render(<TodoView addToast={addToast} />);
    fireEvent.click(screen.getByTestId("rename-list-button-list-1"));

    const input = screen.getByTestId("rename-list-input-list-1");
    fireEvent.change(input, { target: { value: "  Renamed List  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(state.renameList).toHaveBeenCalledWith("list-1", "Renamed List");
  });

  it("trims surrounding whitespace before saving an item edit", () => {
    const state = createMockTodoLists();
    mockUseTodoLists.mockReturnValue(state);

    render(<TodoView addToast={addToast} />);

    fireEvent.click(screen.getByText("Buy groceries"));
    const input = screen.getByTestId("edit-item-input-item-1");
    fireEvent.change(input, { target: { value: "  Buy vegetables  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(state.updateItem).toHaveBeenCalledWith("item-1", { text: "Buy vegetables" });
  });

  it("clicking another list cancels an in-progress list rename", () => {
    mockUseTodoLists.mockReturnValue(createMockTodoLists());

    render(<TodoView addToast={addToast} />);
    fireEvent.click(screen.getByTestId("rename-list-button-list-1"));
    expect(screen.getByTestId("rename-list-input-list-1")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("todo-list-list-2"));

    expect(screen.queryByTestId("rename-list-input-list-1")).not.toBeInTheDocument();
  });

  it("clears inline item edit when selected list changes", () => {
    const initialState = createMockTodoLists({ selectedListId: "list-1" });
    mockUseTodoLists.mockReturnValue(initialState);

    const { rerender } = render(<TodoView addToast={addToast} />);
    fireEvent.click(screen.getByText("Buy groceries"));
    expect(screen.getByTestId("edit-item-input-item-1")).toBeInTheDocument();

    mockUseTodoLists.mockReturnValue(createMockTodoLists({ selectedListId: "list-2" }));
    rerender(<TodoView addToast={addToast} />);

    expect(screen.queryByTestId("edit-item-input-item-1")).not.toBeInTheDocument();
  });

  it("shows new list input and hides empty-state prompt when create list is clicked", () => {
    mockUseTodoLists.mockReturnValue(createMockTodoLists({ lists: [], items: [], selectedListId: null }));

    render(<TodoView addToast={addToast} />);
    fireEvent.click(screen.getByRole("button", { name: "Create List" }));

    expect(screen.getByTestId("new-list-input")).toBeInTheDocument();
    expect(screen.queryByText("No todo lists yet. Create one to get started.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create List" })).not.toBeInTheDocument();
  });

  it("marks the selected list with aria-current", () => {
    render(<TodoView addToast={addToast} />);

    expect(screen.getByTestId("todo-list-list-1")).toHaveAttribute("aria-current", "true");
    expect(screen.getByTestId("todo-list-list-2")).not.toHaveAttribute("aria-current", "true");
  });

  it("applies active class to selected list", () => {
    render(<TodoView addToast={addToast} />);
    const selectedButton = screen.getByTestId("todo-list-list-1");
    expect(selectedButton.closest(".todo-list-item")).toHaveClass("todo-list-item--active");
  });
});
