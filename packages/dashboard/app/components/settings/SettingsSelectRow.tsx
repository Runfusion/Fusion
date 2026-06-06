/**
 * SettingsSelectRow — single-select control composing SettingsFieldRow
 * (U8 / KTD-10). Emits the selected option's string value, or null when cleared
 * (the modal's null-as-delete signal) if `clearable` is set.
 */
import { SettingsFieldRow } from "./SettingsFieldRow";
import type { SettingsSelectDescriptor } from "./types";
import "./SettingsSelectRow.css";

export interface SettingsSelectRowProps {
  descriptor: SettingsSelectDescriptor;
  value: string | null;
  onChange: (value: string | null) => void;
  error?: string;
  /** Renders a reset-to-default affordance that emits onChange(null). */
  clearable?: boolean;
}

export function SettingsSelectRow({
  descriptor,
  value,
  onChange,
  error,
  clearable,
}: SettingsSelectRowProps) {
  const { key, label, help, scope, disabled, options } = descriptor;
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
      <select
        id={key}
        className="settings-select"
        value={value ?? ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </SettingsFieldRow>
  );
}

export default SettingsSelectRow;
