/**
 * Schema-driven custom-field form section (U13 / KTD-14).
 *
 * Renders a task's workflow-defined custom fields ({@link WorkflowFieldDefinition})
 * as editable widgets, grouped by `render.placement`:
 *   - `detail` (and the default when unset) → inline, near the description.
 *   - `detail-section` → inside a collapsible group.
 * Card-placed fields (`placement: "card"`) are intentionally NOT rendered here —
 * those surface as badges on {@link TaskCard}.
 *
 * Widget selection (per `type` + optional `render.widget`):
 *   - enum        → select (default) | radio | chips (single-select)
 *   - multi-enum  → chips (multi-select)
 *   - boolean     → toggle
 *   - date        → date input
 *   - url/number  → validated <input>
 *   - string      → text input
 *   - text        → textarea
 *
 * Editing is per-field, save-on-commit (blur for inputs, change for
 * toggles/selects/chips/radio). Each save calls `onSave({ [fieldId]: value })`;
 * on a 400 the caller surfaces the typed rejection through `error`, which this
 * component renders inline beneath the offending field.
 *
 * Orphaned values — keys in `customFields` with no matching definition — render
 * read-only under a collapsed "Orphaned fields" disclosure (never destroyed,
 * KTD-13).
 *
 * Zero field definitions AND zero orphaned values → the component renders
 * nothing (null), so a task on a field-less workflow is byte-identical to
 * today's UI (snapshot-guarded by the test suite).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, ChevronDown } from "lucide-react";
import type {
  WorkflowFieldDefinition,
  WorkflowFieldOption,
  CustomFieldRejection,
} from "../api";
import "./TaskFieldsSection.css";

export interface TaskFieldsSectionProps {
  /** The task's workflow field definitions (from board-workflows payload). */
  fieldDefs: WorkflowFieldDefinition[];
  /** Current custom field values, keyed by field id. */
  customFields: Record<string, unknown>;
  /**
   * Persist a single-field patch. Resolves on success; the caller is expected
   * to throw / reject with the server's typed rejection so it can flow into
   * `error`. May be omitted to render read-only (e.g. archived tasks).
   */
  onSave?: (patch: Record<string, unknown>) => Promise<void>;
  /**
   * The most recent typed rejection from a failed save (400), surfaced inline
   * beneath the matching field. Cleared by the caller on a successful save.
   */
  error?: CustomFieldRejection | null;
  /** When true, fields render read-only (no edit affordances). */
  readOnly?: boolean;
}

/** Resolve the effective widget for a field, applying the per-type default. */
function resolveWidget(field: WorkflowFieldDefinition): NonNullable<WorkflowFieldDefinition["render"]>["widget"] {
  const explicit = field.render?.widget;
  if (explicit) return explicit;
  switch (field.type) {
    case "enum":
      return "select";
    case "multi-enum":
      return "chips";
    case "boolean":
      return "toggle";
    case "text":
      return "textarea";
    default:
      return "input";
  }
}

interface FieldRowProps {
  field: WorkflowFieldDefinition;
  value: unknown;
  onSave?: (patch: Record<string, unknown>) => Promise<void>;
  error?: CustomFieldRejection | null;
  readOnly: boolean;
}

function FieldRow({ field, value, onSave, error, readOnly }: FieldRowProps) {
  const { t } = useTranslation("app");
  const widget = resolveWidget(field);
  const fieldError = error && error.fieldId === field.id ? error : null;
  const disabled = readOnly || !onSave;

  // Serialize per-field saves: rapid chip/toggle/blur edits to the same field
  // would otherwise fire overlapping PATCHes whose responses can resolve out of
  // order, letting an older request clobber a newer selection. We chain each
  // save onto the previous one for this field so they apply in click order.
  const saveTailRef = useRef<Promise<void>>(Promise.resolve());
  const commit = useCallback(
    (next: unknown) => {
      if (!onSave) return;
      const run = () => onSave({ [field.id]: next });
      // Run after any in-flight save for this field, regardless of its outcome,
      // so a rejected save doesn't permanently break the chain. The tail is kept
      // settled-always (.catch) so its own rejection never floats unhandled and
      // never blocks the next queued save — the caller surfaces failures via
      // `error`, so we intentionally swallow here for ordering purposes only.
      const prev = saveTailRef.current;
      saveTailRef.current = prev.then(run, run).catch(() => {});
    },
    [onSave, field.id],
  );

  const labelId = `task-field-label-${field.id}`;
  const controlId = `task-field-${field.id}`;

  // Prop-derived string value for the uncontrolled-style inputs (date / text /
  // string / number / url). These were previously rendered with `defaultValue`,
  // which only seeds on mount — so an external refresh of `customFields` (SSE or
  // a save round-trip) left the DOM showing a stale value, and a later blur would
  // commit that stale value back over the refreshed one. We make them controlled
  // and re-sync to the latest prop whenever it changes.
  const propTextValue =
    field.type === "date"
      ? typeof value === "string"
        ? value.slice(0, 10)
        : ""
      : field.type === "number"
        ? typeof value === "number"
          ? String(value)
          : ""
        : typeof value === "string"
          ? value
          : "";
  const [localValue, setLocalValue] = useState(propTextValue);
  useEffect(() => {
    setLocalValue(propTextValue);
  }, [propTextValue]);

  const renderControl = () => {
    // enum → select / radio / chips (single)
    if (field.type === "enum") {
      const current = typeof value === "string" ? value : "";
      if (widget === "radio") {
        return (
          <div className="task-field-radio-group" role="radiogroup" aria-labelledby={labelId}>
            {(field.options ?? []).map((opt: WorkflowFieldOption) => (
              <label key={opt.value} className="task-field-radio">
                <input
                  type="radio"
                  name={controlId}
                  value={opt.value}
                  checked={current === opt.value}
                  disabled={disabled}
                  onChange={() => commit(opt.value)}
                />
                <span>{opt.label}</span>
              </label>
            ))}
          </div>
        );
      }
      if (widget === "chips") {
        return (
          <div className="task-field-chips" role="group" aria-labelledby={labelId}>
            {(field.options ?? []).map((opt) => {
              const active = current === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  className={`task-field-chip${active ? " is-active" : ""}`}
                  disabled={disabled}
                  aria-pressed={active}
                  style={active && opt.color ? { backgroundColor: opt.color, borderColor: opt.color } : undefined}
                  onClick={() => commit(active ? null : opt.value)}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        );
      }
      // default: select
      return (
        <select
          id={controlId}
          className="task-field-select"
          value={current}
          disabled={disabled}
          aria-labelledby={labelId}
          onChange={(e) => commit(e.target.value === "" ? null : e.target.value)}
        >
          <option value="">{t("taskFields.unset", "—")}</option>
          {(field.options ?? []).map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      );
    }

    // multi-enum → chips (multi-select)
    if (field.type === "multi-enum") {
      const current = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="task-field-chips" role="group" aria-labelledby={labelId}>
          {(field.options ?? []).map((opt) => {
            const active = current.includes(opt.value);
            return (
              <button
                key={opt.value}
                type="button"
                className={`task-field-chip${active ? " is-active" : ""}`}
                disabled={disabled}
                aria-pressed={active}
                style={active && opt.color ? { backgroundColor: opt.color, borderColor: opt.color } : undefined}
                onClick={() => {
                  const next = active
                    ? current.filter((v) => v !== opt.value)
                    : [...current, opt.value];
                  commit(next);
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      );
    }

    // boolean → toggle
    if (field.type === "boolean") {
      const checked = value === true;
      return (
        <label className="task-field-toggle">
          <input
            type="checkbox"
            id={controlId}
            checked={checked}
            disabled={disabled}
            aria-labelledby={labelId}
            onChange={(e) => commit(e.target.checked)}
          />
          <span className="task-field-toggle-track" aria-hidden="true" />
        </label>
      );
    }

    // date → date input
    if (field.type === "date") {
      return (
        <input
          id={controlId}
          type="date"
          className="task-field-input"
          value={localValue}
          disabled={disabled}
          aria-labelledby={labelId}
          onChange={(e) => setLocalValue(e.target.value)}
          onBlur={(e) => {
            const next = e.target.value;
            if (next === propTextValue) return;
            commit(next === "" ? null : next);
          }}
        />
      );
    }

    // text → textarea
    if (field.type === "text") {
      return (
        <textarea
          id={controlId}
          className="task-field-textarea"
          value={localValue}
          disabled={disabled}
          aria-labelledby={labelId}
          rows={3}
          onChange={(e) => setLocalValue(e.target.value)}
          onBlur={(e) => {
            if (e.target.value === propTextValue) return;
            commit(e.target.value === "" ? null : e.target.value);
          }}
        />
      );
    }

    // number / url / string → validated input
    return (
      <input
        id={controlId}
        type={field.type === "number" ? "number" : field.type === "url" ? "url" : "text"}
        className="task-field-input"
        value={localValue}
        disabled={disabled}
        aria-labelledby={labelId}
        onChange={(e) => setLocalValue(e.target.value)}
        onBlur={(e) => {
          const raw = e.target.value;
          if (raw === propTextValue) return;
          if (raw === "") {
            commit(null);
            return;
          }
          if (field.type === "number") {
            const num = Number(raw);
            commit(Number.isFinite(num) ? num : raw);
            return;
          }
          commit(raw);
        }}
      />
    );
  };

  return (
    <div
      className={`task-field-row${fieldError ? " has-error" : ""}`}
      data-testid={`task-field-row-${field.id}`}
      data-field-type={field.type}
    >
      <div className="task-field-label" id={labelId}>
        {field.name}
        {field.required ? <span className="task-field-required" aria-hidden="true"> *</span> : null}
      </div>
      <div className="task-field-control">{renderControl()}</div>
      {fieldError ? (
        <div className="task-field-error" role="alert" data-testid={`task-field-error-${field.id}`}>
          {fieldError.detail}
        </div>
      ) : null}
    </div>
  );
}

export function TaskFieldsSection({
  fieldDefs,
  customFields,
  onSave,
  error,
  readOnly = false,
}: TaskFieldsSectionProps) {
  const { t } = useTranslation("app");
  const [sectionOpen, setSectionOpen] = useState(true);
  const [orphanedOpen, setOrphanedOpen] = useState(false);

  const inlineFields = useMemo(
    () => fieldDefs.filter((f) => (f.render?.placement ?? "detail") === "detail"),
    [fieldDefs],
  );
  const sectionFields = useMemo(
    () => fieldDefs.filter((f) => f.render?.placement === "detail-section"),
    [fieldDefs],
  );

  // Orphaned: stored keys with no matching definition (KTD-13). Card-placed
  // defs are excluded from the detail form, but their VALUES are not orphaned —
  // only keys with no def at all qualify.
  const orphaned = useMemo(() => {
    const defIds = new Set(fieldDefs.map((f) => f.id));
    return Object.entries(customFields ?? {}).filter(([id]) => !defIds.has(id));
  }, [fieldDefs, customFields]);

  // Byte-identical-to-today guard: nothing to render at all.
  if (inlineFields.length === 0 && sectionFields.length === 0 && orphaned.length === 0) {
    return null;
  }

  const renderRow = (field: WorkflowFieldDefinition) => (
    <FieldRow
      key={field.id}
      field={field}
      value={(customFields ?? {})[field.id]}
      onSave={onSave}
      error={error}
      readOnly={readOnly}
    />
  );

  return (
    <section className="task-fields-section" data-testid="task-fields-section">
      {inlineFields.map(renderRow)}

      {sectionFields.length > 0 ? (
        <div className="task-fields-group">
          <button
            type="button"
            className="task-fields-group-header"
            aria-expanded={sectionOpen}
            data-testid="task-fields-group-toggle"
            onClick={() => setSectionOpen((o) => !o)}
          >
            {sectionOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span>{t("taskFields.moreFields", "Additional fields")}</span>
          </button>
          {sectionOpen ? <div className="task-fields-group-body">{sectionFields.map(renderRow)}</div> : null}
        </div>
      ) : null}

      {orphaned.length > 0 ? (
        <div className="task-fields-orphaned">
          <button
            type="button"
            className="task-fields-orphaned-header"
            aria-expanded={orphanedOpen}
            data-testid="task-fields-orphaned-toggle"
            onClick={() => setOrphanedOpen((o) => !o)}
          >
            {orphanedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span>{t("taskFields.orphaned", "Orphaned fields")}</span>
            <span className="task-fields-orphaned-count">{orphaned.length}</span>
          </button>
          {orphanedOpen ? (
            <div className="task-fields-orphaned-body" data-testid="task-fields-orphaned-body">
              {orphaned.map(([id, value]) => (
                <div key={id} className="task-field-row task-field-orphaned-row" data-testid={`task-field-orphaned-${id}`}>
                  <div className="task-field-label">{id}</div>
                  <div className="task-field-control task-field-orphaned-value">
                    {Array.isArray(value) ? value.join(", ") : String(value)}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export default TaskFieldsSection;
