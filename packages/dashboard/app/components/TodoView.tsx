import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Plus,
  Trash2,
  Pencil,
  Check,
  X,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  Loader2,
  ListChecks,
  Bot,
  PlusCircle,
  Lightbulb,
} from "lucide-react";
import { getErrorMessage, type Task, type TaskCreateInput, type TodoItem, type TodoList } from "@fusion/core";
import { createTask, fetchAgents } from "../api";
import type { Agent } from "../api";
import { useTodoLists } from "../hooks/useTodoLists";
import { useConfirm } from "../hooks/useConfirm";
import { LoadingSpinner } from "./LoadingSpinner";
import "./TodoView.css";

interface TodoViewProps {
  projectId?: string;
  addToast: (message: string, type?: "success" | "error" | "info") => void;
  onPlanningMode?: (initialPlan: string) => void;
  onTaskCreated?: (task: Task) => void;
}

function sortItems(items: TodoItem[]): TodoItem[] {
  return [...items].sort((a, b) => a.sortOrder - b.sortOrder);
}

export function TodoView({
  projectId,
  addToast,
  onPlanningMode,
  onTaskCreated,
}: TodoViewProps) {
  const { t } = useTranslation("app");
  const {
    lists,
    items,
    loading,
    error,
    selectedListId,
    setSelectedListId,
    createList,
    renameList,
    deleteList,
    createItem,
    updateItem,
    toggleItem,
    deleteItem,
    reorderItems,
  } = useTodoLists({
    projectId,
    addToast: (message, type) => {
      if (type === "success" || type === "error" || type === "info" || type === undefined) {
        addToast(message, type);
        return;
      }
      addToast(message, "info");
    },
  });

  const [editingListId, setEditingListId] = useState<string | null>(null);
  const [editingListTitle, setEditingListTitle] = useState("");
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editingItemText, setEditingItemText] = useState("");
  const [newListTitle, setNewListTitle] = useState("");
  const [isAddingList, setIsAddingList] = useState(false);
  const [newItemText, setNewItemText] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const [activeItemForAgent, setActiveItemForAgent] = useState<string | null>(null);
  const agentPickerRef = useRef<HTMLDivElement>(null);
  const { confirm } = useConfirm();

  /*
  FNXC:Todos 2026-06-22-00:00:
  TodoView mounts in the narrow right dock (no width prop) where the two side-by-side panels (list selection + items) cannot fit. The layout switch is driven by a CSS container query on `.todo-view` (container-name: todo-view), NOT a prop. In the NARROW container we render a single-panel navigation stack: the master list-selection panel first, and selecting a list navigates forward to its items panel with a Back affordance. `mobileStackView` tracks which panel the narrow stack shows; the WIDE two-panel layout ignores it entirely (both panels always render). Selecting a list pushes to "detail"; Back returns to "list".
  */
  const [mobileStackView, setMobileStackView] = useState<"list" | "detail">("list");

  const selectedList = useMemo(
    () => lists.find((list) => list.id === selectedListId) ?? null,
    [lists, selectedListId],
  );
  const sortedItems = useMemo(
    () => sortItems(items.filter((item) => item.listId === selectedListId)),
    [items, selectedListId],
  );
  const listItemStats = useMemo(() => {
    const stats = new Map<string, { total: number; completed: number }>();
    for (const list of lists) {
      stats.set(list.id, { total: 0, completed: 0 });
    }
    for (const item of items) {
      const current = stats.get(item.listId) ?? { total: 0, completed: 0 };
      current.total += 1;
      if (item.completed) {
        current.completed += 1;
      }
      stats.set(item.listId, current);
    }
    return stats;
  }, [items, lists]);
  const selectedListStats = selectedList ? (listItemStats.get(selectedList.id) ?? { total: sortedItems.length, completed: sortedItems.filter((item) => item.completed).length }) : null;

  function resetListDraftState(): void {
    setEditingListId(null);
    setEditingListTitle("");
    setNewListTitle("");
    setIsAddingList(false);
  }

  function resetItemDraftState(): void {
    setEditingItemId(null);
    setEditingItemText("");
    setNewItemText("");
  }

  function handleSelectList(listId: string): void {
    resetListDraftState();
    resetItemDraftState();
    setSelectedListId(listId);
    // FNXC:Todos 2026-06-22-00:00: Narrow stack navigates forward to the items panel on selection; no-op visually in the wide two-panel layout.
    setMobileStackView("detail");
  }

  // FNXC:Todos 2026-06-22-00:00: Narrow-stack Back affordance returns to the master list-selection panel. Inert in the wide layout where both panels are always visible.
  function handleMobileBack(): void {
    setMobileStackView("list");
  }

  const loadAgents = useCallback(async () => {
    setAgentsLoading(true);
    try {
      const loadedAgents = await fetchAgents(undefined, projectId);
      setAgents(loadedAgents);
      setShowAgentPicker(true);
    } catch (err) {
      addToast(t("todo.failedToLoadAgents", "Failed to load agents: {{error}}", { error: getErrorMessage(err) }), "error");
      setShowAgentPicker(false);
      setActiveItemForAgent(null);
    } finally {
      setAgentsLoading(false);
    }
  }, [projectId, addToast, t]);

  useEffect(() => {
    setEditingListId(null);
    setEditingListTitle("");
    setNewListTitle("");
    setIsAddingList(false);
    setEditingItemId(null);
    setEditingItemText("");
    setNewItemText("");
    setShowAgentPicker(false);
    setActiveItemForAgent(null);
  }, [selectedListId]);

  useEffect(() => {
    if (!showAgentPicker) {
      return;
    }

    const handleClickOutside = (event: MouseEvent) => {
      if (agentPickerRef.current && !agentPickerRef.current.contains(event.target as Node)) {
        setShowAgentPicker(false);
        setActiveItemForAgent(null);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [showAgentPicker]);

  function handleStartRenameList(list: TodoList): void {
    resetItemDraftState();
    setEditingListId(list.id);
    setEditingListTitle(list.title);
    setIsAddingList(false);
  }

  async function handleSaveRenameList(): Promise<void> {
    if (!editingListId) {
      return;
    }

    const trimmedTitle = editingListTitle.trim();
    if (!trimmedTitle) {
      setEditingListId(null);
      setEditingListTitle("");
      return;
    }

    await renameList(editingListId, trimmedTitle);
    setEditingListId(null);
    setEditingListTitle("");
  }

  function handleCancelRenameList(): void {
    setEditingListId(null);
    setEditingListTitle("");
  }

  function handleStartEditItem(item: TodoItem): void {
    resetListDraftState();
    setEditingItemId(item.id);
    setEditingItemText(item.text);
  }

  async function handleSaveEditItem(): Promise<void> {
    if (!editingItemId) {
      return;
    }

    const trimmedText = editingItemText.trim();
    if (!trimmedText) {
      setEditingItemId(null);
      setEditingItemText("");
      return;
    }

    await updateItem(editingItemId, { text: trimmedText });
    setEditingItemId(null);
    setEditingItemText("");
  }

  function handleCancelEditItem(): void {
    setEditingItemId(null);
    setEditingItemText("");
  }

  async function handleAddList(): Promise<void> {
    const trimmedTitle = newListTitle.trim();
    if (!trimmedTitle) {
      return;
    }

    await createList(trimmedTitle);
    setNewListTitle("");
    setIsAddingList(false);
  }

  async function handleAddItem(): Promise<void> {
    if (!selectedListId) {
      return;
    }

    const trimmedText = newItemText.trim();
    if (!trimmedText) {
      return;
    }

    await createItem(trimmedText);
    setNewItemText("");
  }

  async function handleDeleteList(id: string): Promise<void> {
    const shouldDelete = await confirm({
      title: t("todo.deleteListTitle", "Delete List"),
      message: t("todo.deleteListConfirm", "Delete this list and all its items?"),
      danger: true,
    });
    if (!shouldDelete) {
      return;
    }
    await deleteList(id);
  }

  async function handleDeleteItem(id: string): Promise<void> {
    await deleteItem(id);
  }

  async function handleMoveItem(itemId: string, direction: "up" | "down"): Promise<void> {
    const ids = sortedItems.map((item) => item.id);
    const index = ids.findIndex((id) => id === itemId);
    if (index < 0) {
      return;
    }

    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= ids.length) {
      return;
    }

    [ids[index], ids[targetIndex]] = [ids[targetIndex], ids[index]];
    await reorderItems(ids);
  }

  const handleCreateTaskFromItem = useCallback(async (item: TodoItem) => {
    try {
      /*
      FNXC:CodingIdeasWorkflow 2026-07-05-00:00:
      Do not hard-code `column: "triage"` — this surface has no workflow picker, so it inherits the project-default workflow, and the store resolves the landing column from that workflow's intake column (e.g. Coding (Ideas) → "ideas") instead of forcing triage.
      */
      const input: TaskCreateInput = {
        description: item.text,
        source: { sourceType: "dashboard_ui" },
      };
      const task: Task = await createTask(input, projectId);
      onTaskCreated?.(task);
      addToast(t("todo.taskCreatedFromTodo", "Created {{id}} from todo", { id: task.id }), "success");
    } catch (err) {
      addToast(t("todo.failedToCreateTask", "Failed to create task: {{error}}", { error: getErrorMessage(err) }), "error");
    }
  }, [projectId, addToast, onTaskCreated, t]);

  const handleCreateTaskAndAssign = useCallback(async (item: TodoItem, agentId: string) => {
    try {
      // FNXC:CodingIdeasWorkflow 2026-07-05-00:00: same rationale as handleCreateTaskFromItem above — omit column so the project-default workflow's intake column resolves it.
      const input: TaskCreateInput = {
        description: item.text,
        assignedAgentId: agentId,
        source: { sourceType: "dashboard_ui" },
      };
      const task: Task = await createTask(input, projectId);
      onTaskCreated?.(task);
      const assignedAgent = agents.find((agent) => agent.id === agentId);
      const agentLabel = assignedAgent?.name ?? agentId;
      addToast(t("todo.taskCreatedAndAssigned", "Created {{id}} and assigned to {{agent}}", { id: task.id, agent: agentLabel }), "success");
      setShowAgentPicker(false);
      setActiveItemForAgent(null);
    } catch (err) {
      addToast(t("todo.failedToCreateAndAssign", "Failed to create and assign task: {{error}}", { error: getErrorMessage(err) }), "error");
    }
  }, [projectId, addToast, agents, onTaskCreated, t]);

  /*
  FNXC:Todos 2026-06-22-17:45:
  The redundant "Todos" title + "Manage reusable todo lists" subtitle are removed — Todos lives in the right dock (and left-sidebar nav) which already labels the view, so a repeated in-view header is noise. The list/detail layout owns the full height with no header above it.
  */
  const header = null;

  if (loading) {
    return (
      <div className="todo-view" data-testid="todo-view-root">
        {header}
        <div className="todo-loading">
          <Loader2 className="todo-loading-icon" aria-hidden="true" />
          <p>{t("todo.loading", "Loading todos...")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="todo-view" data-testid="todo-view-root">
      {header}
      <div className="todo-view-layout" data-mobile-stack-view={mobileStackView}>
        <aside className="todo-view-sidebar" aria-label={t("todo.listsLabel", "Todo lists sidebar")}>
          <div className="todo-sidebar-header">
            <h3 className="todo-sidebar-title">{t("todo.lists", "Lists")}</h3>
            <button
              type="button"
              className="btn btn-sm btn-icon todo-add-list-btn"
              onClick={() => {
                resetItemDraftState();
                setIsAddingList(true);
                setEditingListId(null);
              }}
              aria-label={t("todo.addList", "Add list")}
              data-testid="add-list-button"
            >
              <Plus />
            </button>
          </div>

          {isAddingList && (
            <div className="todo-list-item">
              <input
                className="input todo-inline-edit-input"
                placeholder={t("todo.newListTitle", "New list title")}
                value={newListTitle}
                onChange={(event) => setNewListTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void handleAddList();
                  }
                  if (event.key === "Escape") {
                    setNewListTitle("");
                    setIsAddingList(false);
                  }
                }}
                autoFocus
                data-testid="new-list-input"
              />
              <button
                type="button"
                className="btn btn-sm btn-icon todo-icon-btn"
                onClick={() => {
                  void handleAddList();
                }}
                aria-label={t("todo.saveList", "Save list")}
              >
                <Check />
              </button>
              <button
                type="button"
                className="btn btn-sm btn-icon todo-icon-btn"
                onClick={() => {
                  setNewListTitle("");
                  setIsAddingList(false);
                }}
                aria-label={t("todo.cancelList", "Cancel list")}
              >
                <X />
              </button>
            </div>
          )}

          {lists.length === 0 && !isAddingList ? (
            <div className="todo-empty-state">
              <ListChecks aria-hidden="true" />
              <p>{t("todo.noListsEmpty", "No todo lists yet. Create one to get started.")}</p>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  resetItemDraftState();
                  setIsAddingList(true);
                }}
              >
                {t("todo.createList", "Create List")}
              </button>
            </div>
          ) : (
            <div className="todo-list-items" role="list" aria-label={t("todo.todoListsLabel", "Todo lists")}>
              {lists.map((list) => {
                const isActive = list.id === selectedListId;
                const isEditing = list.id === editingListId;
                const stats = listItemStats.get(list.id) ?? { total: 0, completed: 0 };

                return (
                  <div
                    key={list.id}
                    className={`todo-list-item${isActive ? " todo-list-item--active" : ""}`}
                    role="listitem"
                  >
                    {isEditing ? (
                      <>
                        <input
                          className="input todo-inline-edit-input"
                          value={editingListTitle}
                          onChange={(event) => setEditingListTitle(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              void handleSaveRenameList();
                            }
                            if (event.key === "Escape") {
                              handleCancelRenameList();
                            }
                          }}
                          autoFocus
                          data-testid={`rename-list-input-${list.id}`}
                        />
                        <button
                          type="button"
                          className="btn btn-sm btn-icon todo-icon-btn"
                          onClick={() => {
                            void handleSaveRenameList();
                          }}
                          aria-label={t("todo.saveListRename", "Save list rename")}
                        >
                          <Check />
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-icon todo-icon-btn"
                          onClick={handleCancelRenameList}
                          aria-label={t("todo.cancelListRename", "Cancel list rename")}
                        >
                          <X />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="todo-list-select-btn"
                          onClick={() => handleSelectList(list.id)}
                          aria-label={t("todo.selectList", "Select list {{title}}", { title: list.title })}
                          aria-current={isActive ? "true" : undefined}
                          data-testid={`todo-list-${list.id}`}
                        >
                          <span className="todo-list-item-name">{list.title}</span>
                          <span className="todo-list-item-count">
                            {stats.completed}/{stats.total}
                          </span>
                        </button>
                        <div className="todo-list-item-actions">
                          <button
                            type="button"
                            className="btn btn-sm btn-icon todo-icon-btn"
                            onClick={() => {
                              handleStartRenameList(list);
                            }}
                            aria-label={t("todo.renameList", "Rename {{title}}", { title: list.title })}
                            data-testid={`rename-list-button-${list.id}`}
                          >
                            <Pencil />
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm btn-icon btn-danger todo-icon-btn"
                            onClick={() => {
                              void handleDeleteList(list.id);
                            }}
                            aria-label={t("todo.deleteList", "Delete {{title}}", { title: list.title })}
                            data-testid={`delete-list-button-${list.id}`}
                          >
                            <Trash2 />
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </aside>

        <section className="todo-view-main" aria-label={t("todo.itemsLabel", "Todo items")}>
          {error && (
            <div className="todo-error-banner" role="alert">
              <span className="todo-error-message">{error}</span>
              <button type="button" className="btn btn-sm" onClick={() => window.location.reload()}>
                {t("actions.retry", "Retry")}
              </button>
            </div>
          )}

          {!selectedList ? (
            <div className="todo-empty-state">
              <ListChecks aria-hidden="true" />
              <p>{t("todo.selectListEmpty", "Select a list from the sidebar")}</p>
            </div>
          ) : (
            <>
              <div className="todo-items-header">
                {/* FNXC:Todos 2026-06-22-00:00: Back button is visible only in the narrow container (CSS-gated) to pop the items panel back to the list-selection panel. Hidden in the wide two-panel layout where both panels coexist. */}
                <button
                  type="button"
                  className="btn btn-sm btn-icon todo-icon-btn todo-mobile-back-btn"
                  onClick={handleMobileBack}
                  aria-label={t("todo.backToLists", "Back to lists")}
                  data-testid="todo-mobile-back-button"
                >
                  <ChevronLeft />
                </button>
                <div className="todo-items-heading">
                  <h3>{selectedList.title}</h3>
                  {selectedListStats && (
                    <span className="todo-items-progress">
                      {t("todo.completedCount", "{{completed}}/{{total}} complete", {
                        completed: selectedListStats.completed,
                        total: selectedListStats.total,
                      })}
                    </span>
                  )}
                </div>
              </div>

              <div className="todo-add-item-row">
                <input
                  className="input"
                  placeholder={t("todo.addItemPlaceholder", "Add a todo item")}
                  value={newItemText}
                  onChange={(event) => setNewItemText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      void handleAddItem();
                    }
                    if (event.key === "Escape") {
                      setNewItemText("");
                    }
                  }}
                  data-testid="new-item-input"
                />
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    void handleAddItem();
                  }}
                >
                  <Plus size={14} />
                  {t("actions.add", "Add")}
                </button>
              </div>

              {sortedItems.length === 0 ? (
                <div className="todo-empty-state">
                  <p>{t("todo.noItemsEmpty", "No items in this list. Add one above.")}</p>
                </div>
              ) : (
                <div className="todo-items-list">
                  {sortedItems.map((item, index) => {
                    const isEditing = item.id === editingItemId;

                    return (
                      <div className="todo-item" key={item.id} data-testid={`todo-item-${item.id}`}>
                        <div className="todo-item-main-row">
                          <input
                            type="checkbox"
                            checked={item.completed}
                            onChange={() => {
                              void toggleItem(item.id);
                            }}
                            className="todo-item-checkbox"
                            aria-label={`Toggle ${item.text}`}
                            data-testid={`toggle-item-${item.id}`}
                          />

                          {isEditing ? (
                            <input
                              className="input todo-inline-edit-input"
                              value={editingItemText}
                              onChange={(event) => setEditingItemText(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  void handleSaveEditItem();
                                }
                                if (event.key === "Escape") {
                                  handleCancelEditItem();
                                }
                              }}
                              autoFocus
                              data-testid={`edit-item-input-${item.id}`}
                            />
                          ) : (
                            <button
                              type="button"
                              className={`todo-item-text${item.completed ? " todo-item-text--completed" : ""}`}
                              onClick={() => handleStartEditItem(item)}
                            >
                              {item.text}
                            </button>
                          )}
                        </div>

                        <div className="todo-item-actions" data-testid={`todo-item-actions-${item.id}`}>
                          {isEditing ? (
                            <>
                              <button
                                type="button"
                                className="btn btn-sm btn-icon todo-icon-btn"
                                onClick={() => {
                                  void handleSaveEditItem();
                                }}
                                aria-label={t("todo.saveItemEdit", "Save item edit")}
                              >
                                <Check />
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm btn-icon todo-icon-btn"
                                onClick={handleCancelEditItem}
                                aria-label={t("todo.cancelItemEdit", "Cancel item edit")}
                              >
                                <X />
                              </button>
                            </>
                          ) : (
                            <>
                              <div className="todo-item-reorder-btns">
                                <button
                                  type="button"
                                  className="btn btn-sm btn-icon todo-item-reorder-btn"
                                  onClick={() => {
                                    void handleMoveItem(item.id, "up");
                                  }}
                                  disabled={index === 0}
                                  aria-label={t("todo.moveItemUp", "Move {{text}} up", { text: item.text })}
                                  data-testid={`move-up-${item.id}`}
                                >
                                  <ChevronUp />
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-sm btn-icon todo-item-reorder-btn"
                                  onClick={() => {
                                    void handleMoveItem(item.id, "down");
                                  }}
                                  disabled={index === sortedItems.length - 1}
                                  aria-label={t("todo.moveItemDown", "Move {{text}} down", { text: item.text })}
                                  data-testid={`move-down-${item.id}`}
                                >
                                  <ChevronDown />
                                </button>
                              </div>
                              <button
                                type="button"
                                className="btn btn-sm btn-icon todo-icon-btn"
                                onClick={() => {
                                  onPlanningMode?.(item.text);
                                }}
                                aria-label={t("todo.startPlanning", "Start planning from {{text}}", { text: item.text })}
                                data-testid={`planning-from-${item.id}`}
                              >
                                <Lightbulb />
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm btn-icon todo-icon-btn"
                                onClick={() => {
                                  void handleCreateTaskFromItem(item);
                                }}
                                aria-label={t("todo.createTaskFrom", "Create task from {{text}}", { text: item.text })}
                                data-testid={`create-task-from-${item.id}`}
                              >
                                <PlusCircle />
                              </button>
                              <div
                                className="todo-agent-picker-trigger"
                                ref={activeItemForAgent === item.id ? agentPickerRef : undefined}
                              >
                                <button
                                  type="button"
                                  className="btn btn-sm btn-icon todo-icon-btn"
                                  onClick={() => {
                                    setActiveItemForAgent(item.id);
                                    void loadAgents();
                                  }}
                                  aria-label={t("todo.assignAgent", "Assign {{text}} to agent", { text: item.text })}
                                  data-testid={`assign-agent-for-${item.id}`}
                                >
                                  <Bot />
                                </button>
                                {showAgentPicker && activeItemForAgent === item.id && (
                                  <div
                                    className="todo-agent-picker-dropdown"
                                    onMouseDown={(event) => {
                                      event.preventDefault();
                                    }}
                                  >
                                    {agentsLoading ? (
                                      <div className="todo-agent-picker-loading"><LoadingSpinner label={t("todo.loadingAgents", "Loading agents...")} /></div>
                                    ) : agents.length > 0 ? (
                                      agents
                                        .map((agent) => (
                                          <button
                                            type="button"
                                            key={agent.id}
                                            className="todo-agent-picker-item"
                                            onClick={() => {
                                              void handleCreateTaskAndAssign(item, agent.id);
                                            }}
                                          >
                                            <Bot />
                                            <span>{agent.name}</span>
                                            <span className="todo-agent-picker-role">{agent.role}</span>
                                          </button>
                                        ))
                                    ) : (
                                      <div className="todo-agent-picker-empty">{t("todo.noAgentsAvailable", "No agents available")}</div>
                                    )}
                                  </div>
                                )}
                              </div>
                              <button
                                type="button"
                                className="btn btn-sm btn-icon todo-icon-btn"
                                onClick={() => handleStartEditItem(item)}
                                aria-label={t("todo.editItem", "Edit {{text}}", { text: item.text })}
                                data-testid={`edit-item-${item.id}`}
                              >
                                <Pencil />
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm btn-icon btn-danger todo-icon-btn"
                                onClick={() => {
                                  void handleDeleteItem(item.id);
                                }}
                                aria-label={t("todo.deleteItem", "Delete {{text}}", { text: item.text })}
                                data-testid={`delete-item-${item.id}`}
                              >
                                <Trash2 />
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
