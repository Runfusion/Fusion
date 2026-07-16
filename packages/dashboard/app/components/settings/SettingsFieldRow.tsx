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
import { useIsSettingHighlighted } from "./SettingsSearchHighlightContext";
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
  /**
   * Places the control on the label's line instead of below it.
   *
   * FNXC:SettingsStyling 2026-07-15-17:35:
   * Booleans read as "[x] Setting name", not as a name with a stray checkbox parked underneath it. The default stacked order (label → control → help) is correct for inputs that need their full width, but applying it to a checkbox strands a 13px box on its own line and breaks the scan down the column of labels.
   * This restores the reading order of the `checkbox-label` markup the migration replaced; only the styling is unified, not the layout semantics.
   */
  inlineControl?: boolean;
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
  inlineControl,
  children,
}: SettingsFieldRowProps) {
  const { t } = useTranslation("app");
  /*
  FNXC:SettingsSearch 2026-07-15-17:35:
  `data-settings-key` is the anchor a search result scrolls to. It lives on the row rather than the control because the row is what the operator needs to read — its label, help text, and scope badge — and scrolling to the bare input would put the label above the fold.
  It is a data attribute rather than a DOM id: `htmlFor`/`id` already carry the key to bind label→control, and a second element claiming the same id would be invalid and would break that binding.
  */
  const isSearchMatch = useIsSettingHighlighted(htmlFor);

  const control = (
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
  );

  const labelAndScope = (
    <>
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
    </>
  );

  return (
    <div
      className={`settings-field-row${inlineControl ? " settings-field-row--inline" : ""}${disabled ? " is-disabled" : ""}${isSearchMatch ? " is-search-match" : ""}`}
      data-settings-key={htmlFor}
    >
      {/*
      FNXC:SettingsStyling 2026-07-15-17:35:
      Inline rows put the control FIRST in the DOM, not just visually: a checkbox reads "[x] Hide banners", and reordering with CSS alone would leave the tab and screen-reader order saying "Hide banners [x]", which is the wrong sentence.
      */}
      <div className="settings-field-row-head">
        {inlineControl && control}
        {labelAndScope}
      </div>
      {!inlineControl && control}
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
