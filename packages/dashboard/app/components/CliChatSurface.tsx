// CliChatSurface — the CLI-backed chat rendering surface (CLI Agent Executor, U12).
//
// ChatView delegates to this component when the active chat session selects a
// cli-agent executor. It encapsulates the three KTD behaviors that distinguish
// a CLI-backed chat from a provider chat:
//
//  1. Hybrid (native/hybrid tier): render the durable transcript as today PLUS a
//     transcript ↔ terminal toggle. Raw-terminal mode swaps the message list for
//     <SessionTerminal> and HIDES the composer (the terminal owns input);
//     toggling back restores the transcript and composer.
//  2. Generic tier: terminal-ONLY. No toggle, no transcript pane — the affordance
//     is absent, not empty (screen-output parsing for a structured transcript is
//     out of scope for generic CLIs).
//  3. Composer queued state: while the underlying CLI session is busy, sends are
//     queued with a visible indicator. The flush decision is owned server-side
//     (CliChatSessionRunner, which re-fetches authoritative state — the
//     stale-isGenerating learning); this component only surfaces the queued count.
//
// Rendering of the transcript message list itself stays with ChatView's existing
// renderer (passed in as `renderTranscript`) so there is no parallel message UI.
import React, { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Terminal as TerminalIcon, MessageSquare } from "lucide-react";
import { SessionTerminal, type SessionTerminalProps } from "./SessionTerminal";

/** Adapter capability tier — drives whether a transcript view exists at all. */
export type CliChatTier = "native" | "hybrid" | "generic";

export interface CliChatSurfaceProps {
  /** Live CLI session id to attach the terminal to. */
  cliSessionId: string;
  /** Adapter tier. Generic → terminal-only (no toggle, no transcript). */
  tier: CliChatTier;
  projectId?: string;
  /** Renders the existing ChatView transcript message list. */
  renderTranscript: () => ReactNode;
  /** Renders the existing ChatView composer (hidden in raw-terminal mode). */
  renderComposer: () => ReactNode;
  /** Renders ChatView's transcript-only find row; raw terminal stays terminal-owned. */
  renderSearch?: () => ReactNode;
  /** Number of composer messages queued behind a busy session (0 = none). */
  queuedCount?: number;
  /** Extra props forwarded to SessionTerminal (posture, settings link, etc.). */
  terminalProps?: Partial<Omit<SessionTerminalProps, "sessionId" | "projectId">>;
}

type SurfaceView = "transcript" | "terminal";

export function CliChatSurface({
  cliSessionId,
  tier,
  projectId,
  renderTranscript,
  renderComposer,
  renderSearch,
  queuedCount = 0,
  terminalProps,
}: CliChatSurfaceProps) {
  const { t } = useTranslation("app");
  const isGeneric = tier === "generic";
  // Generic tier is terminal-only; hybrid/native default to the transcript view.
  const [view, setView] = useState<SurfaceView>(isGeneric ? "terminal" : "transcript");

  // Generic tier: render the terminal directly, no toggle, no composer, no
  // transcript pane. The terminal owns all input.
  if (isGeneric) {
    return (
      <div className="cli-chat-surface cli-chat-surface--generic" data-tier="generic">
        <SessionTerminal sessionId={cliSessionId} projectId={projectId} {...terminalProps} />
      </div>
    );
  }

  const showTerminal = view === "terminal";

  return (
    <div className="cli-chat-surface" data-tier={tier} data-view={view}>
      <div className="cli-chat-surface__toolbar" role="tablist" aria-label={t("cliChat.viewToggleLabel", "Chat view")}>
        <button
          type="button"
          role="tab"
          aria-selected={!showTerminal}
          className={`cli-chat-surface__tab${!showTerminal ? " is-active" : ""}`}
          onClick={() => setView("transcript")}
        >
          <MessageSquare size={14} aria-hidden="true" />
          <span>{t("cliChat.transcriptTab", "Transcript")}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={showTerminal}
          className={`cli-chat-surface__tab${showTerminal ? " is-active" : ""}`}
          onClick={() => setView("terminal")}
        >
          <TerminalIcon size={14} aria-hidden="true" />
          <span>{t("cliChat.terminalTab", "Terminal")}</span>
        </button>
      </div>

      <div className="cli-chat-surface__body">
        {showTerminal ? (
          // Raw-terminal mode: the message list is swapped out and the terminal
          // owns input. Composer is hidden below.
          <SessionTerminal sessionId={cliSessionId} projectId={projectId} {...terminalProps} />
        ) : (
          <>{renderSearch?.()}{renderTranscript()}</>
        )}
      </div>

      {/* Composer is hidden in raw-terminal mode — the terminal owns input. */}
      {!showTerminal && (
        <div className="cli-chat-surface__composer">
          {queuedCount > 0 && (
            <div className="cli-chat-surface__queued" role="status" aria-live="polite">
              {t("cliChat.queued", "{{count}} message queued — will send when the agent is ready", {
                count: queuedCount,
              })}
            </div>
          )}
          {renderComposer()}
        </div>
      )}
    </div>
  );
}

export default CliChatSurface;
