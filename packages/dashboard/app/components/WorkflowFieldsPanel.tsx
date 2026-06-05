/**
 * WorkflowFieldsPanel — the workflow editor's custom-field authoring surface
 * (U13 / KTD-14). Sibling to {@link WorkflowColumnPanel}: lives alongside the
 * canvas in {@link WorkflowNodeEditor} and mutates the IR's `fields` array
 * through the same state/save flow.
 *
 * Each field has: an immutable kebab-case `id` (editing it is remove+add
 * semantics — the panel warns rather than silently re-keying values), a display
 * `name`, a `type` (string|text|number|boolean|enum|multi-enum|date|url), a
 * `required` toggle, a typed `default`, an options editor (value/label/color)
 * for the enum kinds, and `render` controls (placement, widget, badge).
 *
 * Card-placed fields show a live badge preview reusing TaskCard's
 * `.card-field-badge` classes so the authored chip matches the board exactly.
 *
 * Core validation (unique ids, options-required-for-enums, render whitelists)
 * runs server-side at save and surfaces through the editor's existing inline
 * mechanism — this panel only does light client guards and renders the
 * resulting message via the shared error band.
 */
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2, AlertTriangle } from "lucide-react";
import type {
  WorkflowFieldDefinition,
  WorkflowFieldType,
  WorkflowFieldOption,
} from "../api";
import type { ToastType } from "../hooks/useToast";
import "./WorkflowFieldsPanel.css";

interface WorkflowFieldsPanelProps {
  fields: WorkflowFieldDefinition[];
  onChange: (next: WorkflowFieldDefinition[]) => void;
  readOnly: boolean;
  addToast: (message: string, type?: ToastType) => void;
}

const FIELD_TYPES: WorkflowFieldType[] = [
  "string",
  "text",
  "number",
  "boolean",
  "enum",
  "multi-enum",
  "date",
  "url",
];

/** Widgets valid per field type (the validator's whitelist mirrored client-side
 *  so the editor only offers legal combinations). */
const WIDGETS_BY_TYPE: Record<WorkflowFieldType, NonNullable<WorkflowFieldDefinition["render"]>["widget"][]> = {
  string: ["input"],
  text: ["textarea", "input"],
  number: ["input"],
  boolean: ["toggle"],
  enum: ["select", "radio", "chips"],
  "multi-enum": ["chips"],
  date: ["input"],
  url: ["input"],
};

/** A small preset palette for enum option colors (no dedicated color-picker
 *  component exists in the editor; the column panel uses none). */
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

function isEnumKind(type: WorkflowFieldType): boolean {
  return type === "enum" || type === "multi-enum";
}

/** Slugify a free-typed id into kebab-case (the validator accepts any non-empty
 *  string id, but kebab-case is the authoring convention). */
function kebab(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

let fieldSeq = 0;
function newFieldId(): string {
  fieldSeq += 1;
  return `field-${Date.now().toString(36)}-${fieldSeq}`;
}

/** A live badge preview for a card-placed field, styled exactly like a TaskCard
 *  badge (reuses `.card-field-badge` classes). */
function FieldBadgePreview({ field }: { field: WorkflowFieldDefinition }) {
  const sample = useMemo<{ node: React.ReactNode } | null>(() => {
    if (isEnumKind(field.type)) {
      const opt = field.options?.[0];
      if (!opt) return null;
      if (field.type === "multi-enum") {
        return {
          node: (
            <span className="card-field-badge card-field-badge--multi" title={field.name}>
              {(field.options ?? []).slice(0, 2).map((o) => (
                <span
                  key={o.value}
                  className="card-field-badge-token"
                  style={o.color ? { backgroundColor: o.color, borderColor: o.color, color: "#fff" } : undefined}
                >
                  {o.label}
                </span>
              ))}
            </span>
          ),
        };
      }
      return {
        node: (
          <span
            className="card-field-badge card-field-badge--enum"
            title={`${field.name}: ${opt.label}`}
            style={opt.color ? { backgroundColor: opt.color, borderColor: opt.color, color: "#fff" } : undefined}
          >
            {opt.label}
          </span>
        ),
      };
    }
    if (field.type === "boolean") {
      return {
        node: (
          <span className="card-field-badge card-field-badge--boolean" title={field.name}>
            {field.name}
          </span>
        ),
      };
    }
    // string / text / number / date / url → simple labeled chip with sample text.
    const sampleText =
      field.type === "number" ? "42" : field.type === "date" ? "2026-06-04" : field.type === "url" ? "example.com" : field.name;
    return {
      node: (
        <span className="card-field-badge" title={field.name}>
          {sampleText}
        </span>
      ),
    };
  }, [field]);

  if (!sample) return null;
  return (
    <div className="wf-field-preview" data-testid={`wf-field-preview-${field.id}`}>
      <div className="card-field-badges">{sample.node}</div>
    </div>
  );
}

export function WorkflowFieldsPanel({ fields, onChange, readOnly, addToast }: WorkflowFieldsPanelProps) {
  const { t } = useTranslation("app");
  // Per-field "editing the id" disclosure: editing an id is remove+add and is
  // gated behind an explicit affordance so values are not silently re-keyed.
  const [editingId, setEditingId] = useState<string | null>(null);

  const patchField = useCallback(
    (id: string, patch: Partial<WorkflowFieldDefinition>) => {
      onChange(fields.map((f) => (f.id === id ? { ...f, ...patch } : f)));
    },
    [fields, onChange],
  );

  const addField = useCallback(() => {
    const id = newFieldId();
    onChange([
      ...fields,
      { id, name: t("workflowFields.newFieldName", "New field"), type: "string" },
    ]);
  }, [fields, onChange, t]);

  const removeField = useCallback(
    (id: string) => {
      onChange(fields.filter((f) => f.id !== id));
    },
    [fields, onChange],
  );

  const changeId = useCallback(
    (oldId: string, raw: string) => {
      const next = kebab(raw);
      if (!next) return;
      if (next !== oldId && fields.some((f) => f.id === next)) {
        addToast(t("workflowFields.duplicateId", "A field with that id already exists"), "error");
        return;
      }
      patchField(oldId, { id: next });
    },
    [fields, patchField, addToast, t],
  );

  const changeType = useCallback(
    (id: string, type: WorkflowFieldType) => {
      const field = fields.find((f) => f.id === id);
      if (!field) return;
      const patch: Partial<WorkflowFieldDefinition> = { type };
      // Options only valid for enum kinds — seed an empty list when switching to
      // an enum kind, strip it otherwise (validator: options iff enum-kind).
      if (isEnumKind(type)) {
        if (!field.options || field.options.length === 0) {
          patch.options = [{ value: "option-1", label: t("workflowFields.newOptionLabel", "Option 1") }];
        }
      } else {
        patch.options = undefined;
      }
      // Reset a now-invalid widget to the type's default (first valid widget).
      if (field.render?.widget && !WIDGETS_BY_TYPE[type].includes(field.render.widget)) {
        patch.render = { ...field.render, widget: undefined };
      }
      // Default value type changed — clear it to avoid a type-mismatch at save.
      patch.default = undefined;
      patchField(id, patch);
    },
    [fields, patchField, t],
  );

  const setOptions = useCallback(
    (id: string, options: WorkflowFieldOption[]) => patchField(id, { options }),
    [patchField],
  );

  const setRender = useCallback(
    (id: string, render: WorkflowFieldDefinition["render"]) => {
      // Drop an all-empty render object so v1/zero-field round-trips stay clean.
      const empty = !render || (render.placement === undefined && render.widget === undefined && !render.badge);
      patchField(id, { render: empty ? undefined : render });
    },
    [patchField],
  );

  const renderDefaultInput = (field: WorkflowFieldDefinition) => {
    const commit = (value: unknown) => patchField(field.id, { default: value });
    if (field.type === "boolean") {
      return (
        <label className="wf-field--checkbox">
          <input
            type="checkbox"
            checked={field.default === true}
            disabled={readOnly}
            onChange={(e) => commit(e.target.checked)}
          />
          <span>{t("workflowFields.defaultTrue", "Default on")}</span>
        </label>
      );
    }
    if (isEnumKind(field.type)) {
      const current = field.type === "multi-enum"
        ? (Array.isArray(field.default) ? (field.default as string[])[0] ?? "" : "")
        : (typeof field.default === "string" ? field.default : "");
      return (
        <select
          aria-label={t("workflowFields.defaultLabel", "Default value")}
          value={current}
          disabled={readOnly}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "") return commit(undefined);
            commit(field.type === "multi-enum" ? [v] : v);
          }}
        >
          <option value="">{t("workflowFields.noDefault", "— none —")}</option>
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      );
    }
    const typeAttr = field.type === "number" ? "number" : field.type === "date" ? "date" : field.type === "url" ? "url" : "text";
    const currentText = field.type === "number"
      ? (typeof field.default === "number" ? String(field.default) : "")
      : (typeof field.default === "string" ? field.default : "");
    return (
      <input
        type={typeAttr}
        aria-label={t("workflowFields.defaultLabel", "Default value")}
        defaultValue={currentText}
        disabled={readOnly}
        onBlur={(e) => {
          const raw = e.target.value;
          if (raw === "") return commit(undefined);
          commit(field.type === "number" ? Number(raw) : raw);
        }}
      />
    );
  };

  return (
    <aside className="wf-fields-panel" data-testid="wf-fields-panel">
      <header className="wf-fields-panel-header">
        <h3>{t("workflowFields.title", "Fields")}</h3>
        <button
          className="wf-fields-add"
          onClick={addField}
          disabled={readOnly}
          title={readOnly ? t("workflowFields.readOnlyHint", "Built-in workflows are read-only — duplicate to edit") : undefined}
        >
          <Plus size={13} /> {t("workflowFields.add", "Add field")}
        </button>
      </header>

      {fields.length === 0 ? (
        <p className="wf-fields-panel-empty">
          {t("workflowFields.empty", "No custom fields yet. Add a field to extend the task form and cards.")}
        </p>
      ) : (
        <ul className="wf-fields-list">
          {fields.map((field) => {
            const widgets = WIDGETS_BY_TYPE[field.type];
            const placement = field.render?.placement ?? "detail";
            const idEditing = editingId === field.id;
            return (
              <li key={field.id} className="wf-field-item" data-testid={`wf-field-${field.id}`}>
                <div className="wf-field-item-head">
                  <input
                    className="wf-field-name"
                    aria-label={t("workflowFields.nameLabel", "Field name")}
                    value={field.name}
                    disabled={readOnly}
                    onChange={(e) => patchField(field.id, { name: e.target.value })}
                  />
                  <button
                    className="wf-field-remove"
                    aria-label={t("workflowFields.remove", "Remove field")}
                    disabled={readOnly}
                    onClick={() => removeField(field.id)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>

                {/* Immutable id with explicit "edit id" affordance (remove+add). */}
                <div className="wf-field-id-row">
                  {idEditing ? (
                    <>
                      <input
                        className="wf-field-id"
                        aria-label={t("workflowFields.idLabel", "Field id")}
                        defaultValue={field.id}
                        disabled={readOnly}
                        onBlur={(e) => {
                          changeId(field.id, e.target.value);
                          setEditingId(null);
                        }}
                      />
                      <p className="wf-field-id-warn" role="note">
                        <AlertTriangle size={11} aria-hidden />{" "}
                        {t("workflowFields.idWarn", "Changing the id discards values stored under the old id (remove + add).")}
                      </p>
                    </>
                  ) : (
                    <>
                      <code className="wf-field-id-static">{field.id}</code>
                      <button
                        className="wf-field-id-edit"
                        disabled={readOnly}
                        onClick={() => setEditingId(field.id)}
                      >
                        {t("workflowFields.editId", "Edit id")}
                      </button>
                    </>
                  )}
                </div>

                <div className="wf-field-row">
                  <label className="wf-field-sub">
                    <span>{t("workflowFields.typeLabel", "Type")}</span>
                    <select
                      value={field.type}
                      disabled={readOnly}
                      onChange={(e) => changeType(field.id, e.target.value as WorkflowFieldType)}
                    >
                      {FIELD_TYPES.map((ty) => (
                        <option key={ty} value={ty}>{ty}</option>
                      ))}
                    </select>
                  </label>
                  <label className="wf-field--checkbox wf-field-required">
                    <input
                      type="checkbox"
                      checked={field.required === true}
                      disabled={readOnly}
                      onChange={(e) => patchField(field.id, { required: e.target.checked || undefined })}
                    />
                    <span>{t("workflowFields.required", "Required")}</span>
                  </label>
                </div>

                <label className="wf-field-sub">
                  <span>{t("workflowFields.default", "Default")}</span>
                  {renderDefaultInput(field)}
                </label>

                {isEnumKind(field.type) && (
                  <div className="wf-field-options" data-testid={`wf-field-options-${field.id}`}>
                    <span className="wf-field-options-label">{t("workflowFields.options", "Options")}</span>
                    {(field.options ?? []).map((opt, i) => (
                      <div key={i} className="wf-field-option-row">
                        <input
                          className="wf-field-option-value"
                          aria-label={t("workflowFields.optionValue", "Option value")}
                          value={opt.value}
                          disabled={readOnly}
                          onChange={(e) => {
                            const next = [...(field.options ?? [])];
                            next[i] = { ...opt, value: e.target.value };
                            setOptions(field.id, next);
                          }}
                        />
                        <input
                          className="wf-field-option-label"
                          aria-label={t("workflowFields.optionLabel", "Option label")}
                          value={opt.label}
                          disabled={readOnly}
                          onChange={(e) => {
                            const next = [...(field.options ?? [])];
                            next[i] = { ...opt, label: e.target.value };
                            setOptions(field.id, next);
                          }}
                        />
                        <div className="wf-field-option-colors" role="group" aria-label={t("workflowFields.optionColor", "Option color")}>
                          {PRESET_COLORS.map((c) => (
                            <button
                              key={c}
                              type="button"
                              className={`wf-field-color-swatch${opt.color === c ? " is-active" : ""}`}
                              style={{ backgroundColor: c }}
                              aria-label={c}
                              aria-pressed={opt.color === c}
                              disabled={readOnly}
                              onClick={() => {
                                const next = [...(field.options ?? [])];
                                next[i] = { ...opt, color: opt.color === c ? undefined : c };
                                setOptions(field.id, next);
                              }}
                            />
                          ))}
                        </div>
                        <button
                          className="wf-field-option-remove"
                          aria-label={t("workflowFields.removeOption", "Remove option")}
                          disabled={readOnly}
                          onClick={() => setOptions(field.id, (field.options ?? []).filter((_, j) => j !== i))}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))}
                    <button
                      className="wf-field-option-add"
                      disabled={readOnly}
                      onClick={() => {
                        const n = (field.options ?? []).length + 1;
                        setOptions(field.id, [
                          ...(field.options ?? []),
                          { value: `option-${n}`, label: t("workflowFields.optionN", "Option {{n}}", { n }) },
                        ]);
                      }}
                    >
                      <Plus size={12} /> {t("workflowFields.addOption", "Add option")}
                    </button>
                  </div>
                )}

                <div className="wf-field-render">
                  <label className="wf-field-sub">
                    <span>{t("workflowFields.placement", "Placement")}</span>
                    <select
                      value={placement}
                      disabled={readOnly}
                      onChange={(e) => setRender(field.id, { ...field.render, placement: e.target.value as "card" | "detail" | "detail-section" })}
                    >
                      <option value="detail">{t("workflowFields.placementDetail", "Detail (inline)")}</option>
                      <option value="detail-section">{t("workflowFields.placementSection", "Detail section")}</option>
                      <option value="card">{t("workflowFields.placementCard", "Card badge")}</option>
                    </select>
                  </label>
                  <label className="wf-field-sub">
                    <span>{t("workflowFields.widget", "Widget")}</span>
                    <select
                      value={field.render?.widget ?? ""}
                      disabled={readOnly}
                      onChange={(e) => setRender(field.id, { ...field.render, widget: (e.target.value || undefined) as NonNullable<WorkflowFieldDefinition["render"]>["widget"] })}
                    >
                      <option value="">{t("workflowFields.widgetDefault", "Default")}</option>
                      {widgets.map((w) => (
                        <option key={w} value={w}>{w}</option>
                      ))}
                    </select>
                  </label>
                  <label className="wf-field--checkbox">
                    <input
                      type="checkbox"
                      checked={field.render?.badge === true}
                      disabled={readOnly}
                      onChange={(e) => setRender(field.id, { ...field.render, badge: e.target.checked || undefined })}
                    />
                    <span>{t("workflowFields.badge", "Render as badge")}</span>
                  </label>
                </div>

                {placement === "card" && <FieldBadgePreview field={field} />}
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

export default WorkflowFieldsPanel;
