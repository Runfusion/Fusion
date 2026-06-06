/**
 * SettingsToggleRow — boolean control composing SettingsFieldRow (U8 / KTD-10).
 * Emits booleans through onChange, or null when cleared (the modal's
 * null-as-delete signal) if `clearable` is set.
 */
import { SettingsFieldRow } from "./SettingsFieldRow";
import type { SettingsDescriptorBase } from "./types";
import "./SettingsToggleRow.css";

export interface SettingsToggleRowProps {
  descriptor: SettingsDescriptorBase;
  value: boolean;
  onChange: (value: boolean | null) => void;
  error?: string;
  /** Renders a reset-to-default affordance that emits onChange(null). */
  clearable?: boolean;
}

export function SettingsToggleRow({
  descriptor,
  value,
  onChange,
  error,
  clearable,
}: SettingsToggleRowProps) {
  const { key, label, help, scope, disabled } = descriptor;
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
      <label className="settings-toggle">
        <input
          id={key}
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
      </label>
    </SettingsFieldRow>
  );
}

export default SettingsToggleRow;
