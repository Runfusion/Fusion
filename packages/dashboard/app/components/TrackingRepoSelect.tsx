import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "./TrackingRepoSelect.css";

const CUSTOM_VALUE = "__custom__";

export interface TrackingRepoOption {
  value: string;
  label: string;
  source?: string;
}

interface TrackingRepoSelectProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: TrackingRepoOption[];
  loading?: boolean;
  error?: string;
  placeholder?: string;
  ariaLabel?: string;
}

function normalizeOptions(options: TrackingRepoOption[]): TrackingRepoOption[] {
  const byValue = new Map<string, TrackingRepoOption>();
  for (const option of options) {
    const normalized = option.value.trim();
    if (!normalized || byValue.has(normalized)) {
      continue;
    }
    byValue.set(normalized, {
      ...option,
      value: normalized,
      label: option.label?.trim() || normalized,
    });
  }
  return [...byValue.values()].sort((a, b) => a.value.localeCompare(b.value));
}

export function TrackingRepoSelect({
  id,
  value,
  onChange,
  options,
  loading = false,
  error,
  placeholder = "owner/repo",
  ariaLabel,
}: TrackingRepoSelectProps) {
  const { t } = useTranslation("app");
  const customInputRef = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const [showCustomInput, setShowCustomInput] = useState(false);

  const normalizedOptions = useMemo(() => normalizeOptions(options), [options]);
  const selectedOption = normalizedOptions.find((option) => option.value === value);
  const selectValue = selectedOption ? selectedOption.value : CUSTOM_VALUE;

  useEffect(() => {
    setShowCustomInput(selectValue === CUSTOM_VALUE);
  }, [selectValue]);

  const handleSelectChange = (nextValue: string) => {
    if (nextValue === CUSTOM_VALUE) {
      setShowCustomInput(true);
      requestAnimationFrame(() => {
        customInputRef.current?.focus();
      });
      return;
    }

    setShowCustomInput(false);
    onChange(nextValue);
  };

  const renderedHint = error ? error : loading ? t("trackingRepoSelect.loadingHint", "Loading detected GitHub remotes…") : null;

  return (
    <div className="tracking-repo-select">
      <select
        id={id}
        className="select"
        value={selectValue}
        onChange={(event) => handleSelectChange(event.target.value)}
        aria-label={ariaLabel}
        aria-describedby={renderedHint ? hintId : undefined}
      >
        {normalizedOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.source ? `${option.label} — ${option.source}` : option.label}
          </option>
        ))}
        <option value={CUSTOM_VALUE}>{t("trackingRepoSelect.customOption", "Custom…")}</option>
      </select>
      {showCustomInput ? (
        <input
          ref={customInputRef}
          className="input tracking-repo-select__custom-input"
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          aria-describedby={renderedHint ? hintId : undefined}
        />
      ) : null}
      {renderedHint ? (
        <small
          id={hintId}
          className={error ? "tracking-repo-select__hint tracking-repo-select__hint--error" : "tracking-repo-select__hint"}
        >
          {renderedHint}
        </small>
      ) : null}
    </div>
  );
}
