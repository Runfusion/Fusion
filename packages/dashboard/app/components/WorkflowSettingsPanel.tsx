/**
 * WorkflowSettingsPanel — the workflow editor's typed-settings surface (U6, R5).
 * Sibling to {@link WorkflowFieldsPanel} and {@link WorkflowColumnPanel}: lives
 * alongside the canvas in {@link WorkflowNodeEditor}. It is ONE panel with an
 * internal TAB PAIR (KTD-1/KTD-2):
 *
 *  - "Definitions" — declare/edit the workflow's typed settings (id, name, type,
 *    default, options for enum kinds, description, widget). Edits mutate
 *    `ir.settings` through the editor's shared `settings`/`onChange` state and
 *    ride the editor's existing IR Save flow; validation runs server-side at save
 *    (parseWorkflowIr) and surfaces through the editor's error band. Built-in
 *    workflows render this tab read-only (declarations are not editable; values
 *    are — KTD-2).
 *
 *  - "Values" — per-PROJECT setting values for the project active when the panel
 *    opened. Values batch in panel state and commit through a DEDICATED "Save
 *    values" button that sends ONE PATCH to the value authority route — never
 *    per-field writes, never fused with the IR Save (the two write authorities
 *    stay separate, KTD-2). Per-field typed rejections render on the matching
 *    rows. Below the live list, a collapsible "Orphaned values" disclosure (KTD-6
 *    drop-on-orphan) shows stored values that no longer validate against the
 *    current declarations, each with a delete affordance (null patch).
 *
 * The Values tab BINDS the projectId at open. If the dashboard's active project
 * changes while the editor is open, it shows a stale-context notice instead of
 * silently rebinding writes. With no active project it shows a requires-project
 * state and no write path.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2, AlertTriangle, ChevronRight, ChevronDown, Save, RotateCcw } from "lucide-react";
import type {
  WorkflowSettingDefinition,
  WorkflowSettingType,
  WorkflowSettingOption,
  WorkflowSettingRejection,
} from "../api";
import {
  fetchWorkflowSettingValues,
  updateWorkflowSettingValues,
  ApiRequestError,
  type WorkflowSettingValuesPayload,
} from "../api";
import {
  getWorkflowSettingDisplay,
  groupWorkflowSettings,
  WORKFLOW_SETTING_GROUP_LABELS,
} from "./workflow-setting-display";
import {
  SettingsToggleRow,
  SettingsNumberRow,
  SettingsSelectRow,
  SettingsTextRow,
  SettingsTextareaRow,
} from "./settings";
import type { ToastType } from "../hooks/useToast";
import "./WorkflowSettingsPanel.css";

interface WorkflowSettingsPanelProps {
  /** The workflow whose settings are being authored. */
  workflowId: string;
  /** Setting declarations (mirrors WorkflowFieldsPanel's `fields`). */
  settings: WorkflowSettingDefinition[];
  /** Mutate the declarations (rides the editor's IR save flow). */
  onChange: (next: WorkflowSettingDefinition[]) => void;
  /** Built-in workflows: declarations read-only; values editable (KTD-2). */
  readOnly: boolean;
  /** The active project id, bound for the Values tab at panel open. Undefined =
   *  no active project (Values tab shows a requires-project state). */
  projectId?: string;
  addToast: (message: string, type?: ToastType) => void;
}

const SETTING_TYPES: WorkflowSettingType[] = [
  "string",
  "text",
  "number",
  "boolean",
  "enum",
  "multi-enum",
];

/** Widgets valid per setting type (mirrors the SETTING_RENDER_WIDGETS whitelist
 *  client-side so the editor only offers legal combinations). */
const WIDGETS_BY_TYPE: Record<WorkflowSettingType, NonNullable<WorkflowSettingDefinition["render"]>["widget"][]> = {
  string: ["input"],
  text: ["textarea", "input"],
  number: ["input"],
  boolean: ["toggle"],
  enum: ["select", "radio", "chips"],
  "multi-enum": ["chips"],
};

/** Preset palette for enum option colors (matches WorkflowFieldsPanel). */
const PRESET_COLORS = [
  "#4f7cff",
  "#22c55e",
  "#f59e0b",
  "#ef4444",
  "#a855f7",
  "#06b6d4",
  "#ec4899",
  "#64748b",
];

function isEnumKind(type: WorkflowSettingType): boolean {
  return type === "enum" || type === "multi-enum";
}

function kebab(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

let settingSeq = 0;
function newSettingId(): string {
  settingSeq += 1;
  return `setting-${Date.now().toString(36)}-${settingSeq}`;
}

// ─── Definitions tab ─────────────────────────────────────────────────────────

function DefinitionsTab({
  settings,
  onChange,
  readOnly,
  addToast,
}: Pick<WorkflowSettingsPanelProps, "settings" | "onChange" | "readOnly" | "addToast">) {
  const { t } = useTranslation("app");
  const [editingId, setEditingId] = useState<string | null>(null);

  const patchSetting = useCallback(
    (id: string, patch: Partial<WorkflowSettingDefinition>) => {
      onChange(settings.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    },
    [settings, onChange],
  );

  const addSetting = useCallback(() => {
    onChange([
      ...settings,
      { id: newSettingId(), name: t("workflowSettings.newSettingName", "New setting"), type: "string" },
    ]);
  }, [settings, onChange, t]);

  const removeSetting = useCallback(
    (id: string) => onChange(settings.filter((s) => s.id !== id)),
    [settings, onChange],
  );

  const changeId = useCallback(
    (oldId: string, raw: string) => {
      const next = kebab(raw);
      if (!next) return;
      if (next !== oldId && settings.some((s) => s.id === next)) {
        addToast(t("workflowSettings.duplicateId", "A setting with that id already exists"), "error");
        return;
      }
      patchSetting(oldId, { id: next });
    },
    [settings, patchSetting, addToast, t],
  );

  const changeType = useCallback(
    (id: string, type: WorkflowSettingType) => {
      const setting = settings.find((s) => s.id === id);
      if (!setting) return;
      const patch: Partial<WorkflowSettingDefinition> = { type };
      if (isEnumKind(type)) {
        if (!setting.options || setting.options.length === 0) {
          patch.options = [{ value: "option-1", label: t("workflowSettings.newOptionLabel", "Option 1") }];
        }
      } else {
        patch.options = undefined;
      }
      if (setting.render?.widget && !WIDGETS_BY_TYPE[type].includes(setting.render.widget)) {
        patch.render = undefined;
      }
      // Default value type changed — clear it to avoid a type-mismatch at save.
      patch.default = undefined;
      patchSetting(id, patch);
    },
    [settings, patchSetting, t],
  );

  const setOptions = useCallback(
    (id: string, options: WorkflowSettingOption[]) => patchSetting(id, { options }),
    [patchSetting],
  );

  const renderDefaultInput = (setting: WorkflowSettingDefinition) => {
    const commit = (value: unknown) => patchSetting(setting.id, { default: value });
    if (setting.type === "boolean") {
      return (
        <label className="wf-setting--checkbox">
          <input
            type="checkbox"
            checked={setting.default === true}
            disabled={readOnly}
            onChange={(e) => commit(e.target.checked)}
          />
          <span>{t("workflowSettings.defaultTrue", "Default on")}</span>
        </label>
      );
    }
    if (isEnumKind(setting.type)) {
      const current =
        setting.type === "multi-enum"
          ? Array.isArray(setting.default)
            ? (setting.default as string[])[0] ?? ""
            : ""
          : typeof setting.default === "string"
            ? setting.default
            : "";
      return (
        <select
          aria-label={t("workflowSettings.defaultLabel", "Default value")}
          value={current}
          disabled={readOnly}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "") return commit(undefined);
            commit(setting.type === "multi-enum" ? [v] : v);
          }}
        >
          <option value="">{t("workflowSettings.noDefault", "— none —")}</option>
          {(setting.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    }
    const typeAttr = setting.type === "number" ? "number" : "text";
    const currentText =
      setting.type === "number"
        ? typeof setting.default === "number"
          ? String(setting.default)
          : ""
        : typeof setting.default === "string"
          ? setting.default
          : "";
    return (
      <input
        type={typeAttr}
        aria-label={t("workflowSettings.defaultLabel", "Default value")}
        defaultValue={currentText}
        disabled={readOnly}
        onBlur={(e) => {
          const raw = e.target.value;
          if (raw === "") return commit(undefined);
          commit(setting.type === "number" ? Number(raw) : raw);
        }}
      />
    );
  };

  return (
    <div className="wf-settings-tabpanel" data-testid="wf-settings-definitions">
      <div className="wf-settings-tabpanel-head">
        <button
          className="wf-settings-add"
          onClick={addSetting}
          disabled={readOnly}
          title={readOnly ? t("workflowSettings.readOnlyHint", "Built-in workflows are read-only — duplicate to edit") : undefined}
        >
          <Plus size={13} /> {t("workflowSettings.add", "Add setting")}
        </button>
      </div>

      {readOnly && (
        <p className="wf-settings-note wf-settings-note--info" role="note">
          {t("workflowSettings.builtinDefinitionsReadOnly", "Built-in workflow — declarations are read-only. Values are editable below.")}
        </p>
      )}

      {settings.length === 0 ? (
        <p className="wf-settings-empty">
          {t("workflowSettings.empty", "No settings declared yet. Add a setting to expose a typed, per-project knob.")}
        </p>
      ) : (
        <ul className="wf-settings-list">
          {settings.map((setting) => {
            const widgets = WIDGETS_BY_TYPE[setting.type];
            const idEditing = editingId === setting.id;
            return (
              <li key={setting.id} className="wf-setting-item" data-testid={`wf-setting-${setting.id}`}>
                <div className="wf-setting-item-head">
                  <input
                    className="wf-setting-name"
                    aria-label={t("workflowSettings.nameLabel", "Setting name")}
                    value={setting.name}
                    disabled={readOnly}
                    onChange={(e) => patchSetting(setting.id, { name: e.target.value })}
                  />
                  <button
                    className="wf-setting-remove"
                    aria-label={t("workflowSettings.remove", "Remove setting")}
                    disabled={readOnly}
                    onClick={() => removeSetting(setting.id)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>

                <div className="wf-setting-id-row">
                  {idEditing ? (
                    <>
                      <input
                        className="wf-setting-id"
                        aria-label={t("workflowSettings.idLabel", "Setting id")}
                        defaultValue={setting.id}
                        disabled={readOnly}
                        onBlur={(e) => {
                          changeId(setting.id, e.target.value);
                          setEditingId(null);
                        }}
                      />
                      <p className="wf-setting-id-warn" role="note">
                        <AlertTriangle size={11} aria-hidden />{" "}
                        {t("workflowSettings.idWarn", "Changing the id discards values stored under the old id (remove + add).")}
                      </p>
                    </>
                  ) : (
                    <>
                      <code className="wf-setting-id-static">{setting.id}</code>
                      <button
                        className="wf-setting-id-edit"
                        disabled={readOnly}
                        onClick={() => setEditingId(setting.id)}
                      >
                        {t("workflowSettings.editId", "Edit id")}
                      </button>
                    </>
                  )}
                </div>

                <div className="wf-setting-row">
                  <label className="wf-setting-sub">
                    <span>{t("workflowSettings.typeLabel", "Type")}</span>
                    <select
                      value={setting.type}
                      disabled={readOnly}
                      onChange={(e) => changeType(setting.id, e.target.value as WorkflowSettingType)}
                    >
                      {SETTING_TYPES.map((ty) => (
                        <option key={ty} value={ty}>
                          {ty}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="wf-setting-sub">
                    <span>{t("workflowSettings.widget", "Widget")}</span>
                    <select
                      value={setting.render?.widget ?? ""}
                      disabled={readOnly}
                      onChange={(e) =>
                        patchSetting(setting.id, {
                          render: e.target.value
                            ? { widget: e.target.value as NonNullable<WorkflowSettingDefinition["render"]>["widget"] }
                            : undefined,
                        })
                      }
                    >
                      <option value="">{t("workflowSettings.widgetDefault", "Default")}</option>
                      {widgets.map((w) => (
                        <option key={w} value={w}>
                          {w}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <label className="wf-setting-sub">
                  <span>{t("workflowSettings.default", "Default")}</span>
                  {renderDefaultInput(setting)}
                </label>

                <label className="wf-setting-sub">
                  <span>{t("workflowSettings.description", "Description")}</span>
                  <input
                    aria-label={t("workflowSettings.descriptionLabel", "Setting description")}
                    value={setting.description ?? ""}
                    disabled={readOnly}
                    onChange={(e) => patchSetting(setting.id, { description: e.target.value || undefined })}
                  />
                </label>

                {isEnumKind(setting.type) && (
                  <div className="wf-setting-options" data-testid={`wf-setting-options-${setting.id}`}>
                    <span className="wf-setting-options-label">{t("workflowSettings.options", "Options")}</span>
                    {(setting.options ?? []).map((opt, i) => (
                      <div key={i} className="wf-setting-option-row">
                        <input
                          className="wf-setting-option-value"
                          aria-label={t("workflowSettings.optionValue", "Option value")}
                          value={opt.value}
                          disabled={readOnly}
                          onChange={(e) => {
                            const next = [...(setting.options ?? [])];
                            next[i] = { ...opt, value: e.target.value };
                            setOptions(setting.id, next);
                          }}
                        />
                        <input
                          className="wf-setting-option-label"
                          aria-label={t("workflowSettings.optionLabel", "Option label")}
                          value={opt.label}
                          disabled={readOnly}
                          onChange={(e) => {
                            const next = [...(setting.options ?? [])];
                            next[i] = { ...opt, label: e.target.value };
                            setOptions(setting.id, next);
                          }}
                        />
                        <div
                          className="wf-setting-option-colors"
                          role="group"
                          aria-label={t("workflowSettings.optionColor", "Option color")}
                        >
                          {PRESET_COLORS.map((c) => (
                            <button
                              key={c}
                              type="button"
                              className={`wf-setting-color-swatch${opt.color === c ? " is-active" : ""}`}
                              style={{ backgroundColor: c }}
                              aria-label={c}
                              aria-pressed={opt.color === c}
                              disabled={readOnly}
                              onClick={() => {
                                const next = [...(setting.options ?? [])];
                                next[i] = { ...opt, color: opt.color === c ? undefined : c };
                                setOptions(setting.id, next);
                              }}
                            />
                          ))}
                        </div>
                        <button
                          className="wf-setting-option-remove"
                          aria-label={t("workflowSettings.removeOption", "Remove option")}
                          disabled={readOnly}
                          onClick={() => setOptions(setting.id, (setting.options ?? []).filter((_, j) => j !== i))}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))}
                    <button
                      className="wf-setting-option-add"
                      disabled={readOnly}
                      onClick={() => {
                        const n = (setting.options ?? []).length + 1;
                        setOptions(setting.id, [
                          ...(setting.options ?? []),
                          { value: `option-${n}`, label: t("workflowSettings.optionN", "Option {{n}}", { n }) },
                        ]);
                      }}
                    >
                      <Plus size={12} /> {t("workflowSettings.addOption", "Add option")}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ─── Values tab ──────────────────────────────────────────────────────────────

/** Stable display string for an orphaned/raw stored value. */
function rawValueDisplay(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function ValuesTab({
  workflowId,
  settings,
  boundProjectId,
  currentProjectId,
  addToast,
}: {
  workflowId: string;
  settings: WorkflowSettingDefinition[];
  /** projectId bound at panel open. Undefined → requires-project state. */
  boundProjectId: string | undefined;
  /** the dashboard's currently active project (may have changed since open). */
  currentProjectId: string | undefined;
  addToast: (message: string, type?: ToastType) => void;
}) {
  const { t } = useTranslation("app");
  const [payload, setPayload] = useState<WorkflowSettingValuesPayload | null>(null);
  const [loading, setLoading] = useState(false);
  // Batched, per-key pending edits. `null` = clear-to-default (delete the row).
  const [pending, setPending] = useState<Record<string, unknown>>({});
  const [rejections, setRejections] = useState<Record<string, WorkflowSettingRejection>>({});
  const [saving, setSaving] = useState(false);
  const [orphanOpen, setOrphanOpen] = useState(false);
  const reqSeq = useRef(0);

  const staleContext =
    boundProjectId !== undefined && currentProjectId !== undefined && currentProjectId !== boundProjectId;

  const load = useCallback(async () => {
    if (boundProjectId === undefined) return;
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const res = await fetchWorkflowSettingValues(workflowId, boundProjectId);
      if (reqSeq.current === seq) {
        setPayload(res);
        setPending({});
        setRejections({});
      }
    } catch {
      if (reqSeq.current === seq) addToast(t("workflowSettings.loadFailed", "Failed to load setting values"), "error");
    } finally {
      if (reqSeq.current === seq) setLoading(false);
    }
  }, [workflowId, boundProjectId, addToast, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // No active project bound → requires-project state, no write path.
  if (boundProjectId === undefined) {
    return (
      <div className="wf-settings-tabpanel" data-testid="wf-settings-values">
        <p className="wf-settings-note wf-settings-note--info" role="note">
          {t("workflowSettings.requiresProject", "Open a project to view and edit per-project setting values.")}
        </p>
      </div>
    );
  }

  // The effective value to show for a setting: a pending edit (incl. a pending
  // clear, which falls back to the declaration default) wins over the server
  // effective value.
  const effectiveOf = (setting: WorkflowSettingDefinition): unknown => {
    if (Object.prototype.hasOwnProperty.call(pending, setting.id)) {
      const p = pending[setting.id];
      return p === null ? setting.default : p;
    }
    return payload?.effective?.[setting.id] ?? setting.default;
  };

  // "customized" iff a stored row holds this key (server) OR a pending non-clear
  // edit exists; a pending clear removes the customized state.
  const isCustomized = (setting: WorkflowSettingDefinition): boolean => {
    if (Object.prototype.hasOwnProperty.call(pending, setting.id)) {
      return pending[setting.id] !== null;
    }
    return payload ? Object.prototype.hasOwnProperty.call(payload.stored, setting.id) : false;
  };

  const setValue = (id: string, value: unknown) => {
    setPending((prev) => ({ ...prev, [id]: value }));
    setRejections((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const clearValue = (id: string) => setValue(id, null);

  const dirty = Object.keys(pending).length > 0;

  const save = useCallback(async () => {
    if (!dirty) return;
    setSaving(true);
    try {
      const res = await updateWorkflowSettingValues(workflowId, pending, boundProjectId);
      setPayload(res);
      setPending({});
      setRejections({});
      addToast(t("workflowSettings.valuesSaved", "Setting values saved"), "success");
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 400 && err.details) {
        const rejList = (err.details.rejections as WorkflowSettingRejection[] | undefined) ?? [];
        if (rejList.length > 0) {
          const byId: Record<string, WorkflowSettingRejection> = {};
          for (const r of rejList) byId[r.settingId] = r;
          setRejections(byId);
          // The server persisted nothing on rejection (write-boundary contract):
          // keep ALL pending edits applied so the user can fix the offending
          // field(s) and re-save.
          addToast(t("workflowSettings.valuesRejected", "Some values were rejected — see the highlighted fields"), "error");
          return;
        }
      }
      addToast(t("workflowSettings.saveFailed", "Failed to save setting values"), "error");
    } finally {
      setSaving(false);
    }
  }, [dirty, workflowId, pending, boundProjectId, addToast, t]);

  const renderValueControl = (setting: WorkflowSettingDefinition) => {
    const value = effectiveOf(setting);
    const error = rejections[setting.id]?.message;
    const customized = isCustomized(setting);
    const display = getWorkflowSettingDisplay(setting);
    const descriptor = {
      key: setting.id,
      label: display.label,
      help: display.description ?? setting.description,
      scope: "project" as const,
    };
    const clearable = customized;

    switch (setting.type) {
      case "boolean":
        return (
          <SettingsToggleRow
            descriptor={descriptor}
            value={value === true}
            error={error}
            clearable={clearable}
            onChange={(v) => (v === null ? clearValue(setting.id) : setValue(setting.id, v))}
          />
        );
      case "number":
        return (
          <SettingsNumberRow
            descriptor={descriptor}
            value={typeof value === "number" ? value : null}
            error={error}
            clearable={clearable}
            onChange={(v) => (v === null ? clearValue(setting.id) : setValue(setting.id, v))}
          />
        );
      case "enum":
        return (
          <SettingsSelectRow
            descriptor={{ ...descriptor, options: (setting.options ?? []).map((o) => ({ value: o.value, label: o.label })) }}
            value={typeof value === "string" ? value : null}
            error={error}
            clearable={clearable}
            onChange={(v) => (v === null ? clearValue(setting.id) : setValue(setting.id, v))}
          />
        );
      case "multi-enum": {
        // No multi-select primitive in U8 yet; offer the first/clear via select.
        const current = Array.isArray(value) ? (value as string[])[0] ?? null : null;
        return (
          <SettingsSelectRow
            descriptor={{ ...descriptor, options: (setting.options ?? []).map((o) => ({ value: o.value, label: o.label })) }}
            value={current}
            error={error}
            clearable={clearable}
            onChange={(v) => (v === null ? clearValue(setting.id) : setValue(setting.id, [v]))}
          />
        );
      }
      case "text":
        return (
          <SettingsTextareaRow
            descriptor={descriptor}
            value={typeof value === "string" ? value : null}
            error={error}
            clearable={clearable}
            onChange={(v) => (v === null || v === "" ? clearValue(setting.id) : setValue(setting.id, v))}
          />
        );
      case "string":
      default:
        return (
          <SettingsTextRow
            descriptor={descriptor}
            value={typeof value === "string" ? value : null}
            error={error}
            clearable={clearable}
            onChange={(v) => (v === null || v === "" ? clearValue(setting.id) : setValue(setting.id, v))}
          />
        );
    }
  };

  const orphaned = payload?.orphaned ?? [];

  const deleteOrphan = useCallback(
    async (id: string) => {
      try {
        const res = await updateWorkflowSettingValues(workflowId, { [id]: null }, boundProjectId);
        setPayload(res);
        addToast(t("workflowSettings.orphanDeleted", "Orphaned value removed"), "success");
      } catch {
        addToast(t("workflowSettings.saveFailed", "Failed to save setting values"), "error");
      }
    },
    [workflowId, boundProjectId, addToast, t],
  );

  return (
    <div className="wf-settings-tabpanel" data-testid="wf-settings-values">
      {staleContext && (
        <p className="wf-settings-note wf-settings-note--warn" role="note" data-testid="wf-settings-stale-notice">
          <AlertTriangle size={12} aria-hidden />{" "}
          {t(
            "workflowSettings.staleContext",
            "Values shown are for project {{project}} — reopen the editor to edit values for the current project.",
            { project: boundProjectId },
          )}
        </p>
      )}

      <div className="wf-settings-values-head">
        <button
          className="wf-settings-save-values"
          onClick={save}
          disabled={!dirty || saving || staleContext}
          data-testid="wf-settings-save-values"
        >
          <Save size={13} /> {t("workflowSettings.saveValues", "Save values")}
        </button>
      </div>

      {settings.length === 0 ? (
        <p className="wf-settings-empty">
          {loading
            ? t("workflowSettings.loading", "Loading…")
            : t("workflowSettings.noDeclarations", "This workflow declares no settings, so there are no values to edit.")}
        </p>
      ) : (
        <div className="wf-settings-values-list">
          {groupWorkflowSettings(settings).map(({ group, settings: groupSettings }) => (
            <section key={group} className="wf-settings-value-group" data-testid={`wf-settings-group-${group}`}>
              <h4 className="wf-settings-value-group-title">
                {t(`workflowSettings.group.${group}`, WORKFLOW_SETTING_GROUP_LABELS[group])}
              </h4>
              {groupSettings.map((setting) => (
                <div key={setting.id} className="wf-settings-value-item" data-testid={`wf-settings-value-${setting.id}`}>
                  {renderValueControl(setting)}
                  {isCustomized(setting) && (
                    <span className="wf-settings-customized" data-testid={`wf-settings-customized-${setting.id}`}>
                      {t("workflowSettings.customized", "Customized")}
                    </span>
                  )}
                </div>
              ))}
            </section>
          ))}
        </div>
      )}

      {orphaned.length > 0 && (
        <div className="wf-settings-orphaned" data-testid="wf-settings-orphaned">
          <button
            className="wf-settings-orphaned-toggle"
            onClick={() => setOrphanOpen((v) => !v)}
            aria-expanded={orphanOpen}
          >
            {orphanOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{" "}
            {t("workflowSettings.orphanedTitle", "Orphaned values ({{count}})", { count: orphaned.length })}
          </button>
          {orphanOpen && (
            <div className="wf-settings-orphaned-body">
              <p className="wf-settings-note wf-settings-note--muted" role="note">
                {t(
                  "workflowSettings.orphanedNote",
                  "These stored values no longer match a current declaration (the setting was retyped or removed). They are ignored by the engine; delete them to clean up.",
                )}
              </p>
              <ul className="wf-settings-orphaned-list">
                {orphaned.map((o) => (
                  <li key={o.id} className="wf-settings-orphaned-row" data-testid={`wf-settings-orphan-${o.id}`}>
                    <code className="wf-settings-orphan-id">{o.id}</code>
                    <span className="wf-settings-orphan-value">{rawValueDisplay(o.value)}</span>
                    <button
                      className="wf-settings-orphan-delete"
                      aria-label={t("workflowSettings.deleteOrphan", "Delete orphaned value")}
                      disabled={staleContext || saving}
                      onClick={() => deleteOrphan(o.id)}
                    >
                      <Trash2 size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {settings.length > 0 && (
        <p className="wf-settings-reset-hint" role="note">
          <RotateCcw size={11} aria-hidden />{" "}
          {t("workflowSettings.clearHint", "Use the reset control on a row to clear a value back to its declaration default.")}
        </p>
      )}
    </div>
  );
}

// ─── Panel shell (tab pair) ──────────────────────────────────────────────────

export function WorkflowSettingsPanel({
  workflowId,
  settings,
  onChange,
  readOnly,
  projectId,
  addToast,
}: WorkflowSettingsPanelProps) {
  const { t } = useTranslation("app");
  const [tab, setTab] = useState<"definitions" | "values">(() => (settings.length > 0 ? "values" : "definitions"));

  // Bind the projectId active when the panel first mounted for this workflow.
  // The Values tab uses this bound id; a later change to `projectId` surfaces a
  // stale-context notice rather than rebinding writes. Re-bind only when the
  // workflow itself changes (the editor re-keys/remounts per active workflow).
  const boundRef = useRef<{ workflowId: string; projectId: string | undefined }>({ workflowId, projectId });
  if (boundRef.current.workflowId !== workflowId) {
    boundRef.current = { workflowId, projectId };
  }
  const boundProjectId = boundRef.current.projectId;

  return (
    <aside className="wf-settings-panel" data-testid="wf-settings-panel">
      <header className="wf-settings-panel-header">
        <h3>{t("workflowSettings.title", "Settings")}</h3>
      </header>

      <div className="wf-settings-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "definitions"}
          className={`wf-settings-tab${tab === "definitions" ? " is-active" : ""}`}
          onClick={() => setTab("definitions")}
          data-testid="wf-settings-tab-definitions"
        >
          {t("workflowSettings.definitionsTab", "Definitions")}
        </button>
        <button
          role="tab"
          aria-selected={tab === "values"}
          className={`wf-settings-tab${tab === "values" ? " is-active" : ""}`}
          onClick={() => setTab("values")}
          data-testid="wf-settings-tab-values"
        >
          {t("workflowSettings.valuesTab", "Values")}
        </button>
      </div>

      {tab === "definitions" ? (
        <DefinitionsTab settings={settings} onChange={onChange} readOnly={readOnly} addToast={addToast} />
      ) : (
        <ValuesTab
          key={workflowId}
          workflowId={workflowId}
          settings={settings}
          boundProjectId={boundProjectId}
          currentProjectId={projectId}
          addToast={addToast}
        />
      )}
    </aside>
  );
}

export default WorkflowSettingsPanel;
