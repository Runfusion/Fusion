import type { PlanningQuestion } from "@fusion/core";
import { useState } from "react";
import type { ConversationHistoryEntry } from "../api";

interface ConversationHistoryProps {
  entries: ConversationHistoryEntry[];
  defaultShowThinking?: boolean;
}

interface NumberedEntry extends ConversationHistoryEntry {
  questionNumber: number | null;
}

function getResponseValue(entry: ConversationHistoryEntry): unknown {
  const { question, response } = entry;
  if (!question) return response;

  if (response && typeof response === "object" && !Array.isArray(response)) {
    const record = response as Record<string, unknown>;
    if (question.id in record) {
      return record[question.id];
    }
  }

  return response;
}

function formatResponse(question: PlanningQuestion, responseValue: unknown): string {
  switch (question.type) {
    case "text": {
      if (typeof responseValue === "string") return responseValue;
      return responseValue == null ? "" : String(responseValue);
    }
    case "single_select": {
      if (typeof responseValue === "string") {
        const selected = question.options?.find((option) => option.id === responseValue);
        return selected?.label ?? responseValue;
      }
      return responseValue == null ? "" : String(responseValue);
    }
    case "multi_select": {
      if (Array.isArray(responseValue)) {
        return responseValue
          .map((value) => {
            if (typeof value !== "string") {
              return String(value);
            }
            const selected = question.options?.find((option) => option.id === value);
            return selected?.label ?? value;
          })
          .join(", ");
      }
      return responseValue == null ? "" : String(responseValue);
    }
    case "confirm": {
      if (responseValue === true) return "Yes";
      if (responseValue === false) return "No";
      return responseValue == null ? "" : String(responseValue);
    }
    default:
      return responseValue == null ? "" : JSON.stringify(responseValue);
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
          entry.question && responseValue !== undefined
            ? formatResponse(entry.question, responseValue)
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
                <span className="conversation-entry-question-label">AI Reasoning</span>
              </div>
            )}

            {hasQuestion && (
              <div className="conversation-entry-response">
                <strong>Your response</strong>
                <p>{formattedResponse || "—"}</p>
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
                    ? `Hide ${hasQuestion ? "AI thinking" : "AI reasoning"}`
                    : `Show ${hasQuestion ? "AI thinking" : "AI reasoning"}`}
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
