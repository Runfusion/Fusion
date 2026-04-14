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
          <span style={{ fontWeight: 600, fontSize: 15 }}>
            <span style={{ marginRight: 8 }}>✨</span>
            Generate Agent
          </span>
          <button
            className="btn-icon"
            onClick={handleCancel}
            aria-label="Close"
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--text-muted)",
              fontSize: 18,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="agent-dialog-body">
          {error && (
            <div
              style={{
                color: "var(--state-error-text, #f85149)",
                fontSize: 13,
                padding: "8px 12px",
                background: "var(--state-error-bg, rgba(248,81,73,0.1))",
                borderRadius: 6,
                marginBottom: 12,
              }}
            >
              {error}
            </div>
          )}

          {view.type === "input" && (
            <div>
              <p
                style={{
                  color: "var(--text-muted)",
                  fontSize: 13,
                  marginTop: 0,
                  marginBottom: 12,
                }}
              >
                Describe your agent&apos;s role and the AI will generate a complete
                specification including system prompt, suggested configuration, and
                more.
              </p>
              <div className="agent-dialog-field">
                <label htmlFor="agent-role-description">Role Description</label>
                <textarea
                  ref={textareaRef}
                  id="agent-role-description"
                  className="input"
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
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    resize: "vertical",
                  }}
                  aria-describedby="role-description-hint"
                />
                <div
                  id="role-description-hint"
                  style={{
                    fontSize: 11,
                    color: "var(--text-muted)",
                    marginTop: 4,
                    display: "flex",
                    justifyContent: "space-between",
                  }}
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
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                padding: "32px 16px",
                gap: 12,
              }}
            >
              <div
                className="spin"
                style={{
                  width: 32,
                  height: 32,
                  border: "3px solid var(--border)",
                  borderTopColor: "var(--text-accent, #58a6ff)",
                  borderRadius: "50%",
                  animation: "spin 1s linear infinite",
                }}
              />
              <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>
                Generating agent specification...
              </p>
            </div>
          )}

          {view.type === "preview" && (
            <div>
              <div className="agent-dialog-summary" style={{ marginBottom: 12 }}>
                <div className="agent-dialog-summary-row">
                  <span
                    style={{ color: "var(--text-muted)", fontSize: 13, width: 90 }}
                  >
                    Title
                  </span>
                  <span style={{ fontWeight: 600 }}>
                    {view.spec.icon} {view.spec.title}
                  </span>
                </div>
                <div className="agent-dialog-summary-row">
                  <span
                    style={{ color: "var(--text-muted)", fontSize: 13, width: 90 }}
                  >
                    Role
                  </span>
                  <span>{view.spec.role}</span>
                </div>
                <div className="agent-dialog-summary-row">
                  <span
                    style={{ color: "var(--text-muted)", fontSize: 13, width: 90 }}
                  >
                    Description
                  </span>
                  <span style={{ fontSize: 13 }}>{view.spec.description}</span>
                </div>
                <div className="agent-dialog-summary-row">
                  <span
                    style={{ color: "var(--text-muted)", fontSize: 13, width: 90 }}
                  >
                    Thinking
                  </span>
                  <span style={{ textTransform: "capitalize" }}>
                    {view.spec.thinkingLevel}
                  </span>
                </div>
                <div className="agent-dialog-summary-row">
                  <span
                    style={{ color: "var(--text-muted)", fontSize: 13, width: 90 }}
                  >
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
                    style={{
                      background: "none",
                      border: "none",
                      color: "var(--text-accent, #58a6ff)",
                      cursor: "pointer",
                      fontSize: 12,
                      marginLeft: 8,
                      padding: 0,
                    }}
                    onClick={() => setSystemPromptExpanded(!systemPromptExpanded)}
                  >
                    {systemPromptExpanded ? "Collapse" : "Expand"}
                  </button>
                </label>
                <div
                  style={{
                    background: "var(--bg-secondary, #161b22)",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    padding: 12,
                    fontSize: 12,
                    fontFamily: "monospace",
                    maxHeight: systemPromptExpanded ? "none" : 150,
                    overflow: systemPromptExpanded ? "auto" : "hidden",
                    position: "relative",
                    lineHeight: 1.5,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {view.spec.systemPrompt}
                  {!systemPromptExpanded &&
                    view.spec.systemPrompt.length > 500 && (
                      <div
                        style={{
                          position: "absolute",
                          bottom: 0,
                          left: 0,
                          right: 0,
                          height: 40,
                          background:
                            "linear-gradient(transparent, var(--bg-secondary, #161b22))",
                          pointerEvents: "none",
                        }}
                      />
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
              className="btn btn--primary"
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
              <button className="btn btn--primary" onClick={handleUseSpec}>
                Use This
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
