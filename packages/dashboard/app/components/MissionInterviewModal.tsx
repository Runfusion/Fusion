import { useState, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { PlanningQuestion, ThinkingLevel } from "@fusion/core";
import { getErrorMessage, THINKING_LEVELS } from "@fusion/core";
import {
  startMissionInterview,
  respondToMissionInterview,
  retryMissionInterviewSession,
  createMissionFromInterview,
  connectMissionInterviewStream,
  fetchAiSession,
  parseConversationHistory,
  fetchModels,
  updateGlobalSettings,
  type MissionPlanSummary,
  type ConversationHistoryEntry,
  type MissionPlanMilestone,
  type MissionPlanSlice,
  type MissionPlanFeature,
  type MissionWithHierarchy,
  type ModelInfo,
  type AiSessionDetail,
} from "../api";
import {
  saveMissionGoal,
  getMissionGoal,
  clearMissionGoal,
} from "../hooks/modalPersistence";
import {
  Target,
  X,
  Loader2,
  CheckCircle,
  ArrowLeft,
  ArrowRight,
  Sparkles,
  ChevronRight,
  ChevronDown,
  Layers,
  Package,
  Box,
  Plus,
  Trash2,
  RefreshCw,
  Minimize2,
} from "lucide-react";
import { ConversationHistory } from "./ConversationHistory";
import { CustomModelDropdown } from "./CustomModelDropdown";
import { FloatingWindow } from "./FloatingWindow";
import { useAiSessionSync } from "../hooks/useAiSessionSync";
import { useMobileScrollLock } from "../hooks/useMobileScrollLock";
import "./MissionInterviewModal.css";

// Helper functions for model selection
function getModelSelectionValue(provider?: string, modelId?: string): string {
  return provider && modelId ? `${provider}/${modelId}` : "";
}

function parseModelSelection(value: string): { provider?: string; modelId?: string } {
  if (!value) {
    return { provider: undefined, modelId: undefined };
  }

  const slashIndex = value.indexOf("/");
  if (slashIndex === -1) {
    return { provider: undefined, modelId: undefined };
  }

  return {
    provider: value.slice(0, slashIndex),
    modelId: value.slice(slashIndex + 1),
  };
}

const WARNING_ICON = "⚠️";
const MISSION_INTERVIEW_OTHER_RESPONSE_KEY = "_other";
const MISSION_INTERVIEW_OTHER_OPTION_ID = "__other__";

interface MissionInterviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  onMissionCreated: (mission: MissionWithHierarchy) => void;
  projectId?: string;
  initialGoal?: string;
  resumeSessionId?: string;
  onSendToBackground?: () => void;
  showSendToBackgroundButton?: boolean;
}

interface QuestionResponse {
  [key: string]: unknown;
}

type ViewState =
  | { type: "initial" }
  | { type: "loading" }
  | { type: "question"; sessionId: string; question: PlanningQuestion }
  | { type: "summary"; sessionId: string; summary: MissionPlanSummary }
  | { type: "error"; sessionId: string; errorMessage: string };

const EXAMPLE_MISSIONS = [
  "Build a real-time collaborative document editor",
  "Create a customer onboarding flow with email verification",
  "Add a reporting dashboard with charts and CSV export",
  "Implement a plugin system with marketplace",
];

export function MissionInterviewModal({
  isOpen,
  onClose,
  onMissionCreated,
  projectId,
  initialGoal: initialGoalProp,
  resumeSessionId,
  onSendToBackground,
  showSendToBackgroundButton = false,
}: MissionInterviewModalProps) {
  const { t } = useTranslation("app");
  useMobileScrollLock(isOpen);
  const [missionGoal, setMissionGoal] = useState("");
  const [view, setView] = useState<ViewState>({ type: "initial" });
  const [error, setError] = useState<string | null>(null);
  const [responseHistory, setResponseHistory] = useState<QuestionResponse[]>([]);
  const [conversationHistory, setConversationHistory] = useState<ConversationHistoryEntry[]>([]);
  const [editedSummary, setEditedSummary] = useState<MissionPlanSummary | null>(null);
  const [_hasProgress, setHasProgress] = useState(false);
  const hasAutoStartedRef = useRef(false);
  const [streamingOutput, setStreamingOutput] = useState("");
  const [showThinking, setShowThinking] = useState(true);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const streamConnectionRef = useRef<{ close: () => void; isConnected: () => boolean } | null>(null);
  const currentSessionIdRef = useRef<string | null>(null);
  const streamErrorRecoverySeqRef = useRef(0);
  const canSendToBackground = showSendToBackgroundButton && view.type !== "initial";
  /*
  FNXC:PlanningMultiTab 2026-07-14-00:00:
  No tab lock: the persisted session row is the shared source of truth, so every tab may read
  and interact with this interview. The lock overlay, Take Control affordance, ownership
  broadcasts, heartbeat, and the "active in another tab" banner were removed; only
  session-status sync remains.
  */
  const { broadcastUpdate, broadcastCompleted } = useAiSessionSync();

  // Model selection state
  const [modelProvider, setModelProvider] = useState<string | undefined>(undefined);
  const [modelId, setModelId] = useState<string | undefined>(undefined);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | "">("");
  const [loadedModels, setLoadedModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [favoriteProviders, setFavoriteProviders] = useState<string[]>([]);
  const [favoriteModels, setFavoriteModels] = useState<string[]>([]);

  const modelSelectionValue = getModelSelectionValue(modelProvider, modelId);

  // Load models on mount
  useEffect(() => {
    const load = async () => {
      try {
        setModelsLoading(true);
        const resp = await fetchModels();
        setLoadedModels(resp.models);
        setFavoriteProviders(resp.favoriteProviders);
        setFavoriteModels(resp.favoriteModels);
      } catch (err) {
        setModelsError(getErrorMessage(err) || "Failed to load models");
      } finally {
        setModelsLoading(false);
      }
    };
    void load();
  }, []);

  const handleToggleFavoriteProvider = useCallback((provider: string) => {
    setFavoriteProviders((prev) => {
      const currentFavorites = prev;
      const isFavorite = currentFavorites.includes(provider);
      const newFavorites = isFavorite
        ? currentFavorites.filter((item) => item !== provider)
        : [provider, ...currentFavorites];

      updateGlobalSettings({ favoriteProviders: newFavorites, favoriteModels }).catch(() => {
        setFavoriteProviders(currentFavorites);
      });

      return newFavorites;
    });
  }, [favoriteModels]);

  const handleToggleFavoriteModel = useCallback((modelIdToToggle: string) => {
    setFavoriteModels((prev) => {
      const currentFavorites = prev;
      const isFavorite = currentFavorites.includes(modelIdToToggle);
      const newFavorites = isFavorite
        ? currentFavorites.filter((item) => item !== modelIdToToggle)
        : [modelIdToToggle, ...currentFavorites];

      updateGlobalSettings({ favoriteProviders, favoriteModels: newFavorites }).catch(() => {
        setFavoriteModels(currentFavorites);
      });

      return newFavorites;
    });
  }, [favoriteProviders]);

  const getModelBadgeLabel = useCallback(
    (provider?: string, mid?: string) => {
      if (!provider || !mid) return "Using default";
      const matched = loadedModels.find((model) => model.provider === provider && model.id === mid);
      return matched ? `${matched.provider}/${matched.id}` : `${provider}/${mid}`;
    },
    [loadedModels],
  );

  const connectToMissionInterviewStream = useCallback(
    (sessionId: string) => {
      streamConnectionRef.current?.close();
      const connection = connectMissionInterviewStream(sessionId, projectId, {
        onThinking: (data) => {
          setStreamingOutput((prev) => prev + data);
          broadcastUpdate({
            sessionId,
            status: "generating",
            needsInput: false,
            type: "mission_interview",
            title: missionGoal.trim() || undefined,
            projectId: projectId ?? null,
          });
        },
        onQuestion: (question) => {
          setIsReconnecting(false);
          setIsRetrying(false);
          clearMissionGoal(projectId);
          setView({ type: "question", sessionId, question });
          setStreamingOutput("");
          setHasProgress(true);

          broadcastUpdate({
            sessionId,
            status: "awaiting_input",
            needsInput: true,
            type: "mission_interview",
            title: missionGoal.trim() || undefined,
            projectId: projectId ?? null,
          });
        },
        onSummary: (summary) => {
          setIsReconnecting(false);
          setIsRetrying(false);
          clearMissionGoal(projectId);
          setView({ type: "summary", sessionId, summary });
          setEditedSummary(summary);
          setStreamingOutput("");
          setHasProgress(true);

          broadcastUpdate({
            sessionId,
            status: "complete",
            needsInput: false,
            type: "mission_interview",
            title: missionGoal.trim() || undefined,
            projectId: projectId ?? null,
          });
        },
        onError: (message) => {
          const errorMessage = message || t("missions.interviewErrorDefault", "Session failed while contacting the AI.");

          if (currentSessionIdRef.current && currentSessionIdRef.current !== sessionId) {
            return;
          }

          const recoverySeq = streamErrorRecoverySeqRef.current + 1;
          streamErrorRecoverySeqRef.current = recoverySeq;

          /*
          FNXC:MissionInterview 2026-06-24-21:43:
          Mission interview SSE errors can be transient while the server-side AI session remains recoverable.
          Refetch persisted session state before showing the permanent Retry/Dismiss panel so issue #1745 cannot strand users on a literal Stream error.
          */
          setIsReconnecting(true);
          (async () => {
            let terminalErrorMessage = errorMessage;

            const isCurrentRecovery = () =>
              streamErrorRecoverySeqRef.current === recoverySeq &&
              (!currentSessionIdRef.current || currentSessionIdRef.current === sessionId);

            const restoreHistoryFromSession = (session: AiSessionDetail) => {
              const parsedHistory = parseConversationHistory(session.conversationHistory);
              setConversationHistory(parsedHistory);
              setResponseHistory(
                parsedHistory
                  .map((entry) => entry.response)
                  .filter((response): response is QuestionResponse =>
                    Boolean(response && typeof response === "object" && !Array.isArray(response)),
                  ),
              );
            };

            try {
              const session = await fetchAiSession(sessionId);
              if (!isCurrentRecovery()) return;

              if (session?.type === "mission_interview") {
                restoreHistoryFromSession(session);
                currentSessionIdRef.current = session.id;
                setHasProgress(true);

                if (session.status === "generating") {
                  if (session.thinkingOutput) {
                    setStreamingOutput(session.thinkingOutput);
                  }
                  connectToMissionInterviewStream(session.id);
                  return;
                }

                if (session.status === "awaiting_input") {
                  if (!session.currentQuestion) {
                    throw new Error("Interview session is awaiting input but has no current question.");
                  }
                  const question = JSON.parse(session.currentQuestion) as PlanningQuestion;
                  clearMissionGoal(projectId);
                  setView({ type: "question", sessionId: session.id, question });
                  connectToMissionInterviewStream(session.id);
                  return;
                }

                if (session.status === "complete") {
                  if (!session.result) {
                    throw new Error("Interview session is complete but has no result.");
                  }
                  const summary = JSON.parse(session.result) as MissionPlanSummary;
                  clearMissionGoal(projectId);
                  setEditedSummary(summary);
                  setView({ type: "summary", sessionId: session.id, summary });
                  setStreamingOutput("");
                  setIsReconnecting(false);
                  setIsRetrying(false);
                  broadcastUpdate({
                    sessionId: session.id,
                    status: "complete",
                    needsInput: false,
                            type: "mission_interview",
                    title: missionGoal.trim() || undefined,
                    projectId: projectId ?? null,
                  });
                  broadcastCompleted({ sessionId: session.id, status: "complete" });
                  return;
                }

                if (session.status === "error") {
                  terminalErrorMessage = session.error ?? t("missions.sessionEncounteredError", "The session encountered an error.");
                }
              }
            } catch {
              if (!isCurrentRecovery()) return;
            }

            if (!isCurrentRecovery()) return;

            setIsReconnecting(false);
            setIsRetrying(false);
            setError(null);
            setView({ type: "error", sessionId, errorMessage: terminalErrorMessage });
            setStreamingOutput("");
            setHasProgress(true);
            currentSessionIdRef.current = sessionId;

            broadcastUpdate({
              sessionId,
              status: "error",
              needsInput: false,
                type: "mission_interview",
              title: missionGoal.trim() || undefined,
              projectId: projectId ?? null,
            });
            broadcastCompleted({ sessionId, status: "error" });
          })();
        },
        onComplete: () => {
          setIsReconnecting(false);
          setIsRetrying(false);
          currentSessionIdRef.current = null;
          broadcastCompleted({ sessionId, status: "complete" });
        },
        onConnectionStateChange: (state) => {
          setIsReconnecting(state === "reconnecting");
        },
      });

      streamConnectionRef.current = connection;
    },
    [broadcastCompleted, broadcastUpdate, missionGoal, projectId],
  );

  const handleStartInterview = useCallback(
    async (goalOverride?: string) => {
      const goal = goalOverride ?? missionGoal;
      if (!goal.trim()) return;

      setError(null);
      setStreamingOutput("");
      setResponseHistory([]);
      setConversationHistory([]);
      setIsReconnecting(false);
      setView({ type: "loading" });

      try {
        const modelOverride = modelProvider && modelId ? { modelProvider, modelId, thinkingLevel: thinkingLevel || undefined } : (thinkingLevel ? { thinkingLevel } : undefined);
        const { sessionId } = await startMissionInterview(
          goal.trim(),
          projectId,
          modelOverride,
        );
        currentSessionIdRef.current = sessionId;
        clearMissionGoal(projectId);

        connectToMissionInterviewStream(sessionId);
        setResponseHistory([]);
      } catch (err) {
        setIsReconnecting(false);
        setError(getErrorMessage(err) || "Failed to start interview session");
        setView({ type: "initial" });
        currentSessionIdRef.current = null;
      }
    },
    [connectToMissionInterviewStream, missionGoal, modelProvider, modelId, thinkingLevel, projectId]
  );

  // Focus textarea when opening
  useEffect(() => {
    if (isOpen && view.type === "initial") {
      textareaRef.current?.focus();
    }
  }, [isOpen, view.type]);

  // Restore persisted goal from localStorage ONCE when the modal opens.
  // Must NOT depend on handleStartInterview or missionGoal — otherwise every
  // keystroke recreates handleStartInterview, re-triggers this effect, and
  // overwrites what the user just typed (cursor jumps to end, can't edit).
  useEffect(() => {
    if (isOpen && !initialGoalProp && !resumeSessionId && !hasAutoStartedRef.current && view.type === "initial") {
      const persisted = getMissionGoal(projectId);
      if (persisted) {
        setMissionGoal(persisted);
      }
    }
  }, [isOpen]);

  // Auto-start when initialGoal prop is provided
  useEffect(() => {
    if (isOpen && initialGoalProp && !hasAutoStartedRef.current && view.type === "initial") {
      setMissionGoal(initialGoalProp);
      const timer = setTimeout(() => {
        hasAutoStartedRef.current = true;
        handleStartInterview(initialGoalProp);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [isOpen, initialGoalProp, view.type, handleStartInterview]);

  useEffect(() => {
    if (!isOpen) {
      hasAutoStartedRef.current = false;
      setIsReconnecting(false);
      setIsRetrying(false);
    }
  }, [isOpen]);

  // Reconnect to a persisted session when resumeSessionId is provided
  useEffect(() => {
    if (!isOpen || !resumeSessionId || view.type !== "initial") return;

    let cancelled = false;

    fetchAiSession(resumeSessionId).then((session) => {
      if (cancelled || !session) return;

      const parsedHistory = parseConversationHistory(session.conversationHistory);
      setConversationHistory(parsedHistory);
      try {
        const payload = session.inputPayload ? JSON.parse(session.inputPayload) : null;
        setThinkingLevel(THINKING_LEVELS.includes(payload?.thinkingLevel as ThinkingLevel) ? payload.thinkingLevel : "");
      } catch {
        setThinkingLevel("");
      }
      setResponseHistory(
        parsedHistory
          .map((entry) => entry.response)
          .filter((response): response is QuestionResponse =>
            Boolean(response && typeof response === "object" && !Array.isArray(response)),
          ),
      );

      if (session.status === "awaiting_input" && session.currentQuestion) {
        try {
          clearMissionGoal(projectId);
          const question = JSON.parse(session.currentQuestion) as import("@fusion/core").PlanningQuestion;
          currentSessionIdRef.current = session.id;
          setHasProgress(true);
          setView({ type: "question", sessionId: session.id, question });
        } catch {
          setError("Failed to restore session question.");
        }
      } else if (session.status === "complete" && session.result) {
        try {
          clearMissionGoal(projectId);
          const summary = JSON.parse(session.result) as MissionPlanSummary;
          currentSessionIdRef.current = session.id;
          setHasProgress(true);
          setEditedSummary(summary);
          setView({ type: "summary", sessionId: session.id, summary });
        } catch {
          setError("Failed to restore session result.");
        }
      } else if (session.status === "generating") {
        currentSessionIdRef.current = session.id;
        setHasProgress(true);
        if (session.thinkingOutput) {
          setStreamingOutput(session.thinkingOutput);
        }
        setView({ type: "loading" });
        connectToMissionInterviewStream(session.id);
      } else if (session.status === "error") {
        currentSessionIdRef.current = session.id;
        setHasProgress(true);
        setError(null);
        setView({
          type: "error",
          sessionId: session.id,
          errorMessage: session.error ?? "The session encountered an error.",
        });
      }
    }).catch(() => {
      if (!cancelled) setError("Failed to resume session.");
    });

    return () => {
      cancelled = true;
    };
  }, [connectToMissionInterviewStream, isOpen, resumeSessionId, view.type, projectId]);

  // Cleanup stream on unmount
  useEffect(() => {
    return () => {
      streamConnectionRef.current?.close();
      streamConnectionRef.current = null;
    };
  }, []);

  // Unload protection
  useEffect(() => {
    if (!isOpen) return;

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (view.type === "question" || view.type === "summary") {
        e.preventDefault();
        e.returnValue = "";
      }
      streamConnectionRef.current?.close();
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isOpen, view]);

  const handleClose = useCallback(() => {
    if (missionGoal && view.type === "initial") {
      saveMissionGoal(missionGoal, projectId);
    }

    streamConnectionRef.current?.close();
    streamConnectionRef.current = null;
    setIsReconnecting(false);
    setIsRetrying(false);
    setIsCreating(false);
    onClose();
  }, [missionGoal, onClose, projectId, view.type]);

  const handleSendToBackground = useCallback(() => {
    streamConnectionRef.current?.close();
    streamConnectionRef.current = null;
    setIsReconnecting(false);
    setIsRetrying(false);
    setIsCreating(false);
    if (onSendToBackground) {
      onSendToBackground();
      return;
    }
    onClose();
  }, [onClose, onSendToBackground]);

  // Escape key handler
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, handleClose]);

  const handleSubmitResponse = useCallback(
    async (responses: QuestionResponse) => {
      if (view.type !== "question") return;

      const { sessionId } = view;
      setError(null);
      setResponseHistory((prev) => [...prev, responses]);
      setConversationHistory((prev) => [
        ...prev,
        {
          question: view.question,
          response: responses,
        },
      ]);
      setView({ type: "loading" });
      setStreamingOutput("");

      try {
        connectToMissionInterviewStream(sessionId);
        await respondToMissionInterview(sessionId, responses, projectId);
        setHasProgress(true);
      } catch (err) {
        streamConnectionRef.current?.close();
        streamConnectionRef.current = null;
        setError(getErrorMessage(err) || "Failed to submit response");
        setView({ type: "question", sessionId, question: view.question });
      }
    },
    [view, projectId, connectToMissionInterviewStream]
  );

  const handleRetryFromError = useCallback(async () => {
    if (view.type !== "error") {
      return;
    }

    const retrySessionId = view.sessionId;
    setError(null);
    setIsRetrying(true);
    setStreamingOutput("");
    setView({ type: "loading" });
    connectToMissionInterviewStream(retrySessionId);

    try {
      currentSessionIdRef.current = retrySessionId;
      await retryMissionInterviewSession(retrySessionId, projectId);
    } catch (err) {
      let retryError: unknown = err;
      const retryErrorMessage = getErrorMessage(err) || "";

      if (retryErrorMessage.includes("not in an error state")) {
        try {
          const session = await fetchAiSession(retrySessionId);
          if (!session) {
            throw new Error("Failed to refresh interview session.");
          }

          const parsedHistory = parseConversationHistory(session.conversationHistory);
          setConversationHistory(parsedHistory);
          setResponseHistory(
            parsedHistory
              .map((entry) => entry.response)
              .filter((response): response is QuestionResponse =>
                Boolean(response && typeof response === "object" && !Array.isArray(response)),
              ),
          );

          currentSessionIdRef.current = session.id;
          setHasProgress(true);

          if (session.status === "generating") {
            setStreamingOutput(session.thinkingOutput ?? "");
            setView({ type: "loading" });
            if (!streamConnectionRef.current?.isConnected()) {
              connectToMissionInterviewStream(session.id);
            }
          } else if (session.status === "awaiting_input") {
            if (!session.currentQuestion) {
              throw new Error("Interview session is awaiting input but has no current question.");
            }
            clearMissionGoal(projectId);
            const question = JSON.parse(session.currentQuestion) as PlanningQuestion;
            setView({ type: "question", sessionId: session.id, question });
            if (!streamConnectionRef.current?.isConnected()) {
              connectToMissionInterviewStream(session.id);
            }
          } else if (session.status === "complete") {
            if (!session.result) {
              throw new Error("Interview session is complete but has no result.");
            }
            clearMissionGoal(projectId);
            const summary = JSON.parse(session.result) as MissionPlanSummary;
            setEditedSummary(summary);
            setView({ type: "summary", sessionId: session.id, summary });
          } else if (session.status === "error") {
            setView({
              type: "error",
              sessionId: session.id,
              errorMessage: session.error ?? "Retry failed. Please try again.",
            });
          }

          setIsReconnecting(false);
          return;
        } catch (sessionRefreshError) {
          retryError = sessionRefreshError;
        }
      }

      streamConnectionRef.current?.close();
      streamConnectionRef.current = null;
      setView({
        type: "error",
        sessionId: retrySessionId,
        errorMessage: getErrorMessage(retryError) || "Retry failed. Please try again.",
      });
      setIsReconnecting(false);
    } finally {
      setIsRetrying(false);
    }
  }, [connectToMissionInterviewStream, projectId, view]);

  const handleApprovePlan = useCallback(async () => {
    if (view.type !== "summary") return;

    setError(null);
    setIsCreating(true);

    try {
      const mission = await createMissionFromInterview(view.sessionId, editedSummary || undefined, projectId);
      onMissionCreated(mission);
      clearMissionGoal(projectId);
      // Reset state without confirmation
      streamConnectionRef.current?.close();
      streamConnectionRef.current = null;
      setMissionGoal("");
      setView({ type: "initial" });
      setError(null);
      setResponseHistory([]);
      setConversationHistory([]);
      setEditedSummary(null);
      setStreamingOutput("");
      setIsReconnecting(false);
      setIsRetrying(false);
      setHasProgress(false);
      setIsCreating(false);
      currentSessionIdRef.current = null;
      onClose();
    } catch (err) {
      setError(getErrorMessage(err) || "Failed to create mission");
      setIsCreating(false);
    }
  }, [view, editedSummary, onMissionCreated, onClose, projectId]);

  const getProgress = () => {
    if (view.type === "question") {
      return Math.min(responseHistory.length + 1, 6);
    }
    return 6;
  };

  if (!isOpen) return null;

  return (
    <FloatingWindow
      windowKey="mission-interview"
      title={t("missions.planTitle", "Plan Mission with AI")}
      onClose={handleClose}
      hideHeader
      dragHandleSelector=".mission-interview-modal__drag-handle"
      className="floating-window--mission-interview"
      defaultSize={{ width: 760, height: 680 }}
      minSize={{ width: 560, height: 420 }}
      persistGeometryKey="floating-window:mission-interview"
    >
      {/*
        FNXC:MissionInterviewModal 2026-06-24-00:00:
        The Plan Mission with AI workspace must be draggable and resizable on desktop by delegating geometry to FloatingWindow, while mobile keeps the existing full-screen/sheet-like mission interview flow. Keep one embedded mission header so close/send-to-background controls do not duplicate FloatingWindow chrome.
      */}
      <div className="modal modal-lg planning-modal mission-interview-modal">
        <div className="modal-header mission-interview-modal__drag-handle">
          <div className="detail-title-row">
            <Target size={20} className="icon-triage" />
            <h3>{t("missions.planTitle", "Plan Mission with AI")}</h3>
          </div>
          <div className="modal-header-actions">
            {canSendToBackground && (
              <button
                className="modal-send-to-background"
                onClick={handleSendToBackground}
                title={t("missions.sendToBackground", "Send to background")}
                aria-label={t("missions.sendToBackground", "Send to background")}
              >
                <Minimize2 size={16} />
              </button>
            )}
            <button className="modal-close" onClick={handleClose} aria-label={t("actions.close", "Close")}>
              <X size={20} />
            </button>
          </div>
        </div>

        <div className="planning-modal-body">
          {error && <div className="form-error planning-error">{error}</div>}
          {isReconnecting && <div className="form-hint text-muted">{t("missions.reconnecting", "Reconnecting…")}</div>}

          {view.type === "initial" && (
            <div className="planning-initial">
              <div className="planning-view-scroll">
                <div className="planning-intro">
                  <Sparkles size={32} className="icon-triage-lg" />
                  <h4>{t("missions.transformVision", "Transform your vision into a structured mission")}</h4>
                  <p className="text-muted">
                    {t("missions.describeGoal", "Describe what you want to build. The AI will interview you to understand scope, constraints, and requirements, then produce a structured plan with milestones, slices, and features.")}
                  </p>
                </div>

                <div className="form-group">
                  <label htmlFor="mission-goal">{t("missions.whatToBuild", "What do you want to build?")}</label>
                  <textarea
                    ref={textareaRef}
                    id="mission-goal"
                    rows={4}
                    className="planning-textarea"
                    placeholder={t("missions.buildExample", "e.g., Build a real-time collaborative document editor with presence, comments, and version history...")}
                    value={missionGoal}
                    onChange={(e) => setMissionGoal(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey && missionGoal.trim()) {
                        e.preventDefault();
                        handleStartInterview();
                      }
                    }}
                  />
                </div>

                <div className="planning-examples">
                  <span className="planning-examples-label">{t("missions.tryExample", "Try an example:")}</span>
                  <div className="planning-example-chips">
                    {EXAMPLE_MISSIONS.map((mission, i) => (
                      <button
                        key={i}
                        className="planning-example-chip"
                        onClick={() => setMissionGoal(mission)}
                      >
                        {mission.length > 45 ? mission.slice(0, 45) + "..." : mission}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="planning-model-select-group">
                  <label htmlFor="mission-interview-modal-model" className="form-label">
                    {t("missions.planningModel", "Planning Model")}
                    {modelsLoading && (
                      <span className="text-muted text-muted-sm">
                        {t("missions.loadingModels", "Loading models…")}
                      </span>
                    )}
                  </label>
                  <CustomModelDropdown
                    id="mission-interview-modal-model"
                    label="Planning Model"
                    value={modelSelectionValue}
                    onChange={(value) => {
                      const { provider, modelId: selectedModelId } = parseModelSelection(value);
                      setModelProvider(provider);
                      setModelId(selectedModelId);
                    }}
                    models={loadedModels}
                    disabled={modelsLoading}
                    favoriteProviders={favoriteProviders}
                    onToggleFavorite={handleToggleFavoriteProvider}
                    favoriteModels={favoriteModels}
                    onToggleModelFavorite={handleToggleFavoriteModel}
                    showThinkingLevel
                    thinkingLevel={thinkingLevel}
                    onThinkingLevelChange={(level) => setThinkingLevel(THINKING_LEVELS.includes(level as ThinkingLevel) ? (level as ThinkingLevel) : "")}
                    defaultThinkingLevel="off"
                  />
                  {modelsError && (
                    <div className="form-hint form-hint-error">
                      {modelsError}{" "}
                      <button
                        type="button"
                        className="text-link-btn"
                        onClick={() => {
                          void (async () => {
                            try {
                              setModelsLoading(true);
                              const resp = await fetchModels();
                              setLoadedModels(resp.models);
                              setFavoriteProviders(resp.favoriteProviders);
                              setFavoriteModels(resp.favoriteModels);
                              setModelsError(null);
                            } catch (err) {
                              setModelsError(getErrorMessage(err) || t("missions.failedLoadModels", "Failed to load models"));
                            } finally {
                              setModelsLoading(false);
                            }
                          })();
                        }}
                      >
                        {t("actions.retry", "Retry")}
                      </button>
                    </div>
                  )}
                  {/* FNXC:MissionInterview 2026-07-12-00:00: The planning model selector exposes the same inline per-session thinking control as chat and sends it only because mission-interview inputPayload now persists and restores that reasoning-effort field. */}
                  <div className="model-selector-current model-selector-current--spaced">
                    <span
                      className={`model-badge ${
                        modelProvider && modelId
                          ? "model-badge-custom"
                          : "model-badge-default"
                      }`}
                    >
                      {getModelBadgeLabel(modelProvider, modelId)}
                    </span>
                  </div>
                </div>
              </div>

              <div className="planning-view-footer">
                <button
                  className="btn btn-primary planning-start-btn"
                  onClick={() => handleStartInterview()}
                  disabled={!missionGoal.trim()}
                >
                  <Target size={16} className="icon-mr-8" />
                  {t("missions.startInterview", "Start Interview")}
                </button>
              </div>
            </div>
          )}

          {view.type === "loading" && (
            <div className="planning-loading">
              <Loader2 size={40} className="spin icon-todo" />
              <p>{streamingOutput ? t("missions.aiThinking", "AI is thinking...") : t("missions.prepareQuestion", "Preparing next question...")}</p>
              <div className="planning-thinking-container">
                <button
                  className="planning-thinking-toggle"
                  onClick={() => setShowThinking(!showThinking)}
                  type="button"
                >
                  {showThinking ? t("missions.hideThinking", "Hide thinking") : t("missions.showThinking", "Show thinking")}
                </button>
                {showThinking && streamingOutput && (
                  <div className="planning-thinking-output">
                    <pre>{streamingOutput}</pre>
                  </div>
                )}
              </div>
            </div>
          )}

          {view.type === "error" && (
            <div className="planning-summary">
              <div className="planning-view-scroll planning-summary-scroll">
                {conversationHistory.length > 0 && (
                  <>
                    <ConversationHistory entries={conversationHistory} />
                    <div className="conversation-separator" />
                  </>
                )}

                <div
                  className="ai-error-panel"
                  role="alert"
                >
                  <div className="ai-error-icon">{WARNING_ICON}</div>
                  <div className="ai-error-message">{view.errorMessage}</div>
                  <div className="ai-error-actions">
                    <button className="btn btn-primary" onClick={() => void handleRetryFromError()} disabled={isRetrying}>
                      {isRetrying ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
                      <span className="icon-ml-6">{isRetrying ? t("missions.retrying", "Retrying...") : t("actions.retry", "Retry")}</span>
                    </button>
                    <button className="btn" onClick={handleClose} disabled={isRetrying}>{t("missions.dismiss", "Dismiss")}</button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {view.type === "question" && (
            <InterviewQuestionForm
              question={view.question}
              progress={getProgress()}
              historyEntries={conversationHistory}
              onSubmit={handleSubmitResponse}
            />
          )}

          {view.type === "summary" && editedSummary && (
            <MissionPlanReview
              summary={editedSummary}
              historyEntries={conversationHistory}
              onSummaryChange={setEditedSummary}
              onApprove={handleApprovePlan}
              onStartOver={() => {
                setView({ type: "initial" });
                setHasProgress(false);
                setEditedSummary(null);
                setResponseHistory([]);
                setConversationHistory([]);
                streamConnectionRef.current?.close();
                streamConnectionRef.current = null;
              }}
              isCreating={isCreating}
            />
          )}

        </div>
      </div>
    </FloatingWindow>
  );
}

// ── Question Form (reused from PlanningModeModal pattern) ────────────────

interface InterviewQuestionFormProps {
  question: PlanningQuestion;
  progress: number;
  historyEntries: ConversationHistoryEntry[];
  onSubmit: (responses: QuestionResponse) => void;
}

function InterviewQuestionForm({ question, progress, historyEntries, onSubmit }: InterviewQuestionFormProps) {
  const { t } = useTranslation("app");
  const questionOptions = question.options ?? [];
  const [response, setResponse] = useState<QuestionResponse>({});
  const [textValue, setTextValue] = useState("");
  const [commentValue, setCommentValue] = useState("");
  const [otherValue, setOtherValue] = useState("");
  const [isOtherSelected, setIsOtherSelected] = useState(false);

  const handleSubmit = useCallback(() => {
    let nextResponse: QuestionResponse;

    if (question.type === "text") {
      nextResponse = { [question.id]: textValue };
    } else if (question.type === "confirm") {
      nextResponse = { [question.id]: response[question.id] === true };
    } else if (question.type === "single_select") {
      const trimmedOther = otherValue.trim();
      /*
      FNXC:PlanningInterview 2026-06-26-00:00:
      GitHub #1794 requires mission interviews to let users decline every AI-provided single-select option and submit their own answer through the reserved `_other` key.
      */
      nextResponse = isOtherSelected && trimmedOther.length > 0
        ? { [MISSION_INTERVIEW_OTHER_RESPONSE_KEY]: trimmedOther }
        : response;
    } else if (question.type === "multi_select") {
      const trimmedOther = otherValue.trim();
      /*
      FNXC:PlanningInterview 2026-06-26-00:00:
      Mission multi-select questions must preserve chosen provided options while adding a user-authored Other answer when the user wants framing beyond the offered choices.
      */
      nextResponse = isOtherSelected && trimmedOther.length > 0
        ? { ...response, [MISSION_INTERVIEW_OTHER_RESPONSE_KEY]: trimmedOther }
        : response;
    } else {
      nextResponse = response;
    }

    const trimmedComment = commentValue.trim();
    if (trimmedComment.length > 0) {
      nextResponse = { ...nextResponse, _comment: trimmedComment };
    }

    onSubmit(nextResponse);
  }, [commentValue, isOtherSelected, otherValue, question, response, textValue, onSubmit]);

  useEffect(() => {
    setResponse({});
    setTextValue("");
    setCommentValue("");
    setOtherValue("");
    setIsOtherSelected(false);
  }, [question.id]);

  const isValid = () => {
    switch (question.type) {
      case "text":
        return textValue.trim().length > 0;
      case "single_select":
        /*
        FNXC:PlanningInterview 2026-06-26-00:00:
        Continue is valid for mission single-select questions when the user writes a non-empty Other answer, even with no provided option selected.
        */
        return response[question.id] !== undefined || (isOtherSelected && otherValue.trim().length > 0);
      case "multi_select":
        /*
        FNXC:PlanningInterview 2026-06-26-00:00:
        Continue is valid for mission multi-select questions when Other has non-whitespace text, including the Other-only case.
        */
        return (Array.isArray(response[question.id] as unknown) && (response[question.id] as unknown[]).length > 0) || (isOtherSelected && otherValue.trim().length > 0);
      case "confirm":
        return response[question.id] !== undefined;
      default:
        return true;
    }
  };

  return (
    <div className="planning-question-form">
      <div className="planning-view-scroll planning-question-scroll">
        {historyEntries.length > 0 && (
          <>
            <ConversationHistory entries={historyEntries} />
            <div className="conversation-separator" />
          </>
        )}

        <div className="planning-question-panel">
          <div className="planning-progress">
            <div className="planning-progress-bar">
              {[1, 2, 3, 4, 5, 6].map((step) => (
                <div
                  key={step}
                  className={`planning-progress-step ${step <= progress ? "active" : ""}`}
                />
              ))}
            </div>
            <span className="planning-progress-text">{t("missions.progressText", "Question {{count}} of ~6", { count: progress })}</span>
          </div>

          <div className="planning-question-content">
            <h4 className="planning-question-text">{question.question}</h4>
            {question.description && (
              <p className="planning-question-desc">{question.description}</p>
            )}

            <div className="planning-options">
              {question.type === "text" && (
                <textarea
                  className="planning-textarea"
                  rows={4}
                  placeholder={t("missions.typeAnswer", "Type your answer here...")}
                  value={textValue}
                  onChange={(e) => setTextValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && textValue.trim()) {
                      e.preventDefault();
                      handleSubmit();
                    }
                  }}
                />
              )}

              {question.type === "single_select" && (
                <div className="planning-radio-group" role="radiogroup">
                  {questionOptions.map((option) => (
                    <label key={option.id} className="planning-option planning-option--radio">
                      <input
                        type="radio"
                        name={question.id}
                        value={option.id}
                        checked={response[question.id] === option.id && !isOtherSelected}
                        onChange={() => {
                          setIsOtherSelected(false);
                          setOtherValue("");
                          setResponse({ [question.id]: option.id });
                        }}
                      />
                      <div className="planning-option-content">
                        <span className="planning-option-label">{option.label}</span>
                        {option.description && (
                          <span className="planning-option-desc">{option.description}</span>
                        )}
                      </div>
                    </label>
                  ))}
                  {/* FNXC:PlanningInterview 2026-06-26-00:00: The synthetic Other radio gives mission users an explicit way to reject all provided choices while staying in the structured interview. */}
                  <label className="planning-option planning-option--radio" data-testid="planning-option-other">
                    <input
                      type="radio"
                      name={question.id}
                      value={MISSION_INTERVIEW_OTHER_OPTION_ID}
                      checked={isOtherSelected}
                      onChange={() => {
                        setIsOtherSelected(true);
                        setResponse({});
                      }}
                    />
                    <div className="planning-option-content">
                      <span className="planning-option-label">{t("missions.otherOptionLabel", "Other (write your own)")}</span>
                    </div>
                  </label>
                  {isOtherSelected && (
                    <div className="planning-other-answer">
                      <textarea
                        className="planning-textarea"
                        data-testid="planning-other-input"
                        rows={2}
                        placeholder={t("missions.otherOptionPlaceholder", "Write your own answer...")}
                        value={otherValue}
                        onChange={(e) => setOtherValue(e.target.value)}
                      />
                    </div>
                  )}
                </div>
              )}

              {question.type === "multi_select" && (
                <div className="planning-checkbox-group">
                  {questionOptions.map((option) => {
                    const selected = (response[question.id] as string[]) || [];
                    return (
                      <label key={option.id} className="planning-option planning-option--checkbox">
                        <input
                          type="checkbox"
                          value={option.id}
                          checked={selected.includes(option.id)}
                          onChange={(e) => {
                            const newSelected = e.target.checked
                              ? [...selected, option.id]
                              : selected.filter((id) => id !== option.id);
                            setResponse({ [question.id]: newSelected });
                          }}
                        />
                        <div className="planning-option-content">
                          <span className="planning-option-label">{option.label}</span>
                          {option.description && (
                            <span className="planning-option-desc">{option.description}</span>
                          )}
                        </div>
                      </label>
                    );
                  })}
                  {/* FNXC:PlanningInterview 2026-06-26-00:00: The synthetic Other checkbox is additive for mission multi-select questions so user-authored answers can stand alone or augment provided options. */}
                  <label className="planning-option planning-option--checkbox" data-testid="planning-option-other">
                    <input
                      type="checkbox"
                      value={MISSION_INTERVIEW_OTHER_OPTION_ID}
                      checked={isOtherSelected}
                      onChange={(e) => {
                        setIsOtherSelected(e.target.checked);
                        if (!e.target.checked) {
                          setOtherValue("");
                        }
                      }}
                    />
                    <div className="planning-option-content">
                      <span className="planning-option-label">{t("missions.otherOptionLabel", "Other (write your own)")}</span>
                    </div>
                  </label>
                  {isOtherSelected && (
                    <div className="planning-other-answer">
                      <textarea
                        className="planning-textarea"
                        data-testid="planning-other-input"
                        rows={2}
                        placeholder={t("missions.otherOptionPlaceholder", "Write your own answer...")}
                        value={otherValue}
                        onChange={(e) => setOtherValue(e.target.value)}
                      />
                    </div>
                  )}
                </div>
              )}

              {question.type === "confirm" && (
                <div className="planning-confirm-group">
                  <button
                    className={`planning-confirm-btn ${response[question.id] === true ? "selected" : ""}`}
                    onClick={() => setResponse({ [question.id]: true })}
                  >
                    <CheckCircle size={18} />
                    {t("actions.yes", "Yes")}
                  </button>
                  <button
                    className={`planning-confirm-btn ${response[question.id] === false ? "selected" : ""}`}
                    onClick={() => setResponse({ [question.id]: false })}
                  >
                    <X size={18} />
                    {t("actions.no", "No")}
                  </button>
                </div>
              )}
            </div>

            {question.type !== "text" && (
              <div className="planning-comment-section">
                <label className="planning-comment-label" htmlFor={`planning-comment-${question.id}`}>
                  {t("missions.additionalComments", "Additional comments (optional)")}
                </label>
                <textarea
                  id={`planning-comment-${question.id}`}
                  className="planning-textarea"
                  rows={2}
                  placeholder={t("missions.addContext", "Add any extra context or direction...")}
                  value={commentValue}
                  onChange={(e) => setCommentValue(e.target.value)}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="planning-actions">
        <button
          className="btn btn-primary planning-actions-primary"
          onClick={handleSubmit}
          disabled={!isValid()}
        >
          {t("actions.continue", "Continue")}
          <ArrowRight size={16} className="icon-ml-4" />
        </button>
      </div>
    </div>
  );
}

// ── Mission Plan Review (hierarchical summary view) ──────────────────────

interface MissionPlanReviewProps {
  summary: MissionPlanSummary;
  historyEntries: ConversationHistoryEntry[];
  onSummaryChange: (summary: MissionPlanSummary) => void;
  onApprove: () => void;
  onStartOver: () => void;
  isCreating: boolean;
}

function MissionPlanReview({
  summary,
  historyEntries,
  onSummaryChange,
  onApprove,
  onStartOver,
  isCreating,
}: MissionPlanReviewProps) {
  const { t } = useTranslation("app");
  const [expandedMilestones, setExpandedMilestones] = useState<Set<number>>(
    () => new Set(summary.milestones.map((_, i) => i))
  );
  const [expandedSlices, setExpandedSlices] = useState<Set<string>>(
    () => {
      const set = new Set<string>();
      summary.milestones.forEach((ms, mi) => {
        ms.slices.forEach((_, si) => set.add(`${mi}-${si}`));
      });
      return set;
    }
  );

  const toggleMilestone = (index: number) => {
    setExpandedMilestones((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const toggleSlice = (key: string) => {
    setExpandedSlices((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const updateMilestone = (index: number, updates: Partial<MissionPlanMilestone>) => {
    const milestones = [...summary.milestones];
    milestones[index] = { ...milestones[index], ...updates };
    onSummaryChange({ ...summary, milestones });
  };

  const updateSlice = (mi: number, si: number, updates: Partial<MissionPlanSlice>) => {
    const milestones = [...summary.milestones];
    const slices = [...milestones[mi].slices];
    slices[si] = { ...slices[si], ...updates };
    milestones[mi] = { ...milestones[mi], slices };
    onSummaryChange({ ...summary, milestones });
  };

  const updateFeature = (mi: number, si: number, fi: number, updates: Partial<MissionPlanFeature>) => {
    const milestones = [...summary.milestones];
    const slices = [...milestones[mi].slices];
    const features = [...slices[si].features];
    features[fi] = { ...features[fi], ...updates };
    slices[si] = { ...slices[si], features };
    milestones[mi] = { ...milestones[mi], slices };
    onSummaryChange({ ...summary, milestones });
  };

  const removeMilestone = (index: number) => {
    const milestones = summary.milestones.filter((_, i) => i !== index);
    onSummaryChange({ ...summary, milestones });
  };

  const removeSlice = (mi: number, si: number) => {
    const milestones = [...summary.milestones];
    milestones[mi] = {
      ...milestones[mi],
      slices: milestones[mi].slices.filter((_, i) => i !== si),
    };
    onSummaryChange({ ...summary, milestones });
  };

  const removeFeature = (mi: number, si: number, fi: number) => {
    const milestones = [...summary.milestones];
    const slices = [...milestones[mi].slices];
    slices[si] = {
      ...slices[si],
      features: slices[si].features.filter((_, i) => i !== fi),
    };
    milestones[mi] = { ...milestones[mi], slices };
    onSummaryChange({ ...summary, milestones });
  };

  const addFeature = (mi: number, si: number) => {
    const milestones = [...summary.milestones];
    const slices = [...milestones[mi].slices];
    slices[si] = {
      ...slices[si],
      features: [...slices[si].features, { title: "New feature", description: "" }],
    };
    milestones[mi] = { ...milestones[mi], slices };
    onSummaryChange({ ...summary, milestones });
  };

  const totalFeatures = summary.milestones.reduce(
    (acc, ms) => acc + ms.slices.reduce((a, sl) => a + sl.features.length, 0),
    0
  );

  return (
    <div className="planning-summary">
      <div className="planning-view-scroll planning-summary-scroll">
        {historyEntries.length > 0 && (
          <>
            <ConversationHistory entries={historyEntries} />
            <div className="conversation-separator" />
          </>
        )}

        <div className="planning-summary-header">
          <CheckCircle size={24} className="icon-success" />
          <h4>{t("missions.planReady", "Mission Plan Ready")}</h4>
          <p className="text-muted">
            {t("missions.summaryStats", "{{milestones}} milestones, {{features}} features. Review and edit before approving.", { milestones: summary.milestones.length, features: totalFeatures })}
          </p>
        </div>

        <div className="planning-summary-form">
          {/* Mission title & description */}
          <div className="form-group">
            <label>{t("missions.titleLabel", "Mission Title")}</label>
            <input
              type="text"
              className="form-input"
              value={summary.missionTitle || ""}
              onChange={(e) => onSummaryChange({ ...summary, missionTitle: e.target.value })}
            />
          </div>
          <div className="form-group">
            <label>{t("missions.descriptionLabel", "Mission Description")}</label>
            <textarea
              className="planning-textarea"
              rows={3}
              value={summary.missionDescription || ""}
              onChange={(e) => onSummaryChange({ ...summary, missionDescription: e.target.value })}
            />
          </div>

          {/* Milestones hierarchy */}
          <div className="form-group">
            <label>{t("missions.roadmapLabel", "Roadmap")}</label>
            <div className="roadmap-list">
              {summary.milestones.map((milestone, mi) => (
                <div
                  key={mi}
                  className="roadmap-card"
                >
                  {/* Milestone header */}
                  <div
                    className="roadmap-card-header"
                    onClick={() => toggleMilestone(mi)}
                  >
                    {expandedMilestones.has(mi) ? (
                      <ChevronDown size={16} className="icon-text-secondary" />
                    ) : (
                      <ChevronRight size={16} className="icon-text-secondary" />
                    )}
                    <Layers size={16} className="icon-milestone" />
                    <input
                      type="text"
                      className="form-input roadmap-input-title"
                      value={milestone.title}
                      onChange={(e) => updateMilestone(mi, { title: e.target.value })}
                      onClick={(e) => e.stopPropagation()}
                    />
                    {summary.milestones.length > 1 && (
                      <button
                        className="btn-icon roadmap-shrink"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeMilestone(mi);
                        }}
                        title={t("missions.removeMilestone", "Remove milestone")}
                      >
                        <Trash2 size={14} className="icon-text-secondary" />
                      </button>
                    )}
                  </div>

                  {expandedMilestones.has(mi) && (
                    <div className="roadmap-card-body">
                      <textarea
                        className="planning-textarea roadmap-textarea-md"
                        rows={2}
                        placeholder={t("missions.milestoneDescriptionPlaceholder", "Milestone description...")}
                        value={milestone.description || ""}
                        onChange={(e) => updateMilestone(mi, { description: e.target.value })}
                      />
                      <div className="roadmap-field-group">
                        <label className="roadmap-field-label">
                          {t("missions.verificationCriteria", "Verification Criteria")}
                        </label>
                        <textarea
                          className="planning-textarea roadmap-textarea-sm"
                          rows={2}
                          placeholder={t("missions.confirmMilestonePlaceholder", "How to confirm this milestone is complete...")}
                          value={milestone.verification || ""}
                          onChange={(e) => updateMilestone(mi, { verification: e.target.value })}
                        />
                      </div>

                      {/* Slices */}
                      {milestone.slices.map((slice, si) => {
                        const sliceKey = `${mi}-${si}`;
                        return (
                          <div
                            key={si}
                            className="roadmap-slice-card"
                          >
                            <div
                              className="roadmap-slice-header"
                              onClick={() => toggleSlice(sliceKey)}
                            >
                              {expandedSlices.has(sliceKey) ? (
                                <ChevronDown size={14} className="icon-text-secondary" />
                              ) : (
                                <ChevronRight size={14} className="icon-text-secondary" />
                              )}
                              <Package size={14} className="icon-slice" />
                              <input
                                type="text"
                                className="form-input roadmap-input-subtitle"
                                value={slice.title}
                                onChange={(e) => updateSlice(mi, si, { title: e.target.value })}
                                onClick={(e) => e.stopPropagation()}
                              />
                              {milestone.slices.length > 1 && (
                                <button
                                  className="btn-icon roadmap-shrink"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    removeSlice(mi, si);
                                  }}
                                  title={t("missions.removeSlice", "Remove slice")}
                                >
                                  <Trash2 size={12} className="icon-text-secondary" />
                                </button>
                              )}
                            </div>

                            {expandedSlices.has(sliceKey) && (
                              <div className="roadmap-slice-body">
                                {/* Slice verification */}
                                <div className="roadmap-slice-field-group">
                                  <label className="roadmap-field-label">
                                    {t("missions.sliceVerification", "Slice Verification")}
                                  </label>
                                  <textarea
                                    className="planning-textarea roadmap-textarea-xs"
                                    rows={1}
                                    placeholder={t("missions.confirmSlicePlaceholder", "How to confirm this slice is done...")}
                                    value={slice.verification || ""}
                                    onChange={(e) => updateSlice(mi, si, { verification: e.target.value })}
                                  />
                                </div>
                                {/* Features */}
                                {slice.features.map((feature, fi) => (
                                  <div
                                    key={fi}
                                    className="roadmap-feature-row"
                                  >
                                    <Box size={12} className="icon-feature" />
                                    <div className="roadmap-feature-content">
                                      <input
                                        type="text"
                                        className="form-input roadmap-input-feature"
                                        value={feature.title}
                                        onChange={(e) =>
                                          updateFeature(mi, si, fi, { title: e.target.value })
                                        }
                                      />
                                      {feature.description && (
                                        <p className="roadmap-feature-text">
                                          {feature.description}
                                        </p>
                                      )}
                                      {feature.acceptanceCriteria && (
                                        <p className="roadmap-feature-text--italic">
                                          {t("missions.acceptanceCriteriaPrefix", "AC:")} {feature.acceptanceCriteria}
                                        </p>
                                      )}
                                    </div>
                                    <button
                                      className="btn-icon roadmap-shrink"
                                      onClick={() => removeFeature(mi, si, fi)}
                                      title={t("missions.removeFeature", "Remove feature")}
                                    >
                                      <Trash2 size={12} className="icon-text-secondary" />
                                    </button>
                                  </div>
                                ))}

                                <button
                                  className="btn roadmap-add-feature-btn"
                                  onClick={() => addFeature(mi, si)}
                                >
                                  <Plus size={12} />
                                  {t("missions.addFeature", "Add Feature")}
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="planning-actions planning-summary-actions">
        <button className="btn" onClick={onStartOver} disabled={isCreating}>
          <ArrowLeft size={16} className="icon-mr-4" />
          {t("missions.startOver", "Start Over")}
        </button>
        <button
          className="btn btn-primary"
          onClick={onApprove}
          disabled={isCreating || summary.milestones.length === 0}
        >
          {isCreating ? (
            <>
              <Loader2 size={16} className="spin icon-mr-8" />
              {t("missions.creatingMission", "Creating Mission...")}
            </>
          ) : (
            <>
              <CheckCircle size={16} className="icon-mr-8" />
              {t("missions.approvePlan", "Approve Plan")}
            </>
          )}
        </button>
      </div>
    </div>
  );
}
