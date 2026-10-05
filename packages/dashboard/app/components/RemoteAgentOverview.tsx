import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client/client";
import { withProjectId } from "../api/client/health";

/*
FNXC:ExternalSessionOverview 2026-09-24-08:12:
"What did this range cost?" Until now every cost figure answered "this session" or "these top N", and the
per-server totals cover only the sessions currently loaded — which the panel says, but which leaves the
question unanswered.

Coverage is rendered unconditionally, as in rankings: a total without it silently means "the cost of the work
we happened to have rates for". Truncation, unpriced sessions and usage-free sessions each get their own
sentence, because collapsing them hides which limitation applies.
*/
type Bucket = { key: string; usd: number; sessions: number };
type Coverage = { scanned: number; priced: number; unpriced: number; withoutUsage: number; truncated: boolean; pricedTotalUsd: number };
type OverviewPage = {
  schemaVersion: 1; totalUsd: number; coverage: Coverage;
  byDay: Bucket[]; byModel: Bucket[]; byHost: Bucket[];
  fusionAttributed: { sessions: number; usd: number; ambiguous: number };
};

const money = (n: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(n);

function coverageText(coverage: Coverage): string[] {
  const lines = [`${coverage.priced} of ${coverage.scanned} sessions examined could be priced.`];
  if (coverage.unpriced) lines.push(`${coverage.unpriced} reported usage with no applicable rate and are not in this total.`);
  if (coverage.withoutUsage) lines.push(`${coverage.withoutUsage} reported no usage at all.`);
  if (coverage.truncated) lines.push(`The scan limit was reached, so this covers only part of the range. Narrow the dates or server to see the rest.`);
  return lines;
}

/*
FNXC:ExternalSessionAttribution 2026-09-24-08:12 (F4 = 1): the Fusion-run split is stated as a SPLIT of this
total, never added to Fusion task totals — that sum is the double count F4 exists to prevent. The wording says
"proven" deliberately: an unattributed session is unproven, not proven separate.
*/
function attributionText(page: OverviewPage): string | null {
  const { sessions, usd, ambiguous } = page.fusionAttributed;
  const parts: string[] = [];
  if (sessions) parts.push(`${money(usd)} of this total is ${sessions} ${sessions === 1 ? "session" : "sessions"} proven to be Fusion's own task runs, already counted in task telemetry.`);
  if (ambiguous) parts.push(`${ambiguous} ${ambiguous === 1 ? "session matches" : "sessions match"} more than one Fusion run, so the owning task is unknown.`);
  if (!parts.length) return null;
  return parts.join(" ");
}

function bucketList(title: string, buckets: Bucket[], limit = 5) {
  if (!buckets.length) return null;
  return <div className="remote-overview-group">
    <h4>{title}</h4>
    <ul aria-label={title}>
      {buckets.slice(0, limit).map(b => <li key={b.key}>
        <span>{b.key}</span><strong>{money(b.usd)}</strong>
      </li>)}
    </ul>
  </div>;
}

export function RemoteAgentOverview({ projectId, hostId }: { projectId: string; hostId?: string }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState<OverviewPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    setBusy(true);
    try {
      const query = new URLSearchParams();
      if (hostId) query.set("hostId", hostId);
      // Date inputs are calendar days; widen to the whole day so a single day is not an empty instant range.
      if (from) query.set("from", `${from}T00:00:00.000Z`);
      if (to) query.set("to", `${to}T23:59:59.999Z`);
      const result = await api<OverviewPage>(withProjectId(`/external-sessions/overview?${query}`, projectId));
      if (current !== generation.current) return;
      // A response is a trust boundary: a malformed page must surface as an error, not blank the panel.
      if (!result?.coverage || typeof result.totalUsd !== "number") throw new Error("Overview response was malformed");
      setPage(result); setError(null);
    } catch (e) {
      if (current === generation.current) { setError(e instanceof Error ? e.message : "Overview unavailable"); setPage(null); }
    } finally { if (current === generation.current) setBusy(false); }
  }, [from, hostId, projectId, to]);
  useEffect(() => { void load(); }, [load]);
  const attribution = page ? attributionText(page) : null;
  return <section className="remote-agent-overview" aria-labelledby="remote-overview-heading">
    <h3 id="remote-overview-heading">Cost overview</h3>
    <div className="remote-agent-filters">
      <label htmlFor="overview-from">From<input id="overview-from" type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
      <label htmlFor="overview-to">To<input id="overview-to" type="date" value={to} onChange={e => setTo(e.target.value)} /></label>
    </div>
    {error && <p role="alert" aria-label="Cost overview error">{error}</p>}
    <div className="remote-agent-meta" role="status" aria-label="Cost overview coverage">
      {busy && !page ? <p>Loading overview…</p> : page ? <>
        <p><strong>{money(page.totalUsd)}</strong> across the selected range.</p>
        {coverageText(page.coverage).map(line => <p key={line}>{line}</p>)}
        {attribution && <p>{attribution}</p>}
      </> : null}
    </div>
    {page && <div className="remote-overview-groups">
      {bucketList("By day", page.byDay, 14)}
      {bucketList("By model", page.byModel)}
      {bucketList("By server", page.byHost)}
    </div>}
  </section>;
}
