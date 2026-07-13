import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ThinkingLevel } from "@fusion/core";
import type { AgentCapability, ConversationHistoryEntry } from "../api";
import {
  startAgentOnboardingStreaming,
  respondToAgentOnboarding,
  retryAgentOnboardingSession,
  stopAgentOnboardingGeneration,
  cancelAgentOnboarding,
  createAgent,
  connectAgentOnboardingStream,
  fetchModels,
  type Agent,
  type AgentOnboardingSummary,
  type ModelInfo,
} from "../api";
import { AGENT_PRESETS } from "./agent-presets";
import { ConversationHistory } from "./ConversationHistory";
import { CustomModelDropdown } from "./CustomModelDropdown";
import "./AgentOnboardingModal.css";
import { useAutosizeTextarea } from "../hooks/useAutosizeTextarea";

type ViewState = "initial" | "loading" | "question" | "summary" | "creating" | "error";

interface AgentOnboardingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: () => void;
  addToast: (message: string, type?: "success" | "error") => void;
  projectId?: string;
  existingAgents: Agent[];
}

export function AgentOnboardingModal({ isOpen, onClose, onCreated, addToast, projectId, existingAgents }: AgentOnboardingModalProps) {
  const { t } = useTranslation("app");
  const [viewState, setViewState] = useState<ViewState>("initial");
  const [intent, setIntent] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [currentQuestion, setCurrentQuestion] = useState<string>("");
  const [currentQuestionId, setCurrentQuestionId] = useState<string>("answer");
  const [answer, setAnswer] = useState("");
  const [summary, setSummary] = useState<AgentOnboardingSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<ConversationHistoryEntry[]>([]);
  const [runtimeMode, setRuntimeMode] = useState<"model" | "runtime">("model");
  const [model, setModel] = useState<string>("");
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  // Align onboarding long-form textareas with FN-5146's 640px chat composer cap
  // so multi-paragraph intent and answer drafts stay visible while typing.
  const { ref: intentAutosizeRef } = useAutosizeTextarea({ value: intent, minHeight: 120, maxHeight: 640 });
  const { ref: answerAutosizeRef } = useAutosizeTextarea({ value: answer, minHeight: 120, maxHeight: 640, deps: [currentQuestionId] });
  const setIntentRef = useCallback((node: HTMLTextAreaElement | null) => {
    intentAutosizeRef(node);
  }, [intentAutosizeRef]);
  const setAnswerRef = useCallback((node: HTMLTextAreaElement | null) => {
    answerAutosizeRef(node);
  }, [answerAutosizeRef]);

  const templateOptions = useMemo(
    () => AGENT_PRESETS.map((preset) => ({ id: preset.id, label: preset.name, description: preset.description })),
    [],
  );

  useEffect(() => {
    void fetchModels().then((data) => setAvailableModels(data.models)).catch(() => setAvailableModels([]));
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    const stream = connectAgentOnboardingStream(sessionId, projectId, {
      onThinking: (data) => {
        setHistory((current) => {
          const next = [...current];
          const last = next[next.length - 1];
          if (last && !last.question) {
            next[next.length - 1] = { ...last, thinkingOutput: `${last.thinkingOutput ?? ""}${data}` };
            return next;
          }
          return [...next, { response: {}, thinkingOutput: data }];
        });
      },
      onQuestion: (q) => {
        setCurrentQuestion(q.question);
        setCurrentQuestionId(q.id);
        setViewState("question");
      },
      onSummary: (nextSummary) => {
        setSummary(nextSummary);
        setViewState("summary");
      },
      onError: (message) => {
        setError(message);
        setViewState("error");
      },
      onComplete: () => {
        if (summary) {
          setViewState("summary");
        }
      },
      onConnectionStateChange: (state) => {
        if (state === "reconnecting") {
          setError(t("agents.connectionLost", "Connection lost. Retrying..."));
        }
      },
    });

    return () => stream.close();
  }, [sessionId, projectId]);

  const handleClose = async () => {
    if (sessionId) {
      await cancelAgentOnboarding(sessionId, projectId);
    }
    onClose();
  };

  if (!isOpen) return null;

  const start = async () => {
    setViewState("loading");
    setError(null);
    try {
      const result = await startAgentOnboardingStreaming(
        intent,
        {
          existingAgents: existingAgents.map((agent) => ({ id: agent.id, name: agent.name, role: agent.role })),
          templates: templateOptions,
        },
        projectId,
      );
      setSessionId(result.sessionId);
    } catch (err) {
      setError((err as Error).message);
      setViewState("error");
    }
  };

  const submitAnswer = async () => {
    if (!sessionId) return;
    setViewState("loading");
    setError(null);
    try {
      const responsePayload = { [currentQuestionId]: answer };
      setHistory((current) => [
        ...current,
        {
          question: { id: currentQuestionId, type: "text", question: currentQuestion },
          response: responsePayload,
        },
      ]);
      await respondToAgentOnboarding(sessionId, responsePayload, projectId);
      setAnswer("");
    } catch (err) {
      setError((err as Error).message);
      setViewState("error");
    }
  };

  const createFromSummary = async () => {
    if (!summary) return;
    setViewState("creating");
    setError(null);
    try {
      await createAgent(
        {
          name: summary.name,
          role: summary.role as AgentCapability,
          title: summary.title,
          icon: summary.icon,
          reportsTo: summary.reportsTo,
          instructionsText: summary.instructionsText,
          soul: summary.soul,
          memory: summary.memory,
          runtimeConfig: {
            thinkingLevel: summary.thinkingLevel,
            maxTurns: summary.maxTurns,
            ...(runtimeMode === "model" && model ? { model } : {}),
            ...(runtimeMode === "runtime" ? { runtimeHint: "onboarding" } : {}),
          },
          metadata: summary.skills ? { skills: summary.skills } : undefined,
        },
        projectId,
      );
      addToast(t("agents.created", "Agent \"{{name}}\" created", { name: summary.name }), "success");
      onCreated();
    } catch (err) {
      setError((err as Error).message);
      setViewState("error");
    }
  };

  return (
    <div className="modal-overlay open" role="presentation">
      <div className="modal modal-lg agent-onboarding-modal" role="dialog" aria-modal="true" aria-label={t("agents.onboarding.title", "Agent Onboarding")}>
        <div className="modal-header">
          <h3>{t("agents.onboarding.title", "Agent Onboarding")}</h3>
          <button className="modal-close" onClick={() => void handleClose()} aria-label={t("common.close", "Close")}>×</button>
        </div>

        {history.length > 0 && <ConversationHistory entries={history} />}

        {viewState === "initial" && (
          <div className="form-group">
            <label htmlFor="agent-onboarding-intent">{t("agents.intentPrompt", "What do you want this agent to do?")}</label>
            <textarea ref={setIntentRef} id="agent-onboarding-intent" className="input" value={intent} onChange={(e) => setIntent(e.target.value)} />
            <div className="modal-actions">
              <button className="btn" onClick={() => void handleClose()}>{t("common.cancel", "Cancel")}</button>
              <button className="btn btn-primary" disabled={!intent.trim()} onClick={() => void start()}>{t("agents.startOnboarding", "Start onboarding")}</button>
            </div>
          </div>
        )}

        {(viewState === "loading" || viewState === "question") && (
          <div className="form-group">
            <label htmlFor="agent-onboarding-answer">{currentQuestion || t("agents.waitingForQuestion", "Waiting for AI question...")}</label>
            <textarea ref={setAnswerRef} id="agent-onboarding-answer" className="input" value={answer} onChange={(e) => setAnswer(e.target.value)} />
            <div className="modal-actions">
              <button className="btn" onClick={() => sessionId && void stopAgentOnboardingGeneration(sessionId, projectId)}>{t("common.stop", "Stop")}</button>
              <button className="btn btn-primary" disabled={viewState === "loading" || !answer.trim()} onClick={() => void submitAnswer()}>{t("common.continue", "Continue")}</button>
            </div>
          </div>
        )}

        {viewState === "summary" && summary && (
          <div className="form-group">
            <label>{t("agents.reviewConfiguration", "Review generated configuration")}</label>
            <div className="agent-onboarding-summary">
              <p><strong>{t("agents.name", "Name")}:</strong> {summary.name}</p>
              <p><strong>{t("agents.role", "Role")}:</strong> {summary.role}</p>
              <label htmlFor="max-turns">{t("agents.maxTurns", "Max turns")}</label>
              <input id="max-turns" className="input" type="number" value={summary.maxTurns} onChange={() => {}} readOnly />
              <label htmlFor="runtime-mode">{t("agents.runtimeMode", "Runtime mode")}</label>
              <select id="runtime-mode" className="select" value={runtimeMode} onChange={(e) => setRuntimeMode(e.target.value as "model" | "runtime")}>
                <option value="model">{t("agents.model", "Model")}</option>
                <option value="runtime">{t("agents.runtime", "Runtime")}</option>
              </select>
              {runtimeMode === "model" && (
                <>
                  <label>{t("agents.selectModel", "Model")}</label>
                  {/*
                  FNXC:Settings-ThinkingLevel 2026-07-12-00:00:
                  Agent onboarding's model picker owns the generated runtimeConfig.thinkingLevel so operators can edit the concrete reasoning effort before creating the agent, matching NewAgentDialog without an inherit/default lane.
                  */}
                  <CustomModelDropdown
                    id="agent-onboarding-model"
                    label={t("agents.selectModel", "Model")}
                    value={model}
                    onChange={setModel}
                    models={availableModels}
                    placeholder={t("agents.selectModelPlaceholder", "Select a model…")}
                    thinkingLevel={summary.thinkingLevel}
                    onThinkingLevelChange={(level) => {
                      setSummary((current) => current ? { ...current, thinkingLevel: level as ThinkingLevel } : current);
                    }}
                  />
                </>
              )}
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => void handleClose()}>{t("common.cancel", "Cancel")}</button>
              <button className="btn btn-primary" onClick={() => void createFromSummary()}>{t("agents.createAgent", "Create agent")}</button>
            </div>
          </div>
        )}

        {viewState === "creating" && (
          <div className="form-group agent-onboarding-creating">{t("agents.creatingAgent", "Creating agent...")}</div>
        )}

        {viewState === "error" && error && (
          <div className="form-group">
            <div className="form-error">{error}</div>
            <div className="modal-actions">
              <button className="btn" onClick={() => sessionId && void retryAgentOnboardingSession(sessionId, projectId)}>{t("common.retry", "Retry")}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
