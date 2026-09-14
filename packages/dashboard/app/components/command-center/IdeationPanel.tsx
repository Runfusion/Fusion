import { FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Lightbulb } from "lucide-react";
import type { IdeationCandidate, IdeationSessionWithCandidates } from "@fusion/core";
import { withProjectId } from "../../api/legacy";
import "./IdeationPanel.css";
import { useViewportMode } from "../../hooks/useViewportMode";
import { ViewActionButton } from "../ViewActionButton";
import { ViewHeader } from "../ViewHeader";
import { ViewLayout, type ViewLayoutMobilePane } from "../ViewLayout";
import { ViewSidebar } from "../ViewSidebar";

async function ideationRequest<T>(path: string, projectId: string | undefined, init?: RequestInit): Promise<T> {
  const response = await fetch(withProjectId(`/api/ideation${path}`, projectId), {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) throw new Error(await response.text() || "Ideation request failed");
  return response.json() as Promise<T>;
}

/*
FNXC:Ideation 2026-07-30-15:30:
Command Center gives humans the same bounded session → candidates → canonical
Mission convergence operation agents use. The visible Mission ID is persisted
handoff evidence, not a copied document or a separate dashboard-only roadmap.
*/
export function IdeationPanel({ projectId }: { projectId?: string }) {
  const { t } = useTranslation("app");
  const viewportMode = useViewportMode();
  const [sessions, setSessions] = useState<IdeationSessionWithCandidates[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [title, setTitle] = useState("");
  const [candidate, setCandidate] = useState("");
  const [error, setError] = useState<string>();
  const [mobilePane, setMobilePane] = useState<ViewLayoutMobilePane>("list");
  const selected = sessions.find((session) => session.id === selectedId);
  const refresh = async () => {
    const listed = await ideationRequest<Array<IdeationSessionWithCandidates>>("/", projectId);
    const hydrated = await Promise.all(listed.map((session) => ideationRequest<IdeationSessionWithCandidates>(`/${encodeURIComponent(session.id)}`, projectId)));
    setSessions(hydrated);
    setSelectedId((current) => current && hydrated.some((session) => session.id === current) ? current : hydrated[0]?.id);
  };
  useEffect(() => {
    setMobilePane("list");
    void refresh().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [projectId]);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(undefined);
    try { const created = await ideationRequest<IdeationSessionWithCandidates>("/", projectId, { method: "POST", body: JSON.stringify({ title }) }); setTitle(""); await refresh(); setSelectedId(created.id); setMobilePane("detail"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const addCandidate = async (event: FormEvent) => {
    event.preventDefault(); if (!selected || !candidate.trim()) return; setError(undefined);
    try { await ideationRequest(`/${encodeURIComponent(selected.id)}/candidates`, projectId, { method: "POST", body: JSON.stringify({ content: candidate, origin: "human" }) }); setCandidate(""); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const converge = async (item: IdeationCandidate) => {
    if (!selected) return; setError(undefined);
    try { await ideationRequest(`/${encodeURIComponent(selected.id)}/converge`, projectId, { method: "POST", body: JSON.stringify({ candidateId: item.id }) }); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  /*
  FNXC:StandardizedViewLayout 2026-09-13-21:43:
  Ideation exposes its persisted sessions through the common rail and opens list-first on phones. Starting a session remains the same form submission, now owned by the header action, and selection alone never converges a candidate.
  */
  return (
    <ViewLayout
      className="ideation-panel"
      aria-label={t("ideation.persisted", "Persisted ideation")}
      mobilePane={mobilePane}
      header={(
        <ViewHeader
          icon={Lightbulb}
          title={viewportMode === "mobile" && mobilePane === "detail" && selected
            ? selected.title
            : t("ideation.title", "Ideation")}
          backAction={viewportMode === "mobile" && mobilePane === "detail" ? {
            label: t("ideation.backToSessions", "Back to ideation sessions"),
            onClick: () => setMobilePane("list"),
          } : undefined}
          actions={(
            <ViewActionButton
              kind="create"
              type="submit"
              form="ideation-new-session-form"
              label={t("ideation.start", "Start session")}
              disabled={!title.trim()}
            />
          )}
        />
      )}
      sidebar={(
        <ViewSidebar
          ariaLabel={t("ideation.sessions", "Ideation sessions")}
          resizeLabel={t("ideation.resizeSessions", "Resize ideation sessions")}
          hostIdentity="command-center-ideation"
          mobile={viewportMode === "mobile"}
          panelClassName="ideation-panel__sessions"
        >
          <p className="ideation-panel__description">
            {t("ideation.description", "Capture alternatives, then converge one into the Mission hierarchy.")}
          </p>
          <form id="ideation-new-session-form" className="ideation-panel__form" onSubmit={submit}>
            <input
              className="input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t("ideation.sessionTitle", "Session title")}
              aria-label={t("ideation.sessionTitle", "Session title")}
              required
            />
          </form>
          {sessions.length ? sessions.map((session) => (
            <button
              className={`card ideation-panel__session ${session.id === selected?.id ? "is-selected" : ""}`}
              type="button"
              onClick={() => {
                setSelectedId(session.id);
                setMobilePane("detail");
              }}
              key={session.id}
            >
              {session.title}<span>{session.status}</span>
            </button>
          )) : <p>{t("ideation.noSessions", "No sessions yet.")}</p>}
        </ViewSidebar>
      )}
    >
      <div className="ideation-panel__detail">
        {error && <p className="ideation-panel__error" role="alert">{error}</p>}
        {selected ? (
          <>
            <h3>{selected.title}</h3>
            {selected.targetMissionId && (
              <p className="ideation-panel__handoff">
                {t("ideation.convergedToMission", "Converged to Mission")} <strong>{selected.targetMissionId}</strong>
              </p>
            )}
            {selected.status === "open" && (
              <form className="ideation-panel__form" onSubmit={addCandidate}>
                <input
                  className="input"
                  value={candidate}
                  onChange={(event) => setCandidate(event.target.value)}
                  placeholder={t("ideation.divergentCandidate", "Divergent candidate")}
                  aria-label={t("ideation.divergentCandidate", "Divergent candidate")}
                  required
                />
                <button className="btn" type="submit">{t("ideation.addCandidate", "Add candidate")}</button>
              </form>
            )}
            <ul className="ideation-panel__candidates">
              {selected.candidates.map((item) => (
                <li className="card" key={item.id}>
                  <p>{item.content}</p>
                  <small>{item.origin}{item.sourceRef ? ` · ${item.sourceRef}` : ""}</small>
                  {selected.status === "open" && (
                    <button className="btn" type="button" onClick={() => void converge(item)}>
                      {t("ideation.converge", "Converge")}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </>
        ) : <p>{t("ideation.selectOrStart", "Select or start a session.")}</p>}
      </div>
    </ViewLayout>
  );
}
