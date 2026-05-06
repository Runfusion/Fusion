import { useCallback, useEffect, useMemo, useState } from "react";
import type { Agent, AgentOnboardingSummary, ConversationHistoryEntry } from "../api";
import {
  cancelAgentOnboarding,
  connectAgentOnboardingStream,
  respondToAgentOnboarding,
  startAgentOnboardingStreaming,
} from "../api";
import { AGENT_PRESETS } from "./agent-presets";
import { ConversationHistory } from "./ConversationHistory";
import "./ExperimentalAgentOnboardingModal.css";

type ViewState = "initial" | "loading" | "question" | "summary" | "error";

interface ExperimentalAgentOnboardingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onUseDraft: (summary: AgentOnboardingSummary) => void;
  projectId?: string;
  existingAgents: Agent[];
}

export function ExperimentalAgentOnboardingModal({
  isOpen,
  onClose,
  onUseDraft,
  projectId,
  existingAgents,
}: ExperimentalAgentOnboardingModalProps) {
  const [viewState, setViewState] = useState<ViewState>("initial");
  const [intent, setIntent] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [currentQuestion, setCurrentQuestion] = useState("");
  const [currentQuestionId, setCurrentQuestionId] = useState("answer");
  const [answer, setAnswer] = useState("");
  const [summary, setSummary] = useState<AgentOnboardingSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<ConversationHistoryEntry[]>([]);

  const resetState = useCallback(() => {
    setViewState("initial");
    setIntent("");
    setSessionId(null);
    setCurrentQuestion("");
    setCurrentQuestionId("answer");
    setAnswer("");
    setSummary(null);
    setError(null);
    setHistory([]);
  }, []);

  const templateOptions = useMemo(
    () => AGENT_PRESETS.map((preset) => ({ id: preset.id, label: preset.name, description: preset.description })),
    [],
  );

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
    });
    return () => stream.close();
  }, [sessionId, projectId]);

  const handleClose = async () => {
    try {
      if (sessionId) {
        await cancelAgentOnboarding(sessionId, projectId);
      }
    } catch {
      // Best-effort server-side cleanup; always allow modal dismissal.
    } finally {
      resetState();
      onClose();
    }
  };

  useEffect(() => {
    if (!isOpen) {
      resetState();
    }
  }, [isOpen, resetState]);

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

  return (
    <div className="modal-overlay open" role="presentation">
      <div className="modal modal-lg experimental-agent-onboarding-modal" role="dialog" aria-modal="true" aria-label="AI Interview">
        <div className="modal-header">
          <h3>AI Interview</h3>
          <button className="modal-close" onClick={() => void handleClose()} aria-label="Close">×</button>
        </div>

        {history.length > 0 && <ConversationHistory entries={history} />}

        {viewState === "initial" && (
          <div className="form-group">
            <label htmlFor="agent-onboarding-intent">What should this new agent own?</label>
            <textarea id="agent-onboarding-intent" className="input experimental-agent-onboarding-modal__textarea" value={intent} onChange={(e) => setIntent(e.target.value)} />
            <div className="modal-actions">
              <button className="btn" onClick={() => void handleClose()}>Cancel</button>
              <button className="btn btn-primary" disabled={!intent.trim()} onClick={() => void start()}>Start onboarding</button>
            </div>
          </div>
        )}

        {(viewState === "loading" || viewState === "question") && (
          <div className="form-group">
            <label htmlFor="agent-onboarding-answer">{currentQuestion || "Thinking..."}</label>
            <textarea id="agent-onboarding-answer" className="input experimental-agent-onboarding-modal__textarea" value={answer} onChange={(e) => setAnswer(e.target.value)} />
            <div className="modal-actions">
              <button className="btn" onClick={() => void handleClose()}>Cancel</button>
              <button className="btn btn-primary" disabled={viewState === "loading" || !answer.trim()} onClick={() => void submitAnswer()}>Continue</button>
            </div>
          </div>
        )}

        {viewState === "summary" && summary && (
          <div className="form-group">
            <label>Draft ready for review</label>
            <div className="experimental-agent-onboarding-modal__summary card">
              <div className="experimental-agent-onboarding-modal__summary-section">
                <h4>Profile</h4>
                <p><strong>Name:</strong> {summary.name}</p>
                <p><strong>Role:</strong> {summary.role}</p>
                {summary.title && <p><strong>Title:</strong> {summary.title}</p>}
                {summary.icon && <p><strong>Icon:</strong> {summary.icon}</p>}
                {summary.templateId && <p><strong>Template:</strong> {summary.templateId}</p>}
                {summary.patternAgentId && <p><strong>Pattern agent:</strong> {summary.patternAgentId}</p>}
                {summary.reportsTo && <p><strong>Reports to:</strong> {summary.reportsTo}</p>}
                {summary.rationale && <p><strong>Why:</strong> {summary.rationale}</p>}
              </div>

              {summary.soul && (
                <div className="experimental-agent-onboarding-modal__summary-section">
                  <h4>Soul / personality</h4>
                  <p className="experimental-agent-onboarding-modal__summary-block">{summary.soul}</p>
                </div>
              )}

              <div className="experimental-agent-onboarding-modal__summary-section">
                <h4>Core instructions</h4>
                <p className="experimental-agent-onboarding-modal__summary-block">{summary.instructionsText}</p>
              </div>

              <div className="experimental-agent-onboarding-modal__summary-section">
                <h4>Runtime hints</h4>
                <p><strong>Thinking level:</strong> {summary.thinkingLevel}</p>
                <p><strong>Max turns:</strong> {summary.maxTurns}</p>
              </div>

              {summary.memory && (
                <div className="experimental-agent-onboarding-modal__summary-section">
                  <h4>Starter memory / playbook</h4>
                  <p className="experimental-agent-onboarding-modal__summary-block">{summary.memory}</p>
                </div>
              )}

              {summary.skills && summary.skills.length > 0 && (
                <div className="experimental-agent-onboarding-modal__summary-section">
                  <h4>Skills</h4>
                  <p>{summary.skills.join(", ")}</p>
                </div>
              )}
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => void handleClose()}>Cancel</button>
              <button className="btn btn-primary" onClick={() => onUseDraft(summary)}>Continue to agent form</button>
            </div>
          </div>
        )}

        {viewState === "error" && error && (
          <div className="form-group">
            <div className="form-error">{error}</div>
            <div className="modal-actions">
              <button className="btn" onClick={() => void handleClose()}>Close</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
