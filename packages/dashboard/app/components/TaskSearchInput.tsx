import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type Ref,
} from "react";
import { Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Task } from "@fusion/core";
import { useTaskSearch } from "../hooks/useTaskSearch";
import { TaskSearchResultsPopover } from "./TaskSearchResultsPopover";
import "./TaskSearchInput.css";

/*
FNXC:TaskSearch 2026-09-17-09:41:
FN-477 replaced this field's former contract entirely.

Before: suggestions were filtered out of the collection the board had ALREADY paged in, capped at
eight, rendered as one-line ellipsised rows, and Enter selected the highlighted row.

Now:
 - The searchable corpus is the whole project through `GET /tasks/page?q=...`, paginated, so a task
   whose board page has not loaded is still findable. There is no fixed result ceiling.
 - Results are real `TaskCard`s in a scrollable panel, so they carry the same information the board
   shows.
 - Enter in the field runs the AI lane (Fast & Cheap) for the field's current value. It NEVER selects
   a highlighted row any more, even after arrowing into the panel \u2014 a single key cannot mean both
   "search harder" and "open this".

Arrow Down / Tab move focus into the panel, where a focused CARD is activated with Enter or Space by
the card itself. The field stays typeable throughout: the panel is non-modal and takes no focus.
*/

/**
 * FNXC:TaskTitleDisplay 2026-09-14-17:05:
 * Retained shape for hosts that hand over partial rows. The panel itself renders full `Task` rows.
 */
export type SearchableTask = Pick<Task, "id" | "title"> & { description?: string | null };

export interface TaskSearchInputProps {
  query: string;
  onSearchChange: (query: string) => void;
  /** Navigation mode selects the task without rewriting the caller's filter query. */
  onSelectTask?: (task: Task) => void;
  onClose?: () => void;
  autoFocus?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  className?: string;
  closeLabel?: string;
  testId?: string;
  /** Project that owns the search. Without it no request is issued. */
  projectId?: string;
  /** Selected node; a remote node routes both lanes through its proxy. */
  nodeId?: string;
  localNodeId?: string;
  addToast?: (message: string, type?: "success" | "error" | "info" | "warning") => void;
}

export function TaskSearchInput({
  query,
  onSearchChange,
  onSelectTask,
  onClose,
  autoFocus,
  inputRef,
  className = "",
  closeLabel,
  testId,
  projectId,
  nodeId,
  localNodeId,
  addToast,
}: TaskSearchInputProps) {
  const { t } = useTranslation("app");
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const [isOpen, setIsOpen] = useState(false);
  const composingRef = useRef(false);

  const search = useTaskSearch({
    query,
    active: isOpen,
    ...(projectId ? { projectId } : {}),
    ...(nodeId ? { nodeId } : {}),
    ...(localNodeId ? { localNodeId } : {}),
  });

  const hasPanelContent = Boolean(query.trim()) && (
    search.tasks.length > 0 || search.loading || search.aiLoading || search.error !== null
  );
  const showPanel = isOpen && hasPanelContent;

  const closePanel = useCallback(() => {
    setIsOpen(false);
    // Cancel in-flight text/AI work rather than letting a closed panel keep a generation alive.
    search.reset();
  }, [search]);

  useEffect(() => {
    const handleOutsidePress = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (rootRef.current?.contains(target)) return;
      /*
      The panel lives in a body portal, so a press inside it is NOT an outside press. Treating it as
      one would close the panel before the card's click could select anything.
      */
      if (target instanceof Element && target.closest(".task-search-results")) return;
      setIsOpen(false);
    };
    document.addEventListener("mousedown", handleOutsidePress);
    return () => document.removeEventListener("mousedown", handleOutsidePress);
  }, []);

  const handleCloseClick = useCallback(() => {
    closePanel();
    onClose?.();
  }, [closePanel, onClose]);

  const selectTask = useCallback((task: Task) => {
    setIsOpen(false);
    if (onSelectTask) onSelectTask(task);
    else onSearchChange(task.id);
  }, [onSearchChange, onSelectTask]);

  return (
    <div ref={rootRef} className={`task-search-input header-search ${className}`.trim()} data-testid={testId}>
      <Search size={14} className="header-search-icon" aria-hidden="true" />
      <input
        ref={inputRef}
        autoFocus={autoFocus}
        type="text"
        /*
        The panel contains focusable CARDS, not options, so it is announced as a dialog rather than a
        listbox. A listbox of nested buttons would be a false promise to assistive technology.
        */
        role="combobox"
        aria-expanded={showPanel}
        aria-haspopup="dialog"
        aria-controls={showPanel ? panelId : undefined}
        aria-label={t("header.searchTasks", "Search tasks...")}
        placeholder={t("header.searchTasks", "Search tasks...")}
        title={t("header.taskSearchEnterHint", "Appuyez sur Entrée pour une recherche intelligente (Fast & Cheap)")}
        value={query}
        onChange={(event) => {
          onSearchChange(event.target.value);
          setIsOpen(true);
        }}
        onFocus={() => setIsOpen(true)}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            closePanel();
            return;
          }
          if (event.key === "Enter") {
            // An IME commit and an auto-repeated key are not an operator pressing Enter.
            if (composingRef.current || event.nativeEvent.isComposing || event.repeat) return;
            event.preventDefault();
            if (!query.trim()) return;
            setIsOpen(true);
            void search.runAiSearch();
            return;
          }
          if (event.key === "ArrowDown" && showPanel) {
            event.preventDefault();
            // Only one results panel is ever mounted, so the class selector is unambiguous and
            // avoids escaping React's `useId` value into a CSS selector.
            document.querySelector<HTMLElement>(".task-search-results .task-search-result .card")?.focus();
          }
        }}
        className="header-search-input"
      />
      {onClose && (
        <button
          type="button"
          className="header-search-clear"
          onClick={handleCloseClick}
          aria-label={closeLabel ?? t("header.closeSearch", "Close search")}
        >
          <X size={14} />
        </button>
      )}
      {showPanel && (
        <TaskSearchResultsPopover
          anchorRef={rootRef}
          panelId={panelId}
          tasks={search.tasks}
          lane={search.lane}
          loading={search.loading}
          aiLoading={search.aiLoading}
          hasMore={search.hasMore}
          error={search.error}
          progressKey={search.progressKey}
          collectionKey={search.collectionKey}
          onLoadMore={search.loadMore}
          onSelectTask={selectTask}
          addToast={addToast ?? (() => undefined)}
          {...(projectId ? { projectId } : {})}
        />
      )}
    </div>
  );
}
