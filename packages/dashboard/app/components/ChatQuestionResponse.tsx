import "./ChatQuestionResponse.css";

import { useCallback, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { useTranslation } from "react-i18next";
import type { ChatQuestion, ChatQuestionAnswers, ChatQuestionAnswerValue, ParsedQuestionToolCall } from "../utils/parseQuestionToolCall";
import { formatQuestionAnswer } from "../utils/parseQuestionToolCall";

export interface ChatQuestionResponseProps {
  parsed: ParsedQuestionToolCall;
  answered?: boolean;
  submittedAnswer?: string;
  compact?: boolean;
  disabled?: boolean;
  onSubmit: (answerText: string, structured: Record<string, unknown>) => void;
}

/**
 * FNXC:ChatQuestionResponse 2026-06-16-19:25:
 * In-chat question tools need an attractive shared answer affordance for single-select, multi-select, free-text, and confirm prompts.
 * Historical or already-answered messages must render read-only so old assistant questions do not keep duplicate live input boxes in regular chat or quick chat.
 */
export function ChatQuestionResponse({
  parsed,
  answered = false,
  submittedAnswer,
  compact = false,
  disabled = false,
  onSubmit,
}: ChatQuestionResponseProps) {
  const { t } = useTranslation("app");
  const [answers, setAnswers] = useState<ChatQuestionAnswers>({});
  const textareaRefs = useRef(new Map<string, HTMLTextAreaElement>());

  const isValid = useMemo(
    () => parsed.questions.every((question) => isQuestionAnswerValid(question, answers[question.id])),
    [answers, parsed.questions],
  );

  useLayoutEffect(() => {
    for (const textarea of textareaRefs.current.values()) {
      textarea.style.height = "0";
      textarea.style.height = `${textarea.scrollHeight}px`;
    }
  }, [answers]);

  const setQuestionAnswer = useCallback((questionId: string, value: ChatQuestionAnswerValue) => {
    setAnswers((current) => ({ ...current, [questionId]: value }));
  }, []);

  const toggleMultiSelect = useCallback((questionId: string, optionId: string, checked: boolean) => {
    setAnswers((current) => {
      const currentValue = current[questionId];
      const selected = Array.isArray(currentValue) ? currentValue : [];
      return {
        ...current,
        [questionId]: checked ? [...selected, optionId] : selected.filter((id) => id !== optionId),
      };
    });
  }, []);

  const handleSubmit = useCallback(() => {
    if (!isValid || answered || disabled) {
      return;
    }

    const answerText = formatQuestionAnswer(parsed.questions, answers);
    onSubmit(answerText, answers);
  }, [answers, answered, disabled, isValid, onSubmit, parsed.questions]);

  return (
    <section
      className={`chat-question-response${compact ? " chat-question-response--compact" : ""}${answered ? " chat-question-response--answered" : ""}`}
      data-testid="chat-question-response"
      aria-label={t("chat.questionResponseLabel", "Question from assistant")}
    >
      <div className="chat-question-response__header">
        <span className="chat-question-response__eyebrow">{t("chat.questionResponseEyebrow", "Assistant question")}</span>
        {answered && <span className="chat-question-response__answered-label">{t("chat.questionAnsweredLabel", "Answered")}</span>}
      </div>

      <div className="chat-question-response__questions">
        {parsed.questions.map((question, questionIndex) => (
          <article className="chat-question-response__question" key={question.id}>
            {question.header && <p className="chat-question-response__question-header">{question.header}</p>}
            <h4 className="chat-question-response__question-text">{question.question}</h4>
            {question.description && <p className="chat-question-response__description">{question.description}</p>}

            {answered ? null : (
              <QuestionControls
                question={question}
                questionIndex={questionIndex}
                value={answers[question.id]}
                disabled={disabled}
                setQuestionAnswer={setQuestionAnswer}
                toggleMultiSelect={toggleMultiSelect}
                textareaRefs={textareaRefs}
              />
            )}
          </article>
        ))}
      </div>

      {answered ? (
        <div className="chat-question-response__submitted" data-testid="chat-question-response-submitted-answer">
          <span className="chat-question-response__submitted-label">{t("chat.questionSubmittedAnswerLabel", "Submitted answer")}</span>
          <pre>{submittedAnswer || t("chat.questionAnsweredWithoutContent", "A later user reply answered this question.")}</pre>
        </div>
      ) : (
        <div className="chat-question-response__actions">
          <p className="chat-question-response__hint">{t("chat.questionSelectHint", "Answer all questions to continue the chat.")}</p>
          <button
            type="button"
            className="btn btn-primary chat-question-response__submit"
            data-testid="chat-question-response-submit"
            disabled={!isValid || disabled}
            onClick={handleSubmit}
          >
            {t("chat.questionSubmit", "Send answer")}
          </button>
        </div>
      )}
    </section>
  );
}

interface QuestionControlsProps {
  question: ChatQuestion;
  questionIndex: number;
  value: ChatQuestionAnswerValue | undefined;
  disabled: boolean;
  setQuestionAnswer: (questionId: string, value: ChatQuestionAnswerValue) => void;
  toggleMultiSelect: (questionId: string, optionId: string, checked: boolean) => void;
  textareaRefs: MutableRefObject<Map<string, HTMLTextAreaElement>>;
}

function QuestionControls({
  question,
  questionIndex,
  value,
  disabled,
  setQuestionAnswer,
  toggleMultiSelect,
  textareaRefs,
}: QuestionControlsProps) {
  const { t } = useTranslation("app");

  if (question.type === "text") {
    return (
      <textarea
        className="input chat-question-response__textarea"
        data-testid={`chat-question-response-text-${question.id}`}
        placeholder={t("chat.questionTextPlaceholder", "Type your answer here…")}
        value={typeof value === "string" ? value : ""}
        disabled={disabled}
        rows={3}
        ref={(element) => {
          if (element) {
            textareaRefs.current.set(question.id, element);
          } else {
            textareaRefs.current.delete(question.id);
          }
        }}
        onChange={(event) => setQuestionAnswer(question.id, event.target.value)}
      />
    );
  }

  if (question.type === "confirm") {
    return (
      <div className="chat-question-response__confirm-group" role="group" aria-label={question.question}>
        <button
          type="button"
          className={`btn chat-question-response__confirm${value === true ? " chat-question-response__confirm--selected" : ""}`}
          data-testid={`chat-question-response-option-${question.id}-yes`}
          disabled={disabled}
          onClick={() => setQuestionAnswer(question.id, true)}
        >
          {t("chat.questionConfirmYes", "Yes")}
        </button>
        <button
          type="button"
          className={`btn chat-question-response__confirm${value === false ? " chat-question-response__confirm--selected" : ""}`}
          data-testid={`chat-question-response-option-${question.id}-no`}
          disabled={disabled}
          onClick={() => setQuestionAnswer(question.id, false)}
        >
          {t("chat.questionConfirmNo", "No")}
        </button>
      </div>
    );
  }

  const options = question.options ?? [];
  const selectedValues = Array.isArray(value) ? value : [];
  const radioName = `chat-question-${question.id}-${questionIndex}`;
  const isMulti = question.type === "multi_select";

  return (
    <div className="chat-question-response__options" role={isMulti ? "group" : "radiogroup"} aria-label={question.question}>
      {options.map((option) => {
        const checked = isMulti ? selectedValues.includes(option.id) : value === option.id;
        return (
          <label
            key={option.id}
            className={`chat-question-response__option${checked ? " chat-question-response__option--selected" : ""}`}
            data-testid={`chat-question-response-option-${question.id}-${option.id}`}
          >
            <input
              type={isMulti ? "checkbox" : "radio"}
              name={isMulti ? undefined : radioName}
              value={option.id}
              checked={checked}
              disabled={disabled}
              onChange={(event) => {
                if (isMulti) {
                  toggleMultiSelect(question.id, option.id, event.target.checked);
                } else {
                  setQuestionAnswer(question.id, option.id);
                }
              }}
            />
            <span className="chat-question-response__option-content">
              <span className="chat-question-response__option-label">{option.label}</span>
              {option.description && <span className="chat-question-response__option-description">{option.description}</span>}
            </span>
          </label>
        );
      })}
    </div>
  );
}

function isQuestionAnswerValid(question: ChatQuestion, value: ChatQuestionAnswerValue | undefined): boolean {
  if (question.type === "text") {
    return typeof value === "string" && value.trim().length > 0;
  }

  if (question.type === "multi_select") {
    return Array.isArray(value) && value.length > 0;
  }

  if (question.type === "confirm") {
    return typeof value === "boolean";
  }

  return typeof value === "string" && value.trim().length > 0;
}
