import type { ReactNode } from "react";
import "./ToolCallDetails.css";

/**
 * FNXC:ToolCallDisplay 2026-08-01-15:39:
 * FN-8701 separates scan-friendly tool-call previews from expanded payloads. An expanded
 * disclosure must render every value already delivered to the browser; persistence and tool
 * output budgets remain upstream policies and this formatter never attempts to recover them.
 */
export function formatToolValue(value: unknown, pretty = false): string | null {
  if (value === undefined || value === "") return null;
  if (typeof value === "string") return value;
  try {
    const seen = new WeakSet<object>();
    const serialized = JSON.stringify(value, (_key, nestedValue) => {
      if (typeof nestedValue === "bigint") return nestedValue.toString();
      if (nestedValue && typeof nestedValue === "object") {
        if (seen.has(nestedValue)) return "[Circular]";
        seen.add(nestedValue);
      }
      return nestedValue;
    }, pretty ? 2 : undefined);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

export function formatToolPreview(value: unknown, maxLength: number): string | null {
  const formatted = formatToolValue(value);
  if (!formatted) return null;
  return formatted.length <= maxLength ? formatted : `${formatted.slice(0, maxLength)}…`;
}

/** Whether a disclosure has a meaningful complete payload to reveal. */
export function hasToolCallDetails(argumentsValue: unknown, resultValue: unknown): boolean {
  return Boolean(formatToolValue(argumentsValue) || formatToolValue(resultValue));
}

export function formatToolArgsPreview(args?: Record<string, unknown>): string | null {
  if (!args || Object.keys(args).length === 0) return null;
  return Object.entries(args)
    .map(([key, value]) => `${key}=${formatToolPreview(value, 50) ?? ""}`)
    .join(", ");
}

interface ToolCallDetailsProps {
  argumentsValue?: unknown;
  resultValue?: unknown;
  argumentsLabel: string;
  resultLabel: string;
  resultIsError?: boolean;
  renderValue?: (value: string) => ReactNode;
  className?: string;
}

/** Renders only meaningful rows so callers never leave an empty detail shell behind. */
export function ToolCallDetails({
  argumentsValue,
  resultValue,
  argumentsLabel,
  resultLabel,
  resultIsError = false,
  renderValue = (value) => value,
  className = "",
}: ToolCallDetailsProps): ReactNode {
  const argumentsText = formatToolValue(argumentsValue, true);
  const resultText = formatToolValue(resultValue, true);
  if (!argumentsText && !resultText) return null;

  return (
    <div className={`tool-call-details ${className}`.trim()}>
      {argumentsText ? <div className="tool-call-details-row">{argumentsLabel ? <span className="tool-call-details-label">{argumentsLabel}</span> : null}<pre className="tool-call-details-value">{renderValue(argumentsText)}</pre></div> : null}
      {resultText ? <div className={`tool-call-details-row${resultIsError ? " tool-call-details-row--error" : ""}`}>{resultLabel ? <span className="tool-call-details-label">{resultLabel}</span> : null}<pre className="tool-call-details-value">{renderValue(resultText)}</pre></div> : null}
    </div>
  );
}
