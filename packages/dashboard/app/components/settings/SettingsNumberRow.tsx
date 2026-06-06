/**
 * SettingsNumberRow — numeric control composing SettingsFieldRow (U8 / KTD-10).
 * Emits numbers (never strings) through onChange. An empty input emits null —
 * the modal's null-as-delete signal — which is also what the clear affordance
 * emits when `clearable` is set.
 */
import { SettingsFieldRow } from "./SettingsFieldRow";
import type { SettingsNumberDescriptor } from "./types";
import "./SettingsNumberRow.css";

export interface SettingsNumberRowProps {
  descriptor: SettingsNumberDescriptor;
  value: number | null;
  onChange: (value: number | null) => void;
  error?: string;
  /** Renders a reset-to-default affordance that emits onChange(null). */
  clearable?: boolean;
}

export function SettingsNumberRow({
  descriptor,
  value,
  onChange,
  error,
  clearable,
}: SettingsNumberRowProps) {
  const { key, label, help, scope, disabled, min, max, step, placeholder } = descriptor;
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
        className="settings-number"
        type="number"
        value={value === null || value === undefined ? "" : value}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => {
          const raw = e.target.value;
          // Empty → null (delete). Otherwise coerce to a real number, never a
          // string; ignore unparseable intermediate input.
          if (raw === "") return onChange(null);
          const n = Number(raw);
          if (Number.isNaN(n)) return;
          onChange(n);
        }}
      />
    </SettingsFieldRow>
  );
}

export default SettingsNumberRow;
