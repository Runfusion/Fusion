import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client/client";
import { withProjectId } from "../api/client/health";

type Entry = {
  sessionId: string; hostId: string; provider: string; title: string | null; at: string | null;
  usd: number; nativeTurnId?: string; ordinal?: number; recordedRates: boolean; recalculated: boolean;
  dominant: string | null; dominantUsd: number; requests: number;
};
type Coverage = { scanned: number; priced: number; unpriced: number; withoutUsage: number; truncated: boolean; pricedTotalUsd: number };
type RankingPage = { schemaVersion: 1; scope: "turns" | "sessions"; entries: Entry[]; coverage: Coverage };

const money = (n: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 6 }).format(n);

/*
FNXC:ExternalSessionRankings 2026-09-24-00:04:
Most expensive work, with the coverage that makes it readable. Coverage is rendered unconditionally: a ranking
without it silently answers "the most expensive work we had rates for", which is a different and flattering
question. Truncation, unpriced rows and rows with no usage at all each get their own sentence, because
collapsing them into one number hides which limitation applies.
*/

/*
FNXC:ExternalSessionDrivers 2026-09-24-01:44: The explanation is measured: the largest charge category, its
amount and the priced request volume. Never a narrative cause like "long conversation".
*/
const CATEGORY_LABEL: Record<string, string> = {
  freshInput: "fresh input", cachedInput: "cached input", cacheWrite: "cache writes",
  cacheWriteHour: "1-hour cache writes", output: "output",
};

function driverText(entry: Entry): string {
  const requests = `${entry.requests} priced ${entry.requests === 1 ? "request" : "requests"}`;
  if (!entry.dominant) return `Cost drivers unavailable · ${requests}`;
  return `Mostly ${CATEGORY_LABEL[entry.dominant] ?? entry.dominant} (${money(entry.dominantUsd)} of ${money(entry.usd)}) · ${requests}`;
}

function coverageText(coverage: Coverage, scope: "turns" | "sessions"): string[] {
  const noun = scope === "turns" ? "turns" : "sessions";
  const lines = [`Ranked ${coverage.priced} priced of ${coverage.scanned} ${noun} examined · ${money(coverage.pricedTotalUsd)} total across all priced ${noun}.`];
  if (coverage.unpriced) lines.push(`${coverage.unpriced} reported usage with no applicable rate and cannot be ranked.`);
  if (coverage.withoutUsage) lines.push(`${coverage.withoutUsage} reported no usage at all.`);
  if (coverage.truncated) lines.push(`The scan limit was reached, so this covers only part of the range. Narrow the dates or server to see the rest.`);
  return lines;
}

export function RemoteAgentRankings({ projectId, hostId, onOpenSession }: {
  projectId: string; hostId?: string; onOpenSession: (sessionId: string) => void;
}) {
  const [scope, setScope] = useState<"turns" | "sessions">("turns");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [model, setModel] = useState("");
  const [page, setPage] = useState<RankingPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    setBusy(true);
    try {
      const query = new URLSearchParams({ scope });
      if (hostId) query.set("hostId", hostId);
      if (model.trim()) query.set("model", model.trim());
      // Date inputs are calendar days; widen to the whole day so a single day is not an empty instant range.
      if (from) query.set("from", `${from}T00:00:00.000Z`);
      if (to) query.set("to", `${to}T23:59:59.999Z`);
      const result = await api<RankingPage>(withProjectId(`/external-sessions/rankings?${query}`, projectId));
      if (current !== generation.current) return;
      // A response is a trust boundary: a malformed page must surface as an error, not blank the whole panel.
      if (!Array.isArray(result?.entries) || !result?.coverage) throw new Error("Rankings response was malformed");
      setPage(result); setError(null);
    } catch (e) {
      if (current === generation.current) { setError(e instanceof Error ? e.message : "Rankings unavailable"); setPage(null); }
    } finally { if (current === generation.current) setBusy(false); }
  }, [from, hostId, model, projectId, scope, to]);
  useEffect(() => { void load(); }, [load]);
  const entries = page?.entries ?? [];
  return <section className="remote-agent-rankings" aria-labelledby="remote-rankings-heading">
    <h3 id="remote-rankings-heading">Most expensive work</h3>
    <div className="remote-agent-filters">
      <label htmlFor="ranking-scope">Rank<select id="ranking-scope" value={scope} onChange={e => setScope(e.target.value === "sessions" ? "sessions" : "turns")}>
        <option value="turns">Turns</option><option value="sessions">Sessions</option>
      </select></label>
      <label htmlFor="ranking-from">From<input id="ranking-from" type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
      <label htmlFor="ranking-to">To<input id="ranking-to" type="date" value={to} onChange={e => setTo(e.target.value)} /></label>
      <label htmlFor="ranking-model">Model<input id="ranking-model" value={model} onChange={e => setModel(e.target.value)} placeholder="All models" /></label>
    </div>
    {error && <p role="alert" aria-label="Rankings error">{error}</p>}
    <div className="remote-agent-meta" role="status" aria-label="Ranking coverage">
      {busy && !page ? "Loading rankings…" : page ? coverageText(page.coverage, page.scope).map(line => <p key={line}>{line}</p>) : null}
    </div>
    {!!entries.length && <ol className="remote-ranking-list" aria-label="Most expensive work">
      {entries.map(entry => <li key={`${entry.sessionId}:${entry.nativeTurnId ?? "session"}`} className="card remote-ranking-row">
        <button onClick={() => onOpenSession(entry.sessionId)}>
          <strong>{money(entry.usd)}</strong>
          <span>{entry.title || entry.sessionId.slice(0, 12)}{entry.ordinal === undefined ? "" : ` · turn ${entry.ordinal + 1}`}</span>
          <span className="remote-agent-meta">{entry.hostId} · {entry.provider}{entry.at ? ` · ${new Date(entry.at).toLocaleString()}` : ""}</span>
          <span className="remote-agent-meta">{driverText(entry)}</span>
          <span className="remote-agent-meta">{entry.recordedRates ? "At recorded rates" : entry.recalculated ? "Recalculated at today’s rates" : "At current rates"}</span>
        </button>
      </li>)}
    </ol>}
    {page && !entries.length && !error && <p>No priced work matched these filters.</p>}
  </section>;
}
