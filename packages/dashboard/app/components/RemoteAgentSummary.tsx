import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client/client";
import { withProjectId } from "../api/client/health";

/*
FNXC:ExternalSessionSummary 2026-09-24-07:05 (operator decision F3 = A):
An AI summary of a collected session. This is a NEW Fusion capability, not a restored AgentPulse feature.

Everything that qualifies the summary is rendered, never inferred by the reader:
- what it covered (turn range), so a summary of an since-continued session is not read as current;
- that it is stale, with how many turns have landed since;
- that the last attempt failed, and why — while STILL showing the previous summary, because during an
  inference outage the older summary plus the failure is more useful than an empty pane.

Generation is operator-triggered. Opening a session never spends model budget.
*/
type SummaryRecord = {
  summary: string | null; provider: string | null; model: string | null;
  throughOrdinal: number | null; turnCount: number | null; generatedAt: string | null;
  status: "ready" | "failed"; failure: string | null; attemptedAt: string;
};
type SummaryBody = { schemaVersion: 1; summary: SummaryRecord | null; stale: boolean; turnsSince: number };

function coverageLabel(record: SummaryRecord): string {
  if (record.throughOrdinal === null || record.turnCount === null) return "Coverage unknown";
  const turns = `${record.turnCount} ${record.turnCount === 1 ? "turn" : "turns"}`;
  return `Covers ${turns} through turn ${record.throughOrdinal + 1}`;
}

export function RemoteAgentSummary({ sessionId, projectId }: { sessionId: string; projectId: string }) {
  const [body, setBody] = useState<SummaryBody | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = `/external-sessions/${sessionId}/summary`;
  const generation = useRef(0);
  const load = useCallback(async (signal: AbortSignal) => {
    try {
      const result = await api<SummaryBody>(withProjectId(path, projectId), { signal });
      // A response is a trust boundary: a malformed body must surface as an error, not blank the pane.
      if (!signal.aborted) {
        if (typeof result?.stale !== "boolean") throw new Error("Summary response was malformed");
        setBody(result); setError(null);
      }
    } catch (e) { if (!signal.aborted) setError(e instanceof Error ? e.message : "Summary unavailable"); }
  }, [path, projectId]);
  useEffect(() => {
    const controller = new AbortController(); void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  const generate = async () => {
    if (busy) return;
    const current = ++generation.current;
    setBusy(true); setError(null);
    try {
      const result = await api<SummaryBody>(withProjectId(path, projectId), { method: "POST" });
      if (current === generation.current) { setBody(result); }
    } catch (e) {
      /* The route records the failure durably and answers 502 with the preserved record, so refetch rather than
         dropping what is on screen: the previous summary must survive a failed regeneration. */
      if (current === generation.current) {
        const controller = new AbortController();
        await load(controller.signal);
        // Set the alert AFTER the refetch: a successful refetch clears `error`, and this attempt did fail.
        if (current === generation.current) setError(e instanceof Error ? e.message : "Summary generation failed");
      }
    } finally { if (current === generation.current) setBusy(false); }
  };
  const record = body?.summary ?? null;
  return <section className="remote-agent-summary" aria-labelledby="remote-summary-heading">
    <h4 id="remote-summary-heading">Session summary</h4>
    {error && <p role="alert" aria-label="Session summary error">{error}</p>}
    {record?.summary ? <p className="remote-agent-summary-text">{record.summary}</p>
      : <p className="remote-agent-meta">No summary has been generated for this session yet.</p>}
    <div className="remote-agent-meta" role="status" aria-label="Session summary state">
      {record?.summary && record.generatedAt && <p>
        {coverageLabel(record)} · generated {new Date(record.generatedAt).toLocaleString()}
        {record.model ? ` · ${record.model}` : ""}
      </p>}
      {body?.stale && <p>{body.turnsSince} {body.turnsSince === 1 ? "turn has" : "turns have"} landed since this summary. Regenerate to include them.</p>}
      {record?.status === "failed" && <p>
        Last attempt failed {new Date(record.attemptedAt).toLocaleString()}
        {record.failure ? `: ${record.failure}` : "."}
        {record.summary ? " The summary above is the last one that succeeded." : ""}
      </p>}
    </div>
    <button type="button" onClick={() => void generate()} disabled={busy}>
      {busy ? "Summarizing…" : record?.summary ? "Regenerate summary" : "Generate summary"}
    </button>
  </section>;
}
