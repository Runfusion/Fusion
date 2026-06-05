import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2, ChevronUp, ChevronDown, AlertTriangle } from "lucide-react";
import type { WorkflowIrColumn, TraitViolation } from "@fusion/core";
import { fetchTraits, type TraitCatalogEntry } from "../api";
import { getErrorMessage } from "@fusion/core";
import type { ToastType } from "../hooks/useToast";

interface WorkflowColumnPanelProps {
  columns: WorkflowIrColumn[];
  onChange: (next: WorkflowIrColumn[]) => void;
  /** Column-level composition violations (from validateColumnTraits) to surface
   *  on the offending column band. Keyed by column id; workflow-wide violations
   *  (columnId === null) are shown at the panel head. */
  violations: TraitViolation[];
  readOnly: boolean;
  projectId?: string;
  addToast: (message: string, type?: ToastType) => void;
}

let columnSeq = 0;
function newColumnId(): string {
  columnSeq += 1;
  return `col-${Date.now().toString(36)}-${columnSeq}`;
}

export function WorkflowColumnPanel({
  columns,
  onChange,
  violations,
  readOnly,
  projectId,
  addToast,
}: WorkflowColumnPanelProps) {
  const { t } = useTranslation("app");
  const [catalog, setCatalog] = useState<TraitCatalogEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchTraits(projectId)
      .then((catalog) => {
        if (!cancelled) setCatalog(catalog);
      })
      .catch((err) => {
        if (!cancelled) addToast(getErrorMessage(err) || t("workflowColumns.traitsLoadFailed", "Failed to load traits"), "error");
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, addToast, t]);

  const workflowWide = violations.filter((v) => v.columnId === null);
  const violationsFor = useCallback(
    (columnId: string) => violations.filter((v) => v.columnId === columnId),
    [violations],
  );

  const addColumn = useCallback(() => {
    const id = newColumnId();
    onChange([...columns, { id, name: t("workflowColumns.newColumnName", "New column"), traits: [] }]);
  }, [columns, onChange, t]);

  const renameColumn = useCallback(
    (id: string, name: string) => {
      onChange(columns.map((c) => (c.id === id ? { ...c, name } : c)));
    },
    [columns, onChange],
  );

  const removeColumn = useCallback(
    (id: string) => {
      onChange(columns.filter((c) => c.id !== id));
    },
    [columns, onChange],
  );

  const moveColumn = useCallback(
    (index: number, dir: -1 | 1) => {
      const target = index + dir;
      if (target < 0 || target >= columns.length) return;
      const next = [...columns];
      [next[index], next[target]] = [next[target], next[index]];
      onChange(next);
    },
    [columns, onChange],
  );

  const toggleTrait = useCallback(
    (columnId: string, traitId: string) => {
      onChange(
        columns.map((c) => {
          if (c.id !== columnId) return c;
          const has = c.traits.some((tr) => tr.trait === traitId);
          return {
            ...c,
            traits: has
              ? c.traits.filter((tr) => tr.trait !== traitId)
              : [...c.traits, { trait: traitId }],
          };
        }),
      );
    },
    [columns, onChange],
  );

  return (
    <aside className="wf-column-panel" data-testid="wf-column-panel">
      <header className="wf-column-panel-header">
        <h3>{t("workflowColumns.title", "Columns")}</h3>
        <button
          className="wf-column-add"
          onClick={addColumn}
          disabled={readOnly}
          title={readOnly ? t("workflowColumns.readOnlyHint", "Built-in workflows are read-only — duplicate to edit") : undefined}
        >
          <Plus size={13} /> {t("workflowColumns.add", "Add column")}
        </button>
      </header>

      {workflowWide.length > 0 && (
        <div className="wf-column-panel-errors" role="alert">
          {workflowWide.map((v, i) => (
            <p key={`${v.code}-${i}`} className="wf-column-violation">
              <AlertTriangle size={12} aria-hidden /> {v.message}
            </p>
          ))}
        </div>
      )}

      {columns.length === 0 ? (
        <p className="wf-column-panel-empty">
          {t("workflowColumns.empty", "No columns yet. Add a column to place nodes into board lanes.")}
        </p>
      ) : (
        <ul className="wf-column-list">
          {columns.map((col, index) => {
            const colViolations = violationsFor(col.id);
            return (
              <li
                key={col.id}
                className={`wf-column-item${colViolations.length ? " wf-column-item--error" : ""}`}
                data-testid={`wf-column-${col.id}`}
                data-column-error={colViolations.length ? "true" : undefined}
              >
                <div className="wf-column-item-head">
                  <input
                    className="wf-column-name"
                    aria-label={t("workflowColumns.nameLabel", "Column name")}
                    value={col.name}
                    disabled={readOnly}
                    onChange={(e) => renameColumn(col.id, e.target.value)}
                  />
                  <div className="wf-column-item-actions">
                    <button
                      className="wf-column-move"
                      aria-label={t("workflowColumns.moveUp", "Move column up")}
                      disabled={readOnly || index === 0}
                      onClick={() => moveColumn(index, -1)}
                    >
                      <ChevronUp size={13} />
                    </button>
                    <button
                      className="wf-column-move"
                      aria-label={t("workflowColumns.moveDown", "Move column down")}
                      disabled={readOnly || index === columns.length - 1}
                      onClick={() => moveColumn(index, 1)}
                    >
                      <ChevronDown size={13} />
                    </button>
                    <button
                      className="wf-column-remove"
                      aria-label={t("workflowColumns.remove", "Remove column")}
                      disabled={readOnly}
                      onClick={() => removeColumn(col.id)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>

                {colViolations.map((v, i) => (
                  <p key={`${v.code}-${i}`} className="wf-column-violation" role="alert">
                    <AlertTriangle size={12} aria-hidden /> {v.message}
                  </p>
                ))}

                <div className="wf-column-traits">
                  <span className="wf-column-traits-label">{t("workflowColumns.traits", "Traits")}</span>
                  <div className="wf-column-trait-options">
                    {catalog.map((trait) => {
                      const checked = col.traits.some((tr) => tr.trait === trait.id);
                      return (
                        <label key={trait.id} className="wf-column-trait" title={trait.description}>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={readOnly}
                            onChange={() => toggleTrait(col.id, trait.id)}
                          />
                          <span>{trait.name}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
