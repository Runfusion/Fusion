/**
 * SettingsFieldRow — the base layout primitive every typed settings row composes
 * (U8 / KTD-10). It owns nothing about the control itself: callers pass the
 * control as `children` and this row handles the surrounding chrome — label,
 * scope badge (global/project), help text, error band, and an optional
 * "reset to default" clear affordance.
 *
 * Strings are pre-translated by callers (the descriptor carries label/help), so
 * this primitive hardcodes no user-facing copy. The only intrinsic string is the
 * clear button's aria-label, sourced via useTranslation like neighboring
 * components (e.g. WorkflowFieldsPanel).
 */
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw } from "lucide-react";
import "./SettingsFieldRow.css";

/** Which authority level a setting is being edited at. `undefined` renders no
 *  badge (the common case for a plain app/global setting). */
export type SettingsScope = "global" | "project";

export interface SettingsFieldRowProps {
  /** Stable id, used to associate the label with the control. */
  htmlFor?: string;
  /** Pre-translated label text. */
  label: string;
  /** Pre-translated help/description text rendered under the control. */
  help?: string;
  /** Pre-translated validation message; renders the error band when set. */
  error?: string;
  /** Scope badge to display next to the label. */
  scope?: SettingsScope;
  /** Disables the clear affordance and dims the row. */
  disabled?: boolean;
  /** When set, renders a clear/reset-to-default button that calls onClear. */
  clearable?: boolean;
  /** Invoked when the user presses the clear affordance. */
  onClear?: () => void;
  /** The control element (input/select/textarea/toggle). */
  children: ReactNode;
}

export function SettingsFieldRow({
  htmlFor,
  label,
  help,
  error,
  scope,
  disabled,
  clearable,
  onClear,
  children,
}: SettingsFieldRowProps) {
  const { t } = useTranslation("app");
  return (
    <div className={`settings-field-row${disabled ? " is-disabled" : ""}`}>
      <div className="settings-field-row-head">
        <label className="settings-field-row-label" htmlFor={htmlFor}>
          {label}
        </label>
        {scope && (
          <span
            className={`settings-field-row-scope settings-field-row-scope--${scope}`}
            data-testid="settings-field-row-scope"
          >
            {scope}
          </span>
        )}
      </div>
      <div className="settings-field-row-control">
        {children}
        {clearable && (
          <button
            type="button"
            className="settings-field-row-clear"
            aria-label={t("settings.clearToDefault", "Reset to default")}
            title={t("settings.clearToDefault", "Reset to default")}
            disabled={disabled}
            onClick={onClear}
          >
            <RotateCcw size={13} aria-hidden />
          </button>
        )}
      </div>
      {help && <p className="settings-field-row-help">{help}</p>}
      {error && (
        <p className="settings-field-row-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export default SettingsFieldRow;
