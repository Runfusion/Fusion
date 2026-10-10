import { useEffect, useState } from "react";
import type { ExternalSessionView } from "@fusion/core";
import { api } from "../api/client/client";
import { withProjectId } from "../api/client/health";
import { RemoteAgentTurns } from "./RemoteAgentTurns";
import { remoteAgentLink } from "../utils/remote-agent-links";
import "./RemoteAgentsPanel.css";

/*
FNXC:RemoteAgents 2026-09-26-23:39:
The operator asked for a task's collected turns inside its own task detail. This reuses RemoteAgentTurns, the
same presentation the Remote agents panel uses, rather than keeping a second copy of the result UI.

Membership is proof-based (`/external-sessions/by-task/:taskId`, backed by F4 attribution): only sessions whose
native id deterministically names this task appear. The empty state says "none proven" rather than "none",
because a run whose native id was never reported, or is claimed twice, is left out on purpose.
*/
export function RemoteAgentTaskSessions({ taskId, projectId }: { taskId: string; projectId: string }) {
  const [sessions, setSessions] = useState<ExternalSessionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setSessions(null); setError(null);
    api<{ sessions: ExternalSessionView[] }>(withProjectId(`/external-sessions/by-task/${encodeURIComponent(taskId)}`, projectId), { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setSessions(Array.isArray(data?.sessions) ? data.sessions : []); })
      .catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Collected sessions unavailable"); });
    return () => controller.abort();
  }, [projectId, taskId]);

  return <section className="remote-task-sessions" aria-labelledby={`remote-task-sessions-${taskId}`}>
    <h4 id={`remote-task-sessions-${taskId}`}>Collected agent sessions</h4>
    {error ? <p role="alert">{error}</p>
      : sessions === null ? <p className="remote-agent-meta">Loading collected sessions…</p>
      : !sessions.length ? <p className="remote-agent-meta">No collected session is proven to be a run of this task.</p>
      : <>
        <p className="remote-agent-meta">These runs are already counted in this task's token and cost figures above; their turn costs are not additional.</p>
        {sessions.map(session => <article key={session.id} className="remote-task-session card">
          <h5>{session.observation.title || session.nativeSessionId}</h5>
          <p className="remote-agent-meta">{session.hostId} · {session.provider} · {session.observation.model ?? "Model unknown"} · {session.observation.activity}</p>
          {/* FNXC:RemoteAgents 2026-09-27-00:20: the dashboard's link-as-action primitive; a bare anchor rendered browser-default blue at about 2:1 contrast on the dark card. */}
          <a className="btn btn-sm" href={remoteAgentLink(projectId, session.id)}>Open in Remote agents</a>
          <RemoteAgentTurns sessionId={session.id} projectId={projectId} />
        </article>)}
      </>}
  </section>;
}
