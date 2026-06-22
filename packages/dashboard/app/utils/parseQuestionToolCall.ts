import type { PlanningQuestionType } from "@fusion/core";
import type { ToolCallInfo } from "../hooks/chatTypes";

export const QUESTION_TOOL_NAMES = [
  "AskUserQuestion",
  "ask_user",
  "ask_followup_question",
  "request_user_input",
  "elicit",
  "ask_question",
  "fn_ask_question",
] as const;

const QUESTION_TOOL_NAME_SET = new Set(QUESTION_TOOL_NAMES.map((name) => name.toLowerCase()));

export interface ChatQuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface ChatQuestion {
  id: string;
  type: PlanningQuestionType;
  question: string;
  header?: string;
  description?: string;
  options?: ChatQuestionOption[];
  multiSelect?: boolean;
}

export interface ParsedQuestionToolCall {
  questions: ChatQuestion[];
}

export type ChatQuestionAnswerValue = string | string[] | boolean;
export type ChatQuestionAnswers = Record<string, ChatQuestionAnswerValue>;

/**
 * FNXC:ChatQuestionResponse 2026-06-16-19:18:
 * Chat question tools from multiple agent CLIs and Fusion's native `fn_ask_question` tool must render as structured response controls in ChatView instead of exposing raw JSON in generic tool-call details.
 * Keep schema normalization centralized so both chat surfaces recognize the same question tools, synthesize stable ids, and fall back safely when args are malformed.
 */
export function isQuestionToolName(name: string): boolean {
  return QUESTION_TOOL_NAME_SET.has(name.toLowerCase());
}

export function parseQuestionToolCall(toolCall: ToolCallInfo): ParsedQuestionToolCall | null {
  if (!isQuestionToolName(toolCall.toolName)) {
    return null;
  }

  const args = asRecord(toolCall.args);
  if (!args) {
    return null;
  }

  const rawQuestions = Array.isArray(args.questions) ? args.questions : null;
  const questions = rawQuestions
    ? rawQuestions.map((rawQuestion, index) => normalizeQuestion(rawQuestion, index)).filter(isChatQuestion)
    : [normalizeQuestion(args, 0)].filter(isChatQuestion);

  return questions.length > 0 ? { questions } : null;
}

export function formatQuestionAnswer(questions: ChatQuestion[], answers: ChatQuestionAnswers): string {
  return questions
    .map((question) => {
      const answer = answers[question.id];
      return `> Q: ${question.question}\n${formatAnswerValue(question, answer)}`;
    })
    .join("\n\n");
}

function normalizeQuestion(rawValue: unknown, index: number): ChatQuestion | null {
  const raw = asRecord(rawValue);
  if (!raw) {
    return null;
  }

  const questionText = firstString(raw.question, raw.prompt, raw.message, raw.text, raw.title);
  if (!questionText) {
    return null;
  }

  const options = normalizeOptions(firstArray(raw.options, raw.choices, raw.enum, raw.values));
  const explicitType = normalizeQuestionType(firstString(raw.type, raw.questionType, raw.inputType, raw.responseType));
  const multiSelect = Boolean(raw.multiSelect ?? raw.multiselect ?? raw.multiple ?? raw.allowMultiple ?? raw.multiple_choice);
  if ((explicitType === "single_select" || explicitType === "multi_select") && options.length === 0) {
    return null;
  }

  const type = inferQuestionType(raw, options, explicitType, multiSelect);

  if ((type === "single_select" || type === "multi_select") && options.length === 0) {
    return null;
  }

  return {
    id: firstString(raw.id, raw.name, raw.key) ?? `q-${index}`,
    type,
    question: questionText,
    header: firstString(raw.header, raw.heading) ?? undefined,
    description: firstString(raw.description, raw.details, raw.helpText) ?? undefined,
    options: options.length > 0 ? options : undefined,
    multiSelect: type === "multi_select" ? true : multiSelect || undefined,
  };
}

function inferQuestionType(
  raw: Record<string, unknown>,
  options: ChatQuestionOption[],
  explicitType: PlanningQuestionType | null,
  multiSelect: boolean,
): PlanningQuestionType {
  if (explicitType) {
    if (explicitType === "multi_select" && options.length === 0) return "text";
    if (explicitType === "single_select" && options.length === 0) return "text";
    return explicitType;
  }

  if (isBooleanSchema(raw, options)) {
    return "confirm";
  }

  if (options.length > 0) {
    return multiSelect ? "multi_select" : "single_select";
  }

  return "text";
}

function normalizeQuestionType(value: string | null): PlanningQuestionType | null {
  if (!value) return null;
  const normalized = value.toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "text" || normalized === "free_text" || normalized === "input") return "text";
  if (normalized === "single_select" || normalized === "select" || normalized === "choice") return "single_select";
  if (normalized === "multi_select" || normalized === "multiple_select" || normalized === "checkbox") return "multi_select";
  if (normalized === "confirm" || normalized === "confirmation" || normalized === "boolean" || normalized === "yes_no") return "confirm";
  return null;
}

function isBooleanSchema(raw: Record<string, unknown>, options: ChatQuestionOption[]): boolean {
  const rawType = firstString(raw.type, raw.schemaType, raw.inputType, raw.responseType)?.toLowerCase().replace(/[\s-]+/g, "_");
  if (rawType === "boolean" || rawType === "confirm" || rawType === "confirmation" || rawType === "yes_no") {
    return true;
  }

  const schema = asRecord(raw.schema) ?? asRecord(raw.inputSchema) ?? asRecord(raw.parameters);
  const schemaType = firstString(schema?.type, schema?.format)?.toLowerCase().replace(/[\s-]+/g, "_");
  if (schemaType === "boolean" || schemaType === "yes_no") {
    return true;
  }

  if (options.length !== 2) {
    return false;
  }

  const labels = options.map((option) => option.label.trim().toLowerCase());
  return labels.includes("yes") && labels.includes("no");
}

function normalizeOptions(rawOptions: unknown[] | null): ChatQuestionOption[] {
  if (!rawOptions) return [];

  return rawOptions
    .map((rawOption, index) => {
      const raw = asRecord(rawOption);
      if (!raw) {
        if (typeof rawOption === "string" || typeof rawOption === "number" || typeof rawOption === "boolean") {
          return { id: `opt-${index}`, label: String(rawOption) };
        }
        return null;
      }

      const label = firstString(raw.label, raw.text, raw.name, raw.title, raw.value, raw.id);
      if (!label) {
        return null;
      }

      return {
        id: firstString(raw.id, raw.value, raw.key) ?? `opt-${index}`,
        label,
        description: firstString(raw.description, raw.details, raw.helpText) ?? undefined,
      };
    })
    .filter(isChatQuestionOption);
}

function formatAnswerValue(question: ChatQuestion, answer: ChatQuestionAnswerValue | undefined): string {
  if (answer === undefined) {
    return "(no answer)";
  }

  if (question.type === "confirm") {
    return answer === true ? "Yes" : "No";
  }

  if (Array.isArray(answer)) {
    const selectedLabels = answer.map((id) => optionLabelForId(question, id)).filter(Boolean);
    return selectedLabels.length > 0 ? selectedLabels.join(", ") : "(no answer)";
  }

  if (question.type === "single_select") {
    return optionLabelForId(question, String(answer)) ?? String(answer);
  }

  return String(answer).trim() || "(no answer)";
}

function optionLabelForId(question: ChatQuestion, id: string): string | null {
  return question.options?.find((option) => option.id === id)?.label ?? null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
  }
  return null;
}

function firstArray(...values: unknown[]): unknown[] | null {
  return values.find(Array.isArray) ?? null;
}

function isChatQuestion(value: ChatQuestion | null): value is ChatQuestion {
  return value !== null;
}

function isChatQuestionOption(value: ChatQuestionOption | null): value is ChatQuestionOption {
  return value !== null;
}
