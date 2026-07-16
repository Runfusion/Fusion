/**
 * SettingsTextRow — single-line text control composing SettingsFieldRow
 * (U8 / KTD-10). Emits the string value, or null when cleared (the modal's
 * null-as-delete signal) if `clearable` is set.
 */
import { SettingsFieldRow } from "./SettingsFieldRow";
import type { SettingsTextDescriptor } from "./types";
import "./SettingsTextRow.css";

export interface SettingsTextRowProps {
  descriptor: SettingsTextDescriptor;
  value: string | null;
  onChange: (value: string | null) => void;
  error?: string;
  /** Renders a reset-to-default affordance that emits onChange(null). */
  clearable?: boolean;
}

export function SettingsTextRow({
  descriptor,
  value,
  onChange,
  error,
  clearable,
}: SettingsTextRowProps) {
  const { key, label, help, scope, disabled, placeholder, type, autoComplete } = descriptor;
  /*
  FNXC:SettingsSecurity 2026-07-15-18:52:
  A `password` row defaults to `autocomplete="off"` so the browser never offers to save or autofill a stored API token. The descriptor can override it, but the default is the safe one — a caller adding a token row cannot leak it by omission.
  */
  const resolvedAutoComplete = autoComplete ?? (type === "password" ? "off" : undefined);
  return (
    <SettingsFieldRow
      htmlFor={key}
      label={label}
      help={help}
      error={error}
      scope={scope}
      disabled={disabled}
      clearable={clearable}
      onClear={() => onChange(null)}
    >
      <input
        id={key}
        className="input settings-text"
        type={type ?? "text"}
        autoComplete={resolvedAutoComplete}
        value={value ?? ""}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </SettingsFieldRow>
  );
}

export default SettingsTextRow;
