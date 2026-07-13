import "./ConversationHistory.css";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { PlanningQuestion } from "@fusion/core";
import { useState } from "react";
import type { ConversationHistoryEntry } from "../api";

const COMMENT_ICON = "💬";
const PLANNING_OTHER_RESPONSE_KEY = "_other";
const PLANNING_COMMENT_RESPONSE_KEY = "_comment";
const USER_OWN_ANSWER_SUFFIX = " (user's own answer)";

interface ConversationHistoryProps {
  entries: ConversationHistoryEntry[];
  defaultShowThinking?: boolean;
}

interface NumberedEntry extends ConversationHistoryEntry {
  questionNumber: number | null;
}

interface ResolvedResponseValue {
  value: unknown;
  other: string;
}

function safeFormatScalar(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/*
FNXC:PlanningInterview 2026-07-12-18:36:
Planning interview history must mirror the server `_other` reserved-key contract so user-authored Other answers render as human text instead of falling through to object stringification. `_comment` remains metadata for the separate comment row and is never treated as an answer value.
*/
function getResponseValue(entry: ConversationHistoryEntry): ResolvedResponseValue {
  const { question, response } = entry;
  if (!question) return { value: response, other: "" };

  if (response && typeof response === "object" && !Array.isArray(response)) {
    const record = response as Record<string, unknown>;
    const other = typeof record[PLANNING_OTHER_RESPONSE_KEY] === "string"
      ? record[PLANNING_OTHER_RESPONSE_KEY].trim()
      : "";

    if (question.id in record) {
      return { value: record[question.id], other };
    }

    if (other.length > 0) {
      return { value: question.type === "text" ? other : undefined, other };
    }

    const hasAnswerKeys = Object.keys(record).some(
      (key) => key !== PLANNING_OTHER_RESPONSE_KEY && key !== PLANNING_COMMENT_RESPONSE_KEY,
    );

    return { value: hasAnswerKeys ? response : undefined, other: "" };
  }

  return { value: response, other: "" };
}

function formatOtherAnswer(other: string): string {
  return other.length > 0 ? `${other}${USER_OWN_ANSWER_SUFFIX}` : "";
}

function formatResponse(
  question: PlanningQuestion,
  responseValue: unknown,
  t: TFunction<"app">,
  other = "",
): string {
  switch (question.type) {
    case "text": {
      if (typeof responseValue === "string") return responseValue;
      return safeFormatScalar(responseValue);
    }
    case "single_select": {
      if (other.length > 0) {
        return formatOtherAnswer(other);
      }
      if (typeof responseValue === "string") {
        const selected = question.options?.find((option) => option.id === responseValue);
        return selected?.label ?? responseValue;
      }
      return safeFormatScalar(responseValue);
    }
    case "multi_select": {
      if (Array.isArray(responseValue)) {
        const selected = responseValue.map((value) => {
          if (typeof value !== "string") {
            return safeFormatScalar(value);
          }
          const selectedOption = question.options?.find((option) => option.id === value);
          return selectedOption?.label ?? value;
        });
        if (other.length > 0) {
          selected.push(formatOtherAnswer(other));
        }
        return selected.join(", ");
      }
      if (other.length > 0) {
        return formatOtherAnswer(other);
      }
      return safeFormatScalar(responseValue);
    }
    case "confirm": {
      if (other.length > 0) return formatOtherAnswer(other);
      if (responseValue === true) return t("conversation.confirm.yes", "Yes");
      if (responseValue === false) return t("conversation.confirm.no", "No");
      return safeFormatScalar(responseValue);
    }
    default:
      return safeFormatScalar(responseValue);
  }
}

function normalizeEntries(entries: ConversationHistoryEntry[]): NumberedEntry[] {
  let questionCounter = 0;
  const normalized: NumberedEntry[] = [];

  for (const entry of entries) {
    if (entry.question) {
      questionCounter += 1;
      normalized.push({ ...entry, questionNumber: questionCounter });
      continue;
    }

    if (entry.thinkingOutput) {
      normalized.push({ ...entry, questionNumber: null });
    }
  }

  return normalized;
}

export function ConversationHistory({ entries, defaultShowThinking = false }: ConversationHistoryProps) {
  const { t } = useTranslation("app");
  const [expandedThinking, setExpandedThinking] = useState<Record<number, boolean>>({});
  const normalizedEntries = normalizeEntries(entries);

  if (normalizedEntries.length === 0) {
    return null;
  }

  return (
    <div className="conversation-history" data-testid="conversation-history">
      {normalizedEntries.map((entry, index) => {
        const hasQuestion = Boolean(entry.question);
        const hasThinking = Boolean(entry.thinkingOutput);
        const isExpanded = expandedThinking[index] ?? defaultShowThinking;

        const responseValue = hasQuestion ? getResponseValue(entry) : undefined;
        const formattedResponse =
          entry.question && responseValue && (responseValue.value !== undefined || responseValue.other.length > 0)
            ? formatResponse(entry.question, responseValue.value, t, responseValue.other)
            : "";
        const responseRecord =
          entry.response && typeof entry.response === "object" && !Array.isArray(entry.response)
            ? (entry.response as Record<string, unknown>)
            : undefined;
        const comment =
          typeof responseRecord?.[PLANNING_COMMENT_RESPONSE_KEY] === "string"
            ? responseRecord[PLANNING_COMMENT_RESPONSE_KEY].trim()
            : "";

        return (
          <div key={`${entry.question?.id ?? "thinking"}-${index}`} className="conversation-entry">
            {hasQuestion ? (
              <div className="conversation-entry-question">
                <span className="conversation-entry-question-label">Q{entry.questionNumber}</span>
                <p>{entry.question?.question}</p>
              </div>
            ) : (
              <div className="conversation-entry-question">
                <span className="conversation-entry-question-label">{t("conversation.aiReasoning", "AI Reasoning")}</span>
              </div>
            )}

            {hasQuestion && (
              <div className="conversation-entry-response">
                <strong>{t("conversation.yourResponse", "Your response")}</strong>
                <p>{formattedResponse || "—"}</p>
                {comment && <p className="conversation-comment">{COMMENT_ICON} {comment}</p>}
              </div>
            )}

            {hasThinking && (
              <div className="conversation-entry-thinking">
                <button
                  type="button"
                  className="conversation-thinking-toggle"
                  onClick={() => {
                    setExpandedThinking((current) => ({
                      ...current,
                      [index]: !isExpanded,
                    }));
                  }}
                  aria-expanded={isExpanded}
                >
                  <span aria-hidden="true">{isExpanded ? "▾" : "▸"}</span>
                  {isExpanded
                    ? t("conversation.hide", `Hide {{type}}`, { type: hasQuestion ? t("conversation.aiThinking", "AI thinking") : t("conversation.aiReasoning", "AI reasoning") })
                    : t("conversation.show", `Show {{type}}`, { type: hasQuestion ? t("conversation.aiThinking", "AI thinking") : t("conversation.aiReasoning", "AI reasoning") })}
                </button>
                {isExpanded && <pre>{entry.thinkingOutput}</pre>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
