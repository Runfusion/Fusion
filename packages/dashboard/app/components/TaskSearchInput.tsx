import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type Ref,
} from "react";
import { Search, Sparkles } from "lucide-react";
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

/*
FNXC:TaskSearch 2026-09-18-02:21:
FN-525 remplace la croix de fermeture du champ par un bouton « Search with AI ».

Pourquoi : depuis FN-477 la recherche intelligente ne se déclenchait qu'avec la touche Entrée, une
affordance invisible annoncée uniquement dans l'infobulle du champ. Elle a désormais un bouton
cliquable, rendu inconditionnellement (même sans `onClose`), désactivé tant que la requête est vide
ou qu'une recherche IA est déjà en vol.

Pourquoi Échap prend en charge `onClose` : la croix était la SEULE voie de fermeture du champ
flottant non-mobile, parce que l'hôte masque sa bascule `desktop-header-search-btn` tant que la
recherche est ouverte. Échap ferme donc le panneau PUIS remonte `onClose?.()`, ce qui aligne les
trois hôtes du header sur un contrat de fermeture unique (Échap, bascule loupe mobile, clic
extérieur pour le panneau).

Pourquoi un helper partagé : Entrée et le clic passent tous les deux par `triggerAiSearch`, pour que
les deux chemins de déclenchement ne puissent pas diverger (gardes requête vide / ouverture du
panneau / appel unique à `runAiSearch`).
*/

/**
 * FNXC:TaskTitleDisplay 2026-09-14-17:05:
 * Retained shape for hosts that hand over partial rows. The panel itself renders full `Task` rows.
 */
export type SearchableTask = Pick<Task, "id" | "title"> & { description?: string | null };

export interface TaskSearchInputProps {
  query: string;
  onSearchChange: (query: string) => void;
  /**
   * FNXC:TaskSearch 2026-09-17-07:43:
   * FN-494 — l'hôte reçoit la tâche choisie pour ouvrir sa fiche. Le champ est de toute façon vidé
   * via `onSearchChange("")` : aucun hôte ne reçoit jamais l'identifiant de tâche comme requête.
   */
  onSelectTask?: (task: Task) => void;
  onClose?: () => void;
  autoFocus?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  className?: string;
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

  /**
   * FNXC:TaskSearch 2026-09-18-02:21:
   * FN-525 — unique point de déclenchement de la lane IA, partagé par la touche Entrée et le bouton
   * « Search with AI » : une requête vide ne déclenche rien, sinon le panneau est ouvert puis la
   * recherche intelligente est lancée.
   *
   * Le déclenchement est différé d'un rendu quand la surface est encore fermée : le hook désactive
   * ses deux lanes tant que `active` est faux, donc appeler `runAiSearch()` dans le même tour que
   * `setIsOpen(true)` ne lancerait rien du tout. C'est exactement le cas du bouton, qui refuse le
   * focus pour ne pas interrompre la saisie et n'ouvre donc pas le panneau via `onFocus`.
   */
  const pendingAiSearchRef = useRef(false);
  const triggerAiSearch = useCallback(() => {
    if (!query.trim()) return;
    if (isOpen) {
      void search.runAiSearch();
      return;
    }
    pendingAiSearchRef.current = true;
    setIsOpen(true);
  }, [isOpen, query, search]);

  useEffect(() => {
    if (!isOpen || !pendingAiSearchRef.current) return;
    pendingAiSearchRef.current = false;
    void search.runAiSearch();
  }, [isOpen, search]);

  /*
  FNXC:TaskSearch 2026-09-17-07:43:
  FN-494 — choisir un résultat doit TOUJOURS faire la même chose, quel que soit l'hôte : vider le
  champ, fermer la recherche, ouvrir la fiche de la tâche.

  La branche de repli `onSearchChange(task.id)` est supprimée définitivement. Elle écrivait
  l'identifiant de la tâche dans le champ — donc dans le filtre Board/List pour les deux hôtes
  flottants du Header, qui ne fournissaient aucun `onSelectTask` — et n'ouvrait jamais la fiche :
  l'opérateur voyait sa saisie remplacée par `FN-42` sans obtenir la tâche.

  L'ordre est significatif : `closePanel()` ferme le panneau ET annule le travail texte/IA en vol
  (`search.reset()`) avant que l'hôte ne re-rende, puis le champ est remis à vide, puis la tâche est
  remontée à l'hôte qui ouvre la fiche.
  */
  const selectTask = useCallback((task: Task) => {
    closePanel();
    onSearchChange("");
    onSelectTask?.(task);
  }, [closePanel, onSearchChange, onSelectTask]);

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
            // Seule voie de fermeture du champ flottant non-mobile depuis FN-525.
            onClose?.();
            return;
          }
          if (event.key === "Enter") {
            // An IME commit and an auto-repeated key are not an operator pressing Enter.
            if (composingRef.current || event.nativeEvent.isComposing || event.repeat) return;
            event.preventDefault();
            triggerAiSearch();
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
      <button
        type="button"
        className="header-search-ai"
        data-testid="header-search-ai-btn"
        onClick={triggerAiSearch}
        // Cliquer le bouton ne doit pas retirer le focus du champ que l'opérateur est en train de saisir.
        onMouseDown={(event) => event.preventDefault()}
        disabled={!query.trim() || search.aiLoading}
        aria-label={t("header.searchWithAi", "Search with AI")}
      >
        <Sparkles size={14} aria-hidden="true" />
        <span>{t("header.searchWithAi", "Search with AI")}</span>
      </button>
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
