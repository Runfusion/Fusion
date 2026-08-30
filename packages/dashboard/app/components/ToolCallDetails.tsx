import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import "./ToolCallDetails.css";

/*
FNXC:ToolCallDisplay 2026-08-29-04:34:
FN-253 makes complete arguments and results visible across both task-log surfaces. Dense Activity
hosts opt into a visible CSS preview plus an explicit reveal; the control never appears without
additional content, and StandardChatSurface retains its existing unbounded display.
*/
export const TOOL_CALL_PREVIEW_MAX_LINES = 6;
export const TOOL_CALL_PREVIEW_MAX_CHARS = 600;

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
  /** Opt in only on dense transcript surfaces; standard detail views keep full values visible. */
  clampLongValues?: boolean;
  renderValue?: (value: string) => ReactNode;
  className?: string;
}

function needsToolValuePreview(text: string): boolean {
  return text.length > TOOL_CALL_PREVIEW_MAX_CHARS || text.split(/\r?\n/).length > TOOL_CALL_PREVIEW_MAX_LINES;
}

interface ToolCallDetailsRowProps {
  label: string;
  text: string;
  isError?: boolean;
  clampLongValues: boolean;
  renderValue: (value: string) => ReactNode;
}

function ToolCallDetailsRow({
  label,
  text,
  isError = false,
  clampLongValues,
  renderValue,
}: ToolCallDetailsRowProps) {
  const { t } = useTranslation("app");
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const lineCount = text.split(/\r?\n/).length;
  const canClamp = clampLongValues && needsToolValuePreview(text);
  const revealLabel = t(
    "toolCallDetails.showMore",
    "Show more ({{count}} {{lineLabel}})",
    {
      count: lineCount,
      lineLabel: lineCount === 1
        ? t("toolCallDetails.line", "line")
        : t("toolCallDetails.lines", "lines"),
    },
  );

  return (
    <div className={`tool-call-details-row${isError ? " tool-call-details-row--error" : ""}`}>
      {label ? <span className="tool-call-details-label">{label}</span> : null}
      <div className="tool-call-details-content">
        <pre id={contentId} className={`tool-call-details-value${canClamp && !expanded ? " tool-call-details-value--clamped" : ""}`}>
          {renderValue(text)}
        </pre>
        {canClamp ? (
          <button
            type="button"
            className="tool-call-details-reveal"
            aria-expanded={expanded}
            aria-controls={contentId}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? t("toolCallDetails.showLess", "Show less") : revealLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Renders only meaningful rows so callers never leave an empty detail shell behind. */
export function ToolCallDetails({
  argumentsValue,
  resultValue,
  argumentsLabel,
  resultLabel,
  resultIsError = false,
  clampLongValues = false,
  renderValue = (value) => value,
  className = "",
}: ToolCallDetailsProps): ReactNode {
  const argumentsText = formatToolValue(argumentsValue, true);
  const resultText = formatToolValue(resultValue, true);
  if (!argumentsText && !resultText) return null;

  return (
    <div className={`tool-call-details ${className}`.trim()}>
      {argumentsText ? <ToolCallDetailsRow label={argumentsLabel} text={argumentsText} clampLongValues={clampLongValues} renderValue={renderValue} /> : null}
      {resultText ? <ToolCallDetailsRow label={resultLabel} text={resultText} isError={resultIsError} clampLongValues={clampLongValues} renderValue={renderValue} /> : null}
    </div>
  );
}
