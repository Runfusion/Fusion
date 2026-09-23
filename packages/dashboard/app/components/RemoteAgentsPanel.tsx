import { useCallback, useEffect, useRef, useState } from "react";
import type { ExternalSessionPage, ExternalSessionView } from "@fusion/core";
import type { RemoteUsage } from "../../src/remote-agents/types";
import { api } from "../api/client/client";
import { withProjectId } from "../api/client/health";
import { useVisibilityAwarePoll } from "../hooks/visibilitySuspension";
import "./RemoteAgentsPanel.css";

type Feedback = { commandId: string; status: string; createdAt: string; expiresAt: string; deliveredAt: string | null };
type Cost = { usage: RemoteUsage[]; estimatedUsd: number | null; partialUsd: number | null; usageComplete: boolean; pricingDate: string; pricingSource: string };
const number = (n: number) => n.toLocaleString();
const usd = (n: number | null) => n === null ? "Unavailable" : new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 6 }).format(n);
const tokenPrice = (perMillion: number) => `$${(perMillion / 1_000_000).toFixed(9)}`;

function feedbackCommandId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") cryptoApi.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function RemoteAgentDetail({ session, projectId }: { session: ExternalSessionView; projectId: string }) {
  const [detail, setDetail] = useState(session);
  const [cost, setCost] = useState<Cost | null>(null);
  const [feedback, setFeedback] = useState<Feedback[]>([]);
  const [text, setText] = useState("");
  const [commandId, setCommandId] = useState(feedbackCommandId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = `/external-sessions/${session.id}`;
  const refresh = useCallback(async (signal: AbortSignal) => {
    try {
      const [d, c, f] = await Promise.all([
        api<{ session: ExternalSessionView }>(withProjectId(path, projectId), { signal }),
        api<Cost>(withProjectId(`${path}/cost`, projectId), { signal }),
        api<{ feedback: Feedback[] }>(withProjectId(`${path}/feedback`, projectId), { signal }),
      ]);
      if (!signal.aborted) { setDetail(d.session); setCost(c); setFeedback(f.feedback); setError(null); }
    } catch (e) { if (!signal.aborted) setError(e instanceof Error ? e.message : "Session unavailable"); }
  }, [path, projectId]);
  const detailPoll = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController(); detailPoll.current = controller; void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);
  // FNXC:RemoteAgents 2026-09-22-15:57: The open session is what the operator is watching, so it polls at 5s as a critical subscriber of the shared visibility gate: no request while the tab is hidden, one immediate refresh on return.
  useVisibilityAwarePoll(() => { const signal = detailPoll.current?.signal; if (signal && !signal.aborted) void refresh(signal); }, 5000, { priority: "critical" });
  const supported = detail.collectorConnected && !["completed", "failed"].includes(detail.observation.activity) && !!detail.observation.feedback && Date.parse(detail.observation.feedback.expiresAt) > Date.now();
  /*
  FNXC:RemoteAgents 2026-09-22-16:56:
  PR #3637 review: only a `queued` receipt blocks the composer. After a lost POST response, polling can surface this command's receipt, which later turns terminal (`delivered`, `expired`, or `uncertain`).
  A terminal receipt rotates the command ID so the operator is never locked out, and a retry never reuses a spent ID. Text is cleared only on `delivered`; after `expired` or `uncertain` it stays so the operator can resend.
  */
  const sameCommand = feedback.find(f => f.commandId === commandId);
  const pendingSame = sameCommand?.status === "queued" ? sameCommand : undefined;
  const terminalSame = sameCommand && sameCommand.status !== "queued" ? sameCommand.status : null;
  useEffect(() => {
    if (!terminalSame) return;
    if (terminalSame === "delivered") setText("");
    setCommandId(feedbackCommandId());
  }, [terminalSame]);
  const send = async () => {
    if (busy || !supported || !text.trim() || pendingSame) return;
    setBusy(true); setError(null);
    try {
      const result = await api<Feedback>(withProjectId(`${path}/feedback`, projectId), { method: "POST", body: JSON.stringify({ commandId, generation: detail.observation.feedback!.generation, text }) });
      setFeedback(current => [result, ...current.filter(f => f.commandId !== result.commandId)]);
      if (result.status === "queued" || result.status === "delivered") { setText(""); setCommandId(feedbackCommandId()); }
    } catch (e) { setError(e instanceof Error ? e.message : "Feedback failed"); }
    finally { setBusy(false); }
  };
  return <section className="remote-agent-detail card" aria-label="Remote agent details">
    <h3>{detail.observation.title || detail.nativeSessionId}</h3>
    <p className="remote-agent-meta">{detail.hostId} · {detail.provider} · {detail.observation.model ?? "Model unknown"}</p>
    <p className="remote-agent-path">{detail.observation.projectPath}</p>
    <p>{detail.observation.activity} · {detail.collectorConnected ? "Collector connected" : "Collector offline"}{detail.activityStale ? " · Activity stale" : ""}</p>
    <p>Last activity: {new Date(detail.observation.observedAt).toLocaleString()}</p>
    <h4>Recent activity</h4>
    {detail.observation.recentActivity?.length ? detail.observation.recentActivity.map((a, i) => <article key={`${a.at}:${a.kind}:${i}`} className="remote-agent-activity"><strong>{a.kind}</strong> <time>{new Date(a.at).toLocaleTimeString()}</time><pre>{a.text}</pre></article>) : <p className="remote-agent-meta">No recent native activity reported.</p>}
    <h4>Session token costs</h4>
    {!cost ? <p>Loading costs…</p> : <>
      <p>Estimated total: <strong>{usd(cost.estimatedUsd)}</strong>{cost.estimatedUsd === null && cost.partialUsd !== null ? ` · Priced subtotal: ${usd(cost.partialUsd)}` : ""}</p>
      {!cost.usageComplete && <p className="remote-agent-meta">Usage is incomplete. Unreported tokens are unknown.</p>}
      {!cost.usage.length && <p className="remote-agent-meta">Token usage has not been reported.</p>}
      {cost.usage.map((u, i) => <section key={`${u.model}:${i}`} className="remote-agent-usage">
        <strong>{u.model} · {usd(u.usd)}</strong>
        <dl><dt>Fresh input</dt><dd>{number(u.input)}</dd><dt>Cached input</dt><dd>{number(u.cached)}</dd><dt>Cache writes (5 min / 1 hour)</dt><dd>{number(u.cacheWrite)} / {number(u.cacheWriteHour)}</dd><dt>Output</dt><dd>{number(u.output)}</dd><dt>Reasoning (included in output)</dt><dd>{u.reasoning === null ? "Not reported" : number(u.reasoning)}</dd></dl>
        {u.rates ? <><p className="remote-agent-meta">Base price per token: input {tokenPrice(u.rates.inputPer1M)}, cached {tokenPrice(u.rates.cacheReadPer1M)}, cache write {tokenPrice(u.rates.cacheWritePer1M)}, output {tokenPrice(u.rates.outputPer1M)}.</p><p className="remote-agent-meta">USD per million tokens: input {usd(u.rates.inputPer1M)}, cached {usd(u.rates.cacheReadPer1M)}, cache write {usd(u.rates.cacheWritePer1M)}, output {usd(u.rates.outputPer1M)}. Source: {u.rates.source}.</p></> : <p>Model rate unavailable.</p>}
        {u.rates?.cacheWriteHourPer1M != null && <p className="remote-agent-meta">One-hour cache writes: {tokenPrice(u.rates.cacheWriteHourPer1M)} per token ({usd(u.rates.cacheWriteHourPer1M)} per million). Source: {u.rates.cacheWriteHourSource}.</p>}
        {u.reason && <p>{u.reason}</p>}
      </section>)}
      <p className="remote-agent-meta">Fusion pricing baseline: {cost.pricingDate} · {cost.pricingSource}. Estimates are based on reported tokens and rates, rather than a provider bill.</p>
    </>}
    <h4>Feedback to this agent</h4>
    <p className="remote-agent-meta">Queued feedback expires after five minutes and enters the agent’s next native hook. Delivered means context was emitted by that hook.</p>
    {!supported && <p>Feedback unavailable: this agent is offline, ended, or its Fusion hook is not connected.</p>}
    <form onSubmit={e => { e.preventDefault(); void send(); }}>
      <label htmlFor={`remote-feedback-${session.id}`}>Message</label>
      <textarea id={`remote-feedback-${session.id}`} value={text} onChange={e => setText(e.target.value)} maxLength={8000} disabled={!supported || busy || !!pendingSame} rows={4} />
      <button className="btn btn-sm" type="submit" disabled={!supported || busy || !text.trim() || !!pendingSame}>{busy ? "Sending…" : "Send feedback"}</button>
    </form>
    {error && <p role="alert">{error}</p>}
    <ul className="remote-agent-receipts">{feedback.map(f => <li key={f.commandId}>{f.status} · {new Date(f.deliveredAt ?? f.createdAt).toLocaleString()} <small>{f.commandId}</small></li>)}</ul>
  </section>;
}

// FNXC:RemoteAgents 2026-09-18-05:22: Extend the existing Agents destination. Polling updates preserve the mounted composer and the idempotent command ID.
export function RemoteAgentsPanel({ projectId }: { projectId?: string }) {
  const [sessions, setSessions] = useState<ExternalSessionView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [host, setHost] = useState(""); const [provider, setProvider] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null); const [loading, setLoading] = useState(false);
  const [hosts, setHosts] = useState<{ hostId: string; collectorConnected: boolean }[]>([]);
  const load = useCallback(async (after?: string, signal?: AbortSignal, merge = false) => {
    if (!projectId) return;
    setLoading(true);
    const query = new URLSearchParams({ projectId, limit: "100" });
    if (host) query.set("hostId", host); if (provider) query.set("provider", provider); if (after) query.set("cursor", after);
    try {
      const page = await api<ExternalSessionPage>(`/external-sessions?${query}`, { signal });
      if (!signal?.aborted) {
        setSessions(current => after || merge ? [...current.filter(s => !page.sessions.some(n => n.id === s.id)), ...page.sessions] : page.sessions);
        if (!merge) setCursor(page.nextCursor); setError(null);
      }
    } catch (e) { if (!signal?.aborted) setError(e instanceof Error ? e.message : "Remote agents unavailable"); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, [host, provider, projectId]);
  const refreshHosts = useCallback(async (signal: AbortSignal) => {
    if (!projectId) return;
    try { const data = await api<{ hosts: { hostId: string; collectorConnected: boolean }[] }>(withProjectId("/external-sessions/hosts", projectId), { signal }); if (!signal.aborted) setHosts(data.hosts); }
    catch { /* Session errors use the main monitoring error state. */ }
  }, [projectId]);
  const listPoll = useRef<AbortController | null>(null);
  useEffect(() => {
    setSessions([]); setSelected(null); setCursor(null);
    const controller = new AbortController(); listPoll.current = controller; void load(undefined, controller.signal);
    return () => controller.abort();
  }, [load]);
  const hostsPoll = useRef<AbortController | null>(null);
  useEffect(() => {
    setHosts([]);
    const controller = new AbortController(); hostsPoll.current = controller; void refreshHosts(controller.signal);
    return () => controller.abort();
  }, [refreshHosts]);
  /*
  FNXC:RemoteAgents 2026-09-22-15:57:
  PR #3637 review: the list and host status used two independent 10s intervals that kept running in hidden tabs.
  They now share one tick through the dashboard's single visibility gate (`useVisibilityAwarePoll`), so a hidden tab issues no requests and a returning tab refreshes once.
  Polling stays because external sessions have no push channel; the list tick merges pages so loaded cursors survive.
  */
  useVisibilityAwarePoll(() => {
    const list = listPoll.current?.signal; if (list && !list.aborted) void load(undefined, list, true);
    const hostSignal = hostsPoll.current?.signal; if (hostSignal && !hostSignal.aborted) void refreshHosts(hostSignal);
  }, 10000, { enabled: !!projectId });
  const detail = sessions.find(s => s.id === selected);
  return <div className="remote-agents-panel">
    <div className="remote-agent-filters">
      <label>Server<input value={host} onChange={e => setHost(e.target.value.trim())} placeholder="All servers" /></label>
      <label>Provider<select value={provider} onChange={e => setProvider(e.target.value)}><option value="">All providers</option><option value="codex">Codex</option><option value="claude">Claude</option></select></label>
      <button className="btn btn-sm" onClick={() => void load()} disabled={loading}>Refresh</button>
    </div>
    <p className="remote-agent-meta">{hosts.map(h => `${h.hostId}: ${h.collectorConnected ? "collector connected" : "collector offline"}`).join(" · ")}</p>
    {!projectId && <p>Select a Fusion project to view its remote agents.</p>}
    {error && <p role="alert">{error}</p>}
    {projectId && !sessions.length && !error && <p>{loading ? "Loading remote agents…" : "No remote sessions reported for this project."}</p>}
    <div className="remote-agent-layout"><div className="remote-agent-list">
      {[...sessions].sort((a, b) => b.observation.observedAt.localeCompare(a.observation.observedAt)).map(s => <button key={s.id} className="card remote-agent-row" onClick={() => setSelected(s.id)} aria-pressed={selected === s.id}>
        <strong>{s.observation.title || s.nativeSessionId}</strong><span>{s.hostId} · {s.provider} · {s.observation.model ?? "Model unknown"}</span><span>{s.observation.activity} · {s.collectorConnected ? "Connected" : "Collector offline"}{s.activityStale ? " · Activity stale" : ""}</span>
      </button>)}
      {cursor && <button className="btn btn-sm" onClick={() => void load(cursor)} disabled={loading}>Load more sessions</button>}
    </div>{detail && projectId && <RemoteAgentDetail key={`${projectId}:${detail.id}`} session={detail} projectId={projectId} />}</div>
  </div>;
}
