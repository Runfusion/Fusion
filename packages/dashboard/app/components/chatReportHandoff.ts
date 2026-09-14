import { useCallback, useRef, useState } from "react";

export interface ChatReportHandoff {
  body: string;
  title: string;
}

export const CHAT_REPORT_MAX_BODY = 2000;

/**
 * FNXC:StructuralMail 2026-08-09-09:09:
 * Report-mode mail rejects a blank title, so chat derives the required title before routing rather
 * than opening a composer that cannot send. The bounded body matches the composer limit.
 */
export interface ChatMailReportRouting {
  mailComposerPrefill: (ChatReportHandoff & { nonce: number }) | null;
  onSendAsReport: (handoff: ChatReportHandoff) => void;
}

/**
 * FNXC:StructuralMail 2026-09-14-11:35:
 * App owns report navigation and closes only the canonical primary Chat host after handoff. Detached conversations remain open; this reusable seam keeps production and routing tests aligned.
 */
export function useChatMailReportRouting(
  navigateToMailbox: () => void,
  closePrimaryChatHost: () => void,
): ChatMailReportRouting {
  const [mailComposerPrefill, setMailComposerPrefill] = useState<(ChatReportHandoff & { nonce: number }) | null>(null);
  const nonceRef = useRef(0);
  const onSendAsReport = useCallback((handoff: ChatReportHandoff) => {
    const nonce = Math.max(Date.now(), nonceRef.current + 1);
    nonceRef.current = nonce;
    setMailComposerPrefill({ ...handoff, nonce });
    navigateToMailbox();
    closePrimaryChatHost();
  }, [closePrimaryChatHost, navigateToMailbox]);
  return { mailComposerPrefill, onSendAsReport };
}

export function buildChatReportHandoff(rawBody: string, fallbackTitle: string): { handoff: ChatReportHandoff | null; truncated: boolean } {
  const trimmed = rawBody.trim();
  if (!trimmed) return { handoff: null, truncated: false };
  const truncated = rawBody.length > CHAT_REPORT_MAX_BODY;
  const body = rawBody.slice(0, CHAT_REPORT_MAX_BODY);
  let inFence = false;
  let proseCandidate: string | undefined;
  let headingCandidate: string | undefined;
  for (const line of trimmed.split("\n")) {
    const value = line.trim();
    if (value.startsWith("```") || value.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !value) continue;
    const heading = value.match(/^#{1,6}\s+(.+)$/)?.[1]?.trim();
    if (heading) {
      headingCandidate = heading;
      break;
    }
    if (!proseCandidate && /[\p{L}\p{N}]/u.test(value)) proseCandidate = value;
  }
  const title = (headingCandidate?.slice(0, 80) || proseCandidate?.slice(0, 80) || fallbackTitle.trim() || "Chat report").trim();
  return { handoff: { body, title }, truncated };
}
