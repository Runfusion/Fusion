import { useState } from "react";
import { remoteAgentLink } from "../utils/remote-agent-links";

// FNXC:RemoteAgents 2026-09-26-23:39: copies a deep link to a session or turn; the outcome is announced, and a blocked clipboard says so instead of failing silently.
export function RemoteAgentCopyLink({ projectId, sessionId, turnId, label }: { projectId: string; sessionId: string; turnId?: string; label: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(remoteAgentLink(projectId, sessionId, turnId));
      setStatus("copied");
    } catch { setStatus("failed"); }
  };
  return <span className="remote-copy-link">
    <button type="button" className="btn btn-sm" onClick={() => void copy()}>{label}</button>
    <span role="status" className="remote-agent-meta">{status === "copied" ? "Link copied" : status === "failed" ? "Copy failed; the clipboard is unavailable" : ""}</span>
  </span>;
}
