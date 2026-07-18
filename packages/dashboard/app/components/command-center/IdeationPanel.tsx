import { FormEvent, useEffect, useState } from "react";
import { Lightbulb } from "lucide-react";
import type { IdeationCandidate, IdeationSessionWithCandidates } from "@fusion/core";
import { withProjectId } from "../../api/legacy";
import "./IdeationPanel.css";

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
  const [sessions, setSessions] = useState<IdeationSessionWithCandidates[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [title, setTitle] = useState("");
  const [candidate, setCandidate] = useState("");
  const [error, setError] = useState<string>();
  const selected = sessions.find((session) => session.id === selectedId);
  const refresh = async () => {
    const listed = await ideationRequest<Array<IdeationSessionWithCandidates>>("/", projectId);
    const hydrated = await Promise.all(listed.map((session) => ideationRequest<IdeationSessionWithCandidates>(`/${encodeURIComponent(session.id)}`, projectId)));
    setSessions(hydrated);
    setSelectedId((current) => current && hydrated.some((session) => session.id === current) ? current : hydrated[0]?.id);
  };
  useEffect(() => { void refresh().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))); }, [projectId]);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(undefined);
    try { const created = await ideationRequest<IdeationSessionWithCandidates>("/", projectId, { method: "POST", body: JSON.stringify({ title }) }); setTitle(""); await refresh(); setSelectedId(created.id); }
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
  return <section className="ideation-panel" aria-label="Persisted ideation">
    <header className="ideation-panel__header"><Lightbulb /><div><h2>Ideation</h2><p>Capture alternatives, then converge one into the Mission hierarchy.</p></div></header>
    <form className="ideation-panel__form" onSubmit={submit}><input className="input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Session title" aria-label="Session title" required /><button className="btn" type="submit">Start session</button></form>
    {error && <p className="ideation-panel__error" role="alert">{error}</p>}
    <div className="ideation-panel__body"><aside className="ideation-panel__sessions">{sessions.length ? sessions.map((session) => <button className={`card ideation-panel__session ${session.id === selected?.id ? "is-selected" : ""}`} type="button" onClick={() => setSelectedId(session.id)} key={session.id}>{session.title}<span>{session.status}</span></button>) : <p>No sessions yet.</p>}</aside>
    <div className="ideation-panel__detail">{selected ? <><h3>{selected.title}</h3>{selected.targetMissionId && <p className="ideation-panel__handoff">Converged to Mission <strong>{selected.targetMissionId}</strong></p>}{selected.status === "open" && <form className="ideation-panel__form" onSubmit={addCandidate}><input className="input" value={candidate} onChange={(event) => setCandidate(event.target.value)} placeholder="Divergent candidate" aria-label="Divergent candidate" required /><button className="btn" type="submit">Add candidate</button></form>}<ul className="ideation-panel__candidates">{selected.candidates.map((item) => <li className="card" key={item.id}><p>{item.content}</p><small>{item.origin}{item.sourceRef ? ` · ${item.sourceRef}` : ""}</small>{selected.status === "open" && <button className="btn" type="button" onClick={() => void converge(item)}>Converge</button>}</li>)}</ul></> : <p>Select or start a session.</p>}</div></div>
  </section>;
}
