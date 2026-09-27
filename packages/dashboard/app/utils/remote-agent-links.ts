/*
FNXC:RemoteAgents 2026-09-26-23:39:
The operator asked for deep links into collected sessions and turns. A link is the app's existing URL deep-link
shape plus two parameters: `?project=<id>&view=agents&remoteSession=<id>[&turn=<nativeTurnId>]`. `project` and
`view` are already honored app-wide (useDeepLink switches project, useViewState opens the Agents view); the
Remote agents panel consumes the other two once, then removes them so a reload does not re-open the session.

Unrelated query parameters (for example remote-shell connection parameters) are preserved, because dropping
them would open the link against a different server.
*/
export const REMOTE_SESSION_PARAM = "remoteSession";
export const REMOTE_TURN_PARAM = "turn";
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,256}$/;

export interface RemoteAgentLink { projectId: string | null; sessionId: string; turnId: string | null }

export function remoteAgentLink(projectId: string, sessionId: string, turnId?: string): string {
  const url = new URL(window.location.href);
  url.hash = "";
  if (/^\/tasks\//.test(url.pathname)) url.pathname = "/";
  for (const key of ["task", "pr", REMOTE_TURN_PARAM]) url.searchParams.delete(key);
  url.searchParams.set("project", projectId);
  url.searchParams.set("view", "agents");
  url.searchParams.set(REMOTE_SESSION_PARAM, sessionId);
  if (turnId) url.searchParams.set(REMOTE_TURN_PARAM, turnId);
  return url.toString();
}

/** The pending link in the current URL, or null. Malformed ids are ignored rather than requested. */
export function readRemoteAgentLink(): RemoteAgentLink | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get(REMOTE_SESSION_PARAM);
  if (!sessionId || !SAFE_ID.test(sessionId)) return null;
  const turnId = params.get(REMOTE_TURN_PARAM);
  return { projectId: params.get("project"), sessionId, turnId: turnId && SAFE_ID.test(turnId) ? turnId : null };
}

export function clearRemoteAgentLink(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(REMOTE_SESSION_PARAM) && !url.searchParams.has(REMOTE_TURN_PARAM)) return;
  url.searchParams.delete(REMOTE_SESSION_PARAM);
  url.searchParams.delete(REMOTE_TURN_PARAM);
  window.history.replaceState(window.history.state ?? {}, "", `${url.pathname}${url.search}${url.hash}`);
}
