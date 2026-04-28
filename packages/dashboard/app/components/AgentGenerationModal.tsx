import { useState, useCallback, useEffect, useRef } from "react";
import type { AgentGenerationSpec } from "../api";
import {
  startAgentGeneration,
  generateAgentSpec,
  cancelAgentGeneration,
} from "../api";

interface AgentGenerationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onGenerated: (spec: AgentGenerationSpec) => void;
  projectId?: string;
}

type ViewState =
  | { type: "input" }
  | { type: "loading" }
  | { type: "preview"; spec: AgentGenerationSpec; sessionId: string };

const MIN_ROLE_LENGTH = 3;
const MAX_ROLE_LENGTH = 1000;

/**
 * Modal for AI-assisted agent creation.
 *
 * The user enters a role description and the system generates a complete
 * agent specification including title, icon, system prompt, and suggested
 * runtime configuration.
 *
 * Follows the same general modal pattern as PlanningModeModal but simplified
 * (no multi-step Q&A — single input → single generation result).
 */
export function AgentGenerationModal({
  isOpen,
  onClose,
  onGenerated,
  projectId,
}: AgentGenerationModalProps) {
  const [roleDescription, setRoleDescription] = useState("");
  const [view, setView] = useState<ViewState>({ type: "input" });
  const [error, setError] = useState<string | null>(null);
  const [systemPromptExpanded, setSystemPromptExpanded] = useState(false);
  const sessionIdRef = useRef<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus textarea on open
  useEffect(() => {
    if (isOpen && view.type === "input") {
      textareaRef.current?.focus();
    }
  }, [isOpen, view.type]);

  // Cleanup session on unmount or modal close
  useEffect(() => {
    if (!isOpen && sessionIdRef.current) {
      const sid = sessionIdRef.current;
      sessionIdRef.current = null;
      cancelAgentGeneration(sid, projectId).catch(() => {
        /* ignore cleanup errors */
      });
    }
  }, [isOpen, projectId]);

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleCancel();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  const handleCancel = useCallback(() => {
    // Cleanup session server-side
    if (sessionIdRef.current) {
      const sid = sessionIdRef.current;
      sessionIdRef.current = null;
      cancelAgentGeneration(sid, projectId).catch(() => {
        /* ignore cleanup errors */
      });
    }
    setRoleDescription("");
    setView({ type: "input" });
    setError(null);
    setSystemPromptExpanded(false);
    onClose();
  }, [onClose, projectId]);

  const handleGenerate = useCallback(async () => {
    if (!roleDescription.trim() || roleDescription.trim().length < MIN_ROLE_LENGTH) return;

    setError(null);
    setView({ type: "loading" });

    try {
      // Phase 1: Start session
      const { sessionId } = await startAgentGeneration(roleDescription.trim(), projectId);
      sessionIdRef.current = sessionId;

      // Phase 2: Generate spec (single combined loading state)
      const { spec } = await generateAgentSpec(sessionId, projectId);

      setView({ type: "preview", spec, sessionId });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to generate agent specification";
      // Handle rate limit errors with user-friendly message
      if (message.includes("429") || message.toLowerCase().includes("rate limit")) {
        setError("Too many requests. Please wait a moment and try again.");
      } else {
        setError(message);
      }
      setView({ type: "input" });
      sessionIdRef.current = null;
    }
  }, [roleDescription, projectId]);

  const handleRegenerate = useCallback(async () => {
    // Cancel existing session and create a new one
    if (sessionIdRef.current) {
      const oldSid = sessionIdRef.current;
      sessionIdRef.current = null;
      try {
        await cancelAgentGeneration(oldSid, projectId);
      } catch {
        /* ignore */
      }
    }
    // Re-run generation with same role description
    await handleGenerate();
  }, [handleGenerate, projectId]);

  const handleUseSpec = useCallback(() => {
    if (view.type !== "preview") return;
    // Clear session ref so we don't cancel on close (we're using the spec)
    sessionIdRef.current = null;
    onGenerated(view.spec);
    // Reset and close
    setRoleDescription("");
    setView({ type: "input" });
    setError(null);
    setSystemPromptExpanded(false);
    onClose();
  }, [view, onGenerated, onClose]);

  if (!isOpen) return null;

  const canGenerate =
    roleDescription.trim().length >= MIN_ROLE_LENGTH &&
    roleDescription.trim().length <= MAX_ROLE_LENGTH;

  return (
    <div
      className="agent-dialog-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) handleCancel();
      }}
    >
      <div
        className="agent-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Generate agent with AI"
      >
        {/* Header */}
        <div className="agent-dialog-header">
          <span className="agent-dialog-header-title">
            <span className="agent-dialog-header-sparkle">✨</span>
            Generate Agent
          </span>
          <button
            className="modal-close"
            onClick={handleCancel}
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        {/* Body */}
        <div className="agent-dialog-body">
          {error && <div className="agent-dialog-error-banner">{error}</div>}

          {view.type === "input" && (
            <div>
              <p className="agent-dialog-info">
                Describe your agent&apos;s role and the AI will generate a complete
                specification including system prompt, suggested configuration, and
                more.
              </p>
              <div className="agent-dialog-field">
                <label htmlFor="agent-role-description">Role Description</label>
                <textarea
                  ref={textareaRef}
                  id="agent-role-description"
                  className="input agent-dialog-textarea"
                  rows={4}
                  placeholder='e.g. "Senior frontend code reviewer who specializes in React accessibility"'
                  value={roleDescription}
                  onChange={(e) => setRoleDescription(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && canGenerate) {
                      e.preventDefault();
                      handleGenerate();
                    }
                  }}
                  maxLength={MAX_ROLE_LENGTH}
                  aria-describedby="role-description-hint"
                />
                <div
                  id="role-description-hint"
                  className="agent-dialog-hint"
                >
                  <span>Describe what your agent should do</span>
                  <span>
                    {roleDescription.length}/{MAX_ROLE_LENGTH}
                  </span>
                </div>
              </div>
            </div>
          )}

          {view.type === "loading" && (
            <div className="agent-dialog-loading-center">
              <div className="agent-dialog-spinner spin" />
              <p className="agent-dialog-loading-text">
                Generating agent specification...
              </p>
            </div>
          )}

          {view.type === "preview" && (
            <div>
              <div className="agent-dialog-summary agent-dialog-summary--spaced">
                <div className="agent-dialog-summary-row">
                  <span className="agent-dialog-summary-row-label agent-dialog-summary-row-label--fixed">
                    Title
                  </span>
                  <span className="agent-dialog-summary-row-value">
                    {view.spec.icon} {view.spec.title}
                  </span>
                </div>
                <div className="agent-dialog-summary-row">
                  <span className="agent-dialog-summary-row-label agent-dialog-summary-row-label--fixed">
                    Role
                  </span>
                  <span>{view.spec.role}</span>
                </div>
                <div className="agent-dialog-summary-row">
                  <span className="agent-dialog-summary-row-label agent-dialog-summary-row-label--fixed">
                    Description
                  </span>
                  <span className="agent-dialog-summary-row-value agent-dialog-summary-row-value--body">{view.spec.description}</span>
                </div>
                <div className="agent-dialog-summary-row">
                  <span className="agent-dialog-summary-row-label agent-dialog-summary-row-label--fixed">
                    Thinking
                  </span>
                  <span className="agent-dialog-summary-row-value agent-dialog-summary-row-value--capitalize">
                    {view.spec.thinkingLevel}
                  </span>
                </div>
                <div className="agent-dialog-summary-row">
                  <span className="agent-dialog-summary-row-label agent-dialog-summary-row-label--fixed">
                    Max Turns
                  </span>
                  <span>{view.spec.maxTurns}</span>
                </div>
              </div>

              {/* System prompt preview */}
              <div className="agent-dialog-field">
                <label>
                  System Prompt
                  <button
                    type="button"
                    className="agent-dialog-expand-btn"
                    onClick={() => setSystemPromptExpanded(!systemPromptExpanded)}
                  >
                    {systemPromptExpanded ? "Collapse" : "Expand"}
                  </button>
                </label>
                <div
                  className={`agent-generation-prompt-box${systemPromptExpanded ? "" : " agent-generation-prompt-box--collapsed"}`}
                >
                  {view.spec.systemPrompt}
                  {!systemPromptExpanded &&
                    view.spec.systemPrompt.length > 500 && (
                      <div className="agent-generation-prompt-fade" />
                    )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="agent-dialog-footer">
          <button className="btn" onClick={handleCancel}>
            Cancel
          </button>
          {view.type === "input" && (
            <button
              className="btn btn-task-create"
              onClick={() => void handleGenerate()}
              disabled={!canGenerate}
            >
              Generate
            </button>
          )}
          {view.type === "preview" && (
            <>
              <button
                className="btn"
                onClick={() => void handleRegenerate()}
              >
                Regenerate
              </button>
              <button className="btn btn-task-create" onClick={handleUseSpec}>
                Use This
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
