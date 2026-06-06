/**
 * SettingsTextareaRow — multi-line text control composing SettingsFieldRow
 * (U8 / KTD-10). Emits the string value, or null when cleared (the modal's
 * null-as-delete signal) if `clearable` is set.
 */
import { SettingsFieldRow } from "./SettingsFieldRow";
import type { SettingsTextDescriptor } from "./types";
import "./SettingsTextareaRow.css";

export interface SettingsTextareaRowProps {
  descriptor: SettingsTextDescriptor;
  value: string | null;
  onChange: (value: string | null) => void;
  error?: string;
  /** Renders a reset-to-default affordance that emits onChange(null). */
  clearable?: boolean;
}

export function SettingsTextareaRow({
  descriptor,
  value,
  onChange,
  error,
  clearable,
}: SettingsTextareaRowProps) {
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
      <textarea
        id={key}
        className="settings-textarea"
        value={value ?? ""}
        placeholder={placeholder}
        disabled={disabled}
        rows={3}
        onChange={(e) => onChange(e.target.value)}
      />
    </SettingsFieldRow>
  );
}

export default SettingsTextareaRow;
