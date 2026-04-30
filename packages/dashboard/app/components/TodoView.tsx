import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Plus,
  Trash2,
  Pencil,
  Check,
  X,
  ChevronUp,
  ChevronDown,
  Loader2,
  ListChecks,
  Bot,
  PlusCircle,
} from "lucide-react";
import { getErrorMessage, type Task, type TaskCreateInput, type TodoItem, type TodoList } from "@fusion/core";
import { createTask, fetchAgents } from "../api";
import type { Agent } from "../api";
import { useTodoLists } from "../hooks/useTodoLists";
import { useConfirm } from "../hooks/useConfirm";
import "./TodoView.css";

interface TodoViewProps {
  projectId?: string;
  addToast: (message: string, type?: "success" | "error" | "info") => void;
}

function sortItems(items: TodoItem[]): TodoItem[] {
  return [...items].sort((a, b) => a.sortOrder - b.sortOrder);
}

export function TodoView({ projectId, addToast }: TodoViewProps) {
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

  const selectedList = useMemo(
    () => lists.find((list) => list.id === selectedListId) ?? null,
    [lists, selectedListId],
  );
  const sortedItems = useMemo(
    () => sortItems(items.filter((item) => item.listId === selectedListId)),
    [items, selectedListId],
  );

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
  }

  const loadAgents = useCallback(async () => {
    setAgentsLoading(true);
    try {
      const loadedAgents = await fetchAgents(undefined, projectId);
      setAgents(loadedAgents);
      setShowAgentPicker(true);
    } catch (err) {
      addToast(`Failed to load agents: ${getErrorMessage(err)}`, "error");
      setShowAgentPicker(false);
      setActiveItemForAgent(null);
    } finally {
      setAgentsLoading(false);
    }
  }, [projectId, addToast]);

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
      title: "Delete List",
      message: "Delete this list and all its items?",
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
      const input: TaskCreateInput = {
        description: item.text,
        column: "triage",
        source: { sourceType: "dashboard_ui" },
      };
      const task: Task = await createTask(input, projectId);
      addToast(`Created ${task.id} from todo`, "success");
    } catch (err) {
      addToast(`Failed to create task: ${getErrorMessage(err)}`, "error");
    }
  }, [projectId, addToast]);

  const handleCreateTaskAndAssign = useCallback(async (item: TodoItem, agentId: string) => {
    try {
      const input: TaskCreateInput = {
        description: item.text,
        column: "triage",
        assignedAgentId: agentId,
        source: { sourceType: "dashboard_ui" },
      };
      const task: Task = await createTask(input, projectId);
      const assignedAgent = agents.find((agent) => agent.id === agentId);
      const agentLabel = assignedAgent?.name ?? agentId;
      addToast(`Created ${task.id} and assigned to ${agentLabel}`, "success");
      setShowAgentPicker(false);
      setActiveItemForAgent(null);
    } catch (err) {
      addToast(`Failed to create and assign task: ${getErrorMessage(err)}`, "error");
    }
  }, [projectId, addToast, agents]);

  if (loading) {
    return (
      <div className="todo-view">
        <div className="todo-loading">
          <Loader2 className="todo-loading-icon" aria-hidden="true" />
          <p>Loading todos...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="todo-view">
      <div className="todo-view-header">
        <div>
          <h2>Todos</h2>
          <p className="todo-view-description">Manage reusable todo lists for your project.</p>
        </div>
      </div>

      <div className="todo-view-layout">
        <aside className="todo-view-sidebar" aria-label="Todo lists sidebar">
          <div className="todo-sidebar-header">
            <h3 className="todo-sidebar-title">Lists</h3>
            <button
              type="button"
              className="btn btn-sm btn-icon todo-add-list-btn"
              onClick={() => {
                resetItemDraftState();
                setIsAddingList(true);
                setEditingListId(null);
              }}
              aria-label="Add list"
              data-testid="add-list-button"
            >
              <Plus size={14} />
            </button>
          </div>

          {isAddingList && (
            <div className="todo-list-item">
              <input
                className="input todo-inline-edit-input"
                placeholder="New list title"
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
                aria-label="Save list"
              >
                <Check size={14} />
              </button>
              <button
                type="button"
                className="btn btn-sm btn-icon todo-icon-btn"
                onClick={() => {
                  setNewListTitle("");
                  setIsAddingList(false);
                }}
                aria-label="Cancel list"
              >
                <X size={14} />
              </button>
            </div>
          )}

          {lists.length === 0 && !isAddingList ? (
            <div className="todo-empty-state">
              <ListChecks aria-hidden="true" />
              <p>No todo lists yet. Create one to get started.</p>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  resetItemDraftState();
                  setIsAddingList(true);
                }}
              >
                Create List
              </button>
            </div>
          ) : (
            <div className="todo-list-items" role="list" aria-label="Todo lists">
              {lists.map((list) => {
                const isActive = list.id === selectedListId;
                const isEditing = list.id === editingListId;

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
                          aria-label="Save list rename"
                        >
                          <Check size={14} />
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-icon todo-icon-btn"
                          onClick={handleCancelRenameList}
                          aria-label="Cancel list rename"
                        >
                          <X size={14} />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="todo-list-select-btn"
                          onClick={() => handleSelectList(list.id)}
                          aria-label={`Select list ${list.title}`}
                          aria-current={isActive ? "true" : undefined}
                          data-testid={`todo-list-${list.id}`}
                        >
                          <span className="todo-list-item-name">{list.title}</span>
                        </button>
                        <div className="todo-list-item-actions">
                          <button
                            type="button"
                            className="btn btn-sm btn-icon todo-icon-btn"
                            onClick={() => {
                              handleStartRenameList(list);
                            }}
                            aria-label={`Rename ${list.title}`}
                            data-testid={`rename-list-button-${list.id}`}
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm btn-icon btn-danger todo-icon-btn"
                            onClick={() => {
                              void handleDeleteList(list.id);
                            }}
                            aria-label={`Delete ${list.title}`}
                            data-testid={`delete-list-button-${list.id}`}
                          >
                            <Trash2 size={14} />
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

        <section className="todo-view-main" aria-label="Todo items">
          {error && (
            <div className="todo-error-banner" role="alert">
              <span className="todo-error-message">{error}</span>
              <button type="button" className="btn btn-sm" onClick={() => window.location.reload()}>
                Retry
              </button>
            </div>
          )}

          {!selectedList ? (
            <div className="todo-empty-state">
              <ListChecks aria-hidden="true" />
              <p>Select a list from the sidebar</p>
            </div>
          ) : (
            <>
              <div className="todo-items-header">
                <h3>{selectedList.title}</h3>
              </div>

              <div className="todo-add-item-row">
                <input
                  className="input"
                  placeholder="Add a todo item"
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
                  Add
                </button>
              </div>

              {sortedItems.length === 0 ? (
                <div className="todo-empty-state">
                  <p>No items in this list. Add one above.</p>
                </div>
              ) : (
                <div className="todo-items-list">
                  {sortedItems.map((item, index) => {
                    const isEditing = item.id === editingItemId;

                    return (
                      <div className="todo-item" key={item.id} data-testid={`todo-item-${item.id}`}>
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

                        <div className="todo-item-actions">
                          {isEditing ? (
                            <>
                              <button
                                type="button"
                                className="btn btn-sm btn-icon todo-icon-btn"
                                onClick={() => {
                                  void handleSaveEditItem();
                                }}
                                aria-label="Save item edit"
                              >
                                <Check size={14} />
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm btn-icon todo-icon-btn"
                                onClick={handleCancelEditItem}
                                aria-label="Cancel item edit"
                              >
                                <X size={14} />
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
                                  aria-label={`Move ${item.text} up`}
                                  data-testid={`move-up-${item.id}`}
                                >
                                  <ChevronUp size={14} />
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-sm btn-icon todo-item-reorder-btn"
                                  onClick={() => {
                                    void handleMoveItem(item.id, "down");
                                  }}
                                  disabled={index === sortedItems.length - 1}
                                  aria-label={`Move ${item.text} down`}
                                  data-testid={`move-down-${item.id}`}
                                >
                                  <ChevronDown size={14} />
                                </button>
                              </div>
                              <button
                                type="button"
                                className="btn btn-sm btn-icon todo-icon-btn"
                                onClick={() => {
                                  void handleCreateTaskFromItem(item);
                                }}
                                aria-label={`Create task from ${item.text}`}
                                data-testid={`create-task-from-${item.id}`}
                              >
                                <PlusCircle size={14} />
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
                                  aria-label={`Assign ${item.text} to agent`}
                                  data-testid={`assign-agent-for-${item.id}`}
                                >
                                  <Bot size={14} />
                                </button>
                                {showAgentPicker && activeItemForAgent === item.id && (
                                  <div
                                    className="todo-agent-picker-dropdown"
                                    onMouseDown={(event) => {
                                      event.preventDefault();
                                    }}
                                  >
                                    {agentsLoading ? (
                                      <div className="todo-agent-picker-loading">Loading agents...</div>
                                    ) : agents.filter((agent) => agent.state !== "terminated").length > 0 ? (
                                      agents
                                        .filter((agent) => agent.state !== "terminated")
                                        .map((agent) => (
                                          <button
                                            type="button"
                                            key={agent.id}
                                            className="todo-agent-picker-item"
                                            onClick={() => {
                                              void handleCreateTaskAndAssign(item, agent.id);
                                            }}
                                          >
                                            <Bot size={14} />
                                            <span>{agent.name}</span>
                                            <span className="todo-agent-picker-role">{agent.role}</span>
                                          </button>
                                        ))
                                    ) : (
                                      <div className="todo-agent-picker-empty">No agents available</div>
                                    )}
                                  </div>
                                )}
                              </div>
                              <button
                                type="button"
                                className="btn btn-sm btn-icon todo-icon-btn"
                                onClick={() => handleStartEditItem(item)}
                                aria-label={`Edit ${item.text}`}
                                data-testid={`edit-item-${item.id}`}
                              >
                                <Pencil size={14} />
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm btn-icon btn-danger todo-icon-btn"
                                onClick={() => {
                                  void handleDeleteItem(item.id);
                                }}
                                aria-label={`Delete ${item.text}`}
                                data-testid={`delete-item-${item.id}`}
                              >
                                <Trash2 size={14} />
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
