import { useCallback, useEffect, useRef, useState } from "react";
import type { NativeStructureEmbed } from "@fusion/core";
import { FN_AGENT_ID, useChat } from "../hooks/useChat";
import "./ComposeChatPanel.css";

interface ComposeChatPanelProps {
  projectId?: string;
  embeds: NativeStructureEmbed[];
  draftBody: string;
  onUseDraft: (draft: string) => void;
  onClose: () => void;
}

/**
 * FNXC:NativeStructureEmbed 2026-07-22-10:30:
 * This compact helper deliberately reuses useChat and a FN_AGENT_ID scratch session rather than
 * creating another streaming engine. Its session title prefix makes the disposable compose context
 * auditable, and closing archives only that session. Applying output replaces empty text directly;
 * typed text is replaced only after the composer confirms, while embeds remain untouched.
 */
export function ComposeChatPanel({ projectId, embeds, draftBody, onUseDraft, onClose }: ComposeChatPanelProps) {
  const chat = useChat(projectId);
  const [request, setRequest] = useState("Draft a clear report or approval message around the attached structure.");
  const [isCreating, setIsCreating] = useState(false);
  const [hasPendingPrompt, setHasPendingPrompt] = useState(false);
  const [activeScratchSessionId, setActiveScratchSessionId] = useState<string | null>(null);
  const scratchSessionId = useRef<string | null>(null);
  const priorSession = useRef<typeof chat.activeSession>(null);
  const pendingPrompt = useRef<string | null>(null);
  const creatingSession = useRef(false);
  const closed = useRef(false);
  const archivedSessionId = useRef<string | null>(null);
  const restoredSessionId = useRef<string | null>(null);

  const archiveScratchSession = useCallback((id = scratchSessionId.current) => {
    if (!id || archivedSessionId.current === id) return;
    archivedSessionId.current = id;
    void chat.archiveSession(id)
      .catch(() => undefined)
      .finally(() => {
        const previous = priorSession.current;
        if (!previous || restoredSessionId.current === previous.id) return;
        restoredSessionId.current = previous.id;
        chat.selectSession(previous.id, previous);
      });
  }, [chat.archiveSession, chat.selectSession]);

  useEffect(() => () => {
    closed.current = true;
    archiveScratchSession();
  }, [archiveScratchSession]);

  useEffect(() => {
    const prompt = pendingPrompt.current;
    if (!prompt || chat.activeSession?.id !== scratchSessionId.current) return;

    // FNXC:NativeStructureEmbed 2026-07-22-11:00:
    // createSession selects state asynchronously. Queue the first prompt until the scratch session
    // is active so useChat's closure cannot drop it against the previous/no active session.
    pendingPrompt.current = null;
    setHasPendingPrompt(false);
    chat.sendMessage(prompt);
  }, [activeScratchSessionId, chat.activeSession?.id, chat.sendMessage, hasPendingPrompt]);

  const send = useCallback(async () => {
    const context = embeds.length
      ? embeds.map((embed) => `- ${embed.kind}: ${embed.label ?? embed.id} (${embed.id})`).join("\n")
      : "- No structures attached yet.";
    pendingPrompt.current = `${request}\n\nAttached native structures (keep these as first-class embeds, do not describe them as missing):\n${context}\n\nCurrent draft body:\n${draftBody || "(empty)"}`;
    setHasPendingPrompt(true);

    if (scratchSessionId.current || creatingSession.current) return;
    // FNXC:NativeStructureEmbed 2026-07-22-12:00:
    // useChat selects the scratch session globally. Keep the user's prior selection so scratch
    // cleanup restores it after archiving rather than leaving ChatView on an archived session.
    priorSession.current = chat.activeSession;
    creatingSession.current = true;
    setIsCreating(true);
    try {
      const session = await chat.createSession({ agentId: FN_AGENT_ID, title: "compose-mail-scratch" });
      if (closed.current) {
        archiveScratchSession(session.id);
        return;
      }
      scratchSessionId.current = session.id;
      // Force the queued-send effect after createSession has selected its stateful active session.
      setActiveScratchSessionId(session.id);
    } catch {
      pendingPrompt.current = null;
      setHasPendingPrompt(false);
    } finally {
      creatingSession.current = false;
      if (!closed.current) setIsCreating(false);
    }
  }, [archiveScratchSession, chat.activeSession, chat.createSession, draftBody, embeds, request]);

  const close = useCallback(() => {
    closed.current = true;
    archiveScratchSession();
    onClose();
  }, [archiveScratchSession, onClose]);

  const latestDraft = chat.streamingText || [...chat.messages].reverse().find((message) => message.role === "assistant")?.content || "";

  return (
    <section id="compose-chat-panel" className="compose-chat-panel" aria-label="Compose chat narrative helper" data-testid="compose-chat-panel">
      <label className="message-composer-label" htmlFor="compose-chat-request">Draft narrative</label>
      <textarea id="compose-chat-request" className="input compose-chat-panel__input" value={request} onChange={(event) => setRequest(event.target.value)} />
      <div className="compose-chat-panel__output" aria-live="polite">{latestDraft || "Ask the assistant to draft the narrative around your attached structures."}</div>
      <div className="compose-chat-panel__actions">
        <button className="btn btn-sm btn-primary" type="button" onClick={() => void send()} disabled={chat.isStreaming || isCreating || hasPendingPrompt || !request.trim()}>Draft</button>
        <button className="btn btn-sm btn-secondary" type="button" onClick={() => latestDraft && onUseDraft(latestDraft)} disabled={!latestDraft}>Use draft</button>
        <button className="btn btn-sm btn-secondary" type="button" onClick={close}>Close</button>
      </div>
    </section>
  );
}
