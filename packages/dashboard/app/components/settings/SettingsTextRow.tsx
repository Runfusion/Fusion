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
  const { key, label, help, scope, disabled, placeholder } = descriptor;
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
        className="settings-text"
        type="text"
        value={value ?? ""}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </SettingsFieldRow>
  );
}

export default SettingsTextRow;
