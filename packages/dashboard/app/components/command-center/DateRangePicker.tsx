import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Calendar } from "lucide-react";
import "./DateRangePicker.css";

export interface DateRange {
  /** ISO date string/timestamp or null for an open lower bound. */
  from: string | null;
  /** ISO date string/timestamp or null for an open upper bound (now). */
  to: string | null;
  /** Identifier for the active preset, or "custom". */
  preset: string;
}

export interface DateRangePreset {
  id: string;
  label: string;
  /** Days back from now; null = all time. */
  days: number | null;
}

export interface DateRangePickerProps {
  value: DateRange;
  onChange: (range: DateRange) => void;
  presets?: DateRangePreset[];
}

export function defaultPresets(t: (key: string, fallback: string) => string): DateRangePreset[] {
  return [
    { id: "24h", label: t("commandCenter.range.last24h", "Last 24h"), days: 1 },
    { id: "7d", label: t("commandCenter.range.last7d", "Last 7 days"), days: 7 },
    { id: "30d", label: t("commandCenter.range.last30d", "Last 30 days"), days: 30 },
    { id: "all", label: t("commandCenter.range.allTime", "All time"), days: null },
  ];
}

export function rangeFromPreset(preset: DateRangePreset): DateRange {
  /*
  FNXC:CommandCenter 2026-06-25-00:00:
  FN-7019 requires picker presets to serialize windows the server can distinguish. Bounded presets keep an open upper bound (`to: null`) so the server resolves `[from, now]`; All time must carry the selection timestamp as an explicit upper bound so it resolves `[epoch, selected-now]` instead of collapsing into the no-param default window.
  */
  if (preset.days === null) {
    return { from: null, to: new Date(Date.now()).toISOString(), preset: preset.id };
  }
  const from = new Date(Date.now() - preset.days * 86_400_000);
  return { from: from.toISOString().slice(0, 10), to: null, preset: preset.id };
}

export function DateRangePicker({ value, onChange, presets }: DateRangePickerProps) {
  const { t } = useTranslation("app");
  const resolvedPresets = presets ?? defaultPresets(t);
  const [open, setOpen] = useState(false);
  const [customError, setCustomError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    // Return focus to the trigger on dismiss.
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, close]);

  const activeLabel =
    resolvedPresets.find((p) => p.id === value.preset)?.label ??
    t("commandCenter.range.custom", "Custom range");

  const applyCustom = useCallback(
    (from: string | null, to: string | null) => {
      if (from && to && from > to) {
        setCustomError(t("commandCenter.range.invalidRange", "Start date must be on or before end date"));
        return;
      }
      setCustomError(null);
      onChange({ from, to, preset: "custom" });
    },
    [onChange, t],
  );

  return (
    <div className="cc-date-range">
      <button
        ref={triggerRef}
        type="button"
        className="btn btn-sm cc-date-range-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="cc-date-range-trigger"
      >
        <Calendar size={14} />
        <span>{activeLabel}</span>
      </button>
      {open ? (
        <div
          ref={popoverRef}
          className="cc-date-range-popover"
          role="dialog"
          aria-label={t("commandCenter.range.dialogLabel", "Select date range")}
          data-testid="cc-date-range-popover"
        >
          <div className="cc-date-range-presets">
            {resolvedPresets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={`btn btn-sm${value.preset === preset.id ? " active" : ""}`}
                onClick={() => {
                  onChange(rangeFromPreset(preset));
                  close();
                }}
                data-testid={`cc-date-range-preset-${preset.id}`}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div className="cc-date-range-custom">
            <label className="cc-date-range-field">
              <span>{t("commandCenter.range.from", "From")}</span>
              <input
                type="date"
                value={value.from ?? ""}
                onChange={(e) => applyCustom(e.target.value || null, value.to)}
                data-testid="cc-date-range-from"
              />
            </label>
            <label className="cc-date-range-field">
              <span>{t("commandCenter.range.to", "To")}</span>
              <input
                type="date"
                value={value.to?.slice(0, 10) ?? ""}
                onChange={(e) => applyCustom(value.from, e.target.value || null)}
                data-testid="cc-date-range-to"
              />
            </label>
            {customError ? (
              <div className="form-error" role="alert" data-testid="cc-date-range-error">
                {customError}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
