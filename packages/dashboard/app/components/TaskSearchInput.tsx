import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Task } from "@fusion/core";
import "./TaskSearchInput.css";

export type SearchableTask = Pick<Task, "id" | "title">;

export interface TaskSearchInputProps {
  query: string;
  tasks?: readonly SearchableTask[];
  onSearchChange: (query: string) => void;
  /** Navigation mode selects the task without rewriting the caller's filter query. */
  onSelectTask?: (task: SearchableTask) => void;
  onClose?: () => void;
  autoFocus?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  className?: string;
  closeLabel?: string;
  testId?: string;
}

const MAX_TASK_SUGGESTIONS = 8;

function suggestionRank(query: string, task: SearchableTask): number {
  const normalizedId = task.id.toLocaleLowerCase();
  if (normalizedId === query) return 0;
  if (normalizedId.startsWith(query)) return 1;
  if (normalizedId.includes(query)) return 2;
  return 3;
}

function compareSuggestions(query: string, left: SearchableTask, right: SearchableTask): number {
  return suggestionRank(query, left) - suggestionRank(query, right)
    || left.id.localeCompare(right.id, undefined, { numeric: true, sensitivity: "base" })
    || (left.title ?? "").localeCompare(right.title ?? "", undefined, { numeric: true, sensitivity: "base" });
}

/**
 * FNXC:TaskSearch 2026-09-11-22:33:
 * Suggestions match the case-insensitive literal substring the user typed in either task ID or title, including suffixes and punctuation. Exact, prefix, and internal ID matches precede title-only matches deterministically; results remain deduplicated, bounded, and sourced only from App's active project-scoped tasks without a competing fetch.
 */
function buildTaskSuggestions(tasks: readonly SearchableTask[] | undefined, query: string): SearchableTask[] {
  const trimmedQuery = query.trim();
  if (!trimmedQuery || !tasks?.length) return [];

  const normalizedQuery = trimmedQuery.toLocaleLowerCase();
  const unique = new Map<string, SearchableTask>();

  for (const task of tasks) {
    const normalizedId = task.id.toLocaleLowerCase();
    const normalizedTitle = (task.title ?? "").toLocaleLowerCase();
    const matches = normalizedId.includes(normalizedQuery) || normalizedTitle.includes(normalizedQuery);
    if (matches && !unique.has(normalizedId)) unique.set(normalizedId, task);
  }

  return [...unique.values()]
    .sort((left, right) => compareSuggestions(normalizedQuery, left, right))
    .slice(0, MAX_TASK_SUGGESTIONS);
}

export function TaskSearchInput({
  query,
  tasks,
  onSearchChange,
  onSelectTask,
  onClose,
  autoFocus,
  inputRef,
  className = "",
  closeLabel,
  testId,
}: TaskSearchInputProps) {
  const { t } = useTranslation("app");
  const rootRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const suggestions = useMemo(() => buildTaskSuggestions(tasks, query), [tasks, query]);
  const suggestionSignature = suggestions.map((task) => task.id.toLocaleLowerCase()).join("\u0000");
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const showSuggestions = isOpen && suggestions.length > 0;

  useEffect(() => {
    setActiveIndex(-1);
  }, [query, suggestionSignature]);

  useEffect(() => {
    const handleOutsidePress = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    document.addEventListener("mousedown", handleOutsidePress);
    return () => document.removeEventListener("mousedown", handleOutsidePress);
  }, []);

  const selectSuggestion = (task: SearchableTask) => {
    setIsOpen(false);
    setActiveIndex(-1);
    if (onSelectTask) onSelectTask(task);
    else onSearchChange(task.id);
  };

  return (
    <div ref={rootRef} className={`task-search-input header-search ${className}`.trim()} data-testid={testId}>
      <Search size={14} className="header-search-icon" aria-hidden="true" />
      <input
        ref={inputRef}
        autoFocus={autoFocus}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showSuggestions}
        aria-controls={showSuggestions ? listboxId : undefined}
        aria-activedescendant={activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
        aria-label={t("header.searchTasks", "Search tasks...")}
        placeholder={t("header.searchTasks", "Search tasks...")}
        value={query}
        onChange={(event) => {
          onSearchChange(event.target.value);
          setIsOpen(true);
        }}
        onFocus={() => setIsOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setIsOpen(false);
            setActiveIndex(-1);
            return;
          }
          if (!suggestions.length) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setIsOpen(true);
            setActiveIndex((index) => (index + 1) % suggestions.length);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setIsOpen(true);
            setActiveIndex((index) => index <= 0 ? suggestions.length - 1 : index - 1);
          } else if (event.key === "Enter" && showSuggestions && activeIndex >= 0) {
            event.preventDefault();
            selectSuggestion(suggestions[activeIndex]);
          }
        }}
        className="header-search-input"
      />
      {onClose && (
        <button
          type="button"
          className="header-search-clear"
          onClick={onClose}
          aria-label={closeLabel ?? t("header.closeSearch", "Close search")}
        >
          <X size={14} />
        </button>
      )}
      {showSuggestions && (
        <ul
          id={listboxId}
          className="task-search-suggestions"
          role="listbox"
          aria-label={t("header.taskSuggestions", "Task suggestions")}
        >
          {suggestions.map((task, index) => (
            <li
              key={task.id.toLocaleLowerCase()}
              id={`${listboxId}-option-${index}`}
              className="task-search-suggestion"
              role="option"
              aria-label={task.title ? `${task.id}: ${task.title}` : task.id}
              aria-selected={activeIndex === index}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => selectSuggestion(task)}
            >
              <span className="task-search-suggestion-id">{task.id}</span>
              <span className="task-search-suggestion-title">{task.title ?? ""}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
