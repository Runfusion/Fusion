import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2, ChevronUp, ChevronDown, AlertTriangle, Bot } from "lucide-react";
import type { WorkflowIrColumn, WorkflowColumnAgent, TraitViolation } from "@fusion/core";
import { fetchTraits, fetchAgents, type TraitCatalogEntry } from "../api";
import type { Agent } from "../api";
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
  /** True only when BOTH `experimentalFeatures.workflowColumns` AND
   *  `experimentalFeatures.workflowGraphExecutor` are on. When false, the
   *  per-column agent picker is disabled (not hidden) with a hint naming both
   *  flags — config is data, so bindings still round-trip, but column agents are
   *  inert at execution time (R10). */
  columnAgentsEnabled: boolean;
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
  columnAgentsEnabled,
}: WorkflowColumnPanelProps) {
  const { t } = useTranslation("app");
  const [catalog, setCatalog] = useState<TraitCatalogEntry[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [agentsError, setAgentsError] = useState<string | null>(null);

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

  // Eagerly load the agent registry for the per-column picker (R11). Mirrors the
  // fetchTraits-on-mount pattern above (cancelled guard + toast), but ALSO keeps
  // an inline error near the picker rather than only a toast, so a failed fetch
  // is visible at the point of use.
  useEffect(() => {
    let cancelled = false;
    setAgentsLoading(true);
    setAgentsError(null);
    // Promise.resolve guards against test mocks that return undefined.
    Promise.resolve(fetchAgents(undefined, projectId))
      .then((list) => {
        if (cancelled) return;
        setAgents(list ?? []);
        setAgentsLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        const message = getErrorMessage(err) || t("workflowColumns.agentsLoadFailed", "Failed to load agents");
        setAgentsError(message);
        setAgentsLoading(false);
        addToast(message, "error");
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, addToast, t]);

  // Key derived agent lookups on the joined id string, never on array identity —
  // SWR/dedupe can hand back a fresh array with identical ids and we must not
  // churn selection/derived state on that (skill-autocomplete SWR learning).
  const agentIdsKey = useMemo(() => agents.map((a) => a.id).join(","), [agents]);
  const agentById = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents) map.set(a.id, a);
    return map;
    // Keyed on the joined id string (not array identity) per the SWR-identity
    // learning: a fresh array with identical ids must not churn derived state.
    // (exhaustive-deps is not enforced in this package; the omission of `agents`
    // from the dep array is intentional — agentIdsKey is the stable identity.)
  }, [agentIdsKey]);

  const setColumnAgent = useCallback(
    (id: string, agent: WorkflowColumnAgent | undefined) => {
      onChange(
        columns.map((c) => {
          if (c.id !== id) return c;
          if (!agent) {
            // Clearing to "(none)" REMOVES the key entirely — never write
            // `agent: null` (R9 parity: omitted-when-unset).
            const { agent: _omit, ...rest } = c;
            return rest;
          }
          return { ...c, agent };
        }),
      );
    },
    [columns, onChange],
  );

  const selectColumnAgentId = useCallback(
    (id: string, agentId: string) => {
      if (!agentId) {
        setColumnAgent(id, undefined);
        return;
      }
      const existing = columns.find((c) => c.id === id)?.agent;
      // Preserve an existing mode; default new selections to "defer" (the less
      // surprising mode).
      setColumnAgent(id, { agentId, mode: existing?.mode ?? "defer" });
    },
    [columns, setColumnAgent],
  );

  const setColumnAgentMode = useCallback(
    (id: string, mode: "defer" | "override") => {
      const existing = columns.find((c) => c.id === id)?.agent;
      if (!existing) return;
      setColumnAgent(id, { ...existing, mode });
    },
    [columns, setColumnAgent],
  );

  // `!!agentsError` (PR #1432 review): when the registry fetch failed, the select
  // would render enabled with only "(none)" while the bound id has no matching
  // option — interacting with it could silently clear a binding. Disabled while
  // the registry is unavailable, consistent with the loading guard.
  const agentPickerDisabled = readOnly || !columnAgentsEnabled || agentsLoading || !!agentsError;

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
            const boundAgentId = col.agent?.agentId;
            const boundAgent = boundAgentId ? agentById.get(boundAgentId) : undefined;
            // A stored id that is not in the loaded registry list is "stale":
            // render a not-found warning and PRESERVE the IR value until the
            // author explicitly clears or replaces it (R11).
            const boundAgentStale = !!boundAgentId && !agentsLoading && !agentsError && !boundAgent;
            const boundAgentLabel = boundAgent?.name
              ?? (boundAgentStale
                ? t("workflowColumns.agentNotFound", "Agent not found — {{id}}", { id: boundAgentId ?? "" })
                : boundAgentId);
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
                  {boundAgentId && (
                    <span
                      className={`wf-column-agent-badge${boundAgentStale ? " wf-column-agent-badge--stale" : ""}`}
                      data-testid={`wf-column-agent-badge-${col.id}`}
                      title={col.agent?.mode === "override"
                        ? t("workflowColumns.agentBadgeOverride", "Column agent (override)")
                        : t("workflowColumns.agentBadgeDefer", "Column agent (defer)")}
                    >
                      <Bot size={11} aria-hidden /> {boundAgentLabel}
                    </span>
                  )}
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

                <div className="wf-column-agent">
                  <span className="wf-column-agent-label">{t("workflowColumns.agent", "Column agent")}</span>
                  <select
                    className="wf-column-agent-select"
                    data-testid={`wf-column-agent-select-${col.id}`}
                    aria-label={t("workflowColumns.agentLabel", "Column agent")}
                    value={boundAgentId ?? ""}
                    disabled={agentPickerDisabled}
                    title={!columnAgentsEnabled
                      ? t(
                          "workflowColumns.agentFlagHint",
                          "Enable both experimentalFeatures.workflowColumns and experimentalFeatures.workflowGraphExecutor to staff columns with agents",
                        )
                      : readOnly
                        ? t("workflowColumns.readOnlyHint", "Built-in workflows are read-only — duplicate to edit")
                        : undefined}
                    onChange={(e) => selectColumnAgentId(col.id, e.target.value)}
                  >
                    <option value="">{t("workflowColumns.agentNone", "(none)")}</option>
                    {/* Stale id: keep it selectable so the IR value is preserved
                        until the author explicitly clears or replaces it (R11). */}
                    {boundAgentStale && boundAgentId && (
                      <option value={boundAgentId}>
                        {t("workflowColumns.agentNotFound", "Agent not found — {{id}}", { id: boundAgentId })}
                      </option>
                    )}
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>

                  {agentsError && (
                    <p className="wf-column-agent-error" role="alert">
                      <AlertTriangle size={12} aria-hidden /> {agentsError}
                    </p>
                  )}
                  {boundAgentStale && (
                    <p className="wf-column-agent-stale" role="alert" data-testid={`wf-column-agent-stale-${col.id}`}>
                      <AlertTriangle size={12} aria-hidden />{" "}
                      {t("workflowColumns.agentNotFound", "Agent not found — {{id}}", { id: boundAgentId ?? "" })}
                    </p>
                  )}

                  {boundAgentId && (
                    <div className="wf-column-agent-mode" role="radiogroup" aria-label={t("workflowColumns.agentMode", "Agent mode")}>
                      <label className="wf-column-agent-mode-option">
                        <input
                          type="radio"
                          name={`wf-column-agent-mode-${col.id}`}
                          checked={(col.agent?.mode ?? "defer") === "defer"}
                          disabled={agentPickerDisabled}
                          onChange={() => setColumnAgentMode(col.id, "defer")}
                        />
                        <span title={t("workflowColumns.agentModeDeferHint", "Column agent applies only when the work carries no agent/model settings of its own")}>
                          {t("workflowColumns.agentModeDefer", "Defer")}
                        </span>
                      </label>
                      <label className="wf-column-agent-mode-option">
                        <input
                          type="radio"
                          name={`wf-column-agent-mode-${col.id}`}
                          checked={col.agent?.mode === "override"}
                          disabled={agentPickerDisabled}
                          onChange={() => setColumnAgentMode(col.id, "override")}
                        />
                        <span title={t("workflowColumns.agentModeOverrideHint", "Column agent supersedes node- and task-level agent/model settings")}>
                          {t("workflowColumns.agentModeOverride", "Override")}
                        </span>
                      </label>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
