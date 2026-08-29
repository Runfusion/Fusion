import { AlertTriangle, CheckCircle2, Play, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import type { RunResult } from "../generation/types.js";
import type { ServiceDraft } from "../wizard/types.js";
import { useRunGeneratedCli } from "./useRunGeneratedCli.js";
import "./TestRunnerPanel.css";

export function CliPrintingPressTestRunner({ draftId, draft }: { draftId: string; draft: ServiceDraft }) {
  const { regenerate, run } = useRunGeneratedCli();
  const [selectedEndpointId, setSelectedEndpointId] = useState(draft.endpoints[0]?.id ?? "");
  const [params, setParams] = useState<Record<string, string | number | boolean>>({});
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [result, setResult] = useState<RunResult | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | undefined>(draft.generatedAt ?? draft.regeneratedAt);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const endpoint = useMemo(() => draft.endpoints.find((item) => item.id === selectedEndpointId) ?? draft.endpoints[0], [draft.endpoints, selectedEndpointId]);
  const paramKeys = useMemo(() => (endpoint?.params ?? "").split(",").map((item) => item.trim()).filter(Boolean), [endpoint?.params]);

  async function onRegenerate() {
    setError(null);
    const response = await regenerate(draftId);
    setGeneratedAt(response.artifact.generatedAt);
  }

  async function onRun() {
    if (!endpoint) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      setResult(await run(draftId, { endpointId: endpoint.id, params, credentials }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Run failed");
    } finally {
      setRunning(false);
    }
  }

  const status = running ? "running" : (result?.timedOut || (typeof result?.exitCode === "number" && result.exitCode !== 0) ? "error" : (result ? "success" : "idle"));

  return (
    <section className="card clipp-test-runner">
      <header className="clipp-test-runner-header">
        <div>
          <h4>{draft.name} <span className="clipp-test-runner-slug">({draft.slug})</span></h4>
          <p>Generated: {generatedAt ? new Date(generatedAt).toLocaleString() : "Not generated"}</p>
        </div>
        <button className="btn btn-icon" onClick={() => void onRegenerate()} aria-label="Regenerate draft">
          <RefreshCw />
        </button>
      </header>

      <div className="clipp-test-runner-grid">
        <div className="clipp-test-runner-form">
          <label htmlFor={`clipp-endpoint-${draftId}`}>Endpoint</label>
          <select id={`clipp-endpoint-${draftId}`} className="select" value={endpoint?.id ?? ""} onChange={(event) => setSelectedEndpointId(event.target.value)}>
            {draft.endpoints.map((item) => <option key={item.id} value={item.id}>{item.method} {item.path}</option>)}
          </select>

          {paramKeys.map((key) => (
            <div key={key} className="form-group">
              <label htmlFor={`clipp-param-${key}`}>{key}</label>
              <input id={`clipp-param-${key}`} className="input" value={String(params[key] ?? "")} onChange={(event) => setParams((prev) => ({ ...prev, [key]: event.target.value }))} />
            </div>
          ))}

          <div className="clipp-test-runner-credentials">
            <label>Credentials</label>
            <input className="input" type="password" placeholder="api_key" value={credentials.api_key ?? ""} onChange={(event) => setCredentials((prev) => ({ ...prev, api_key: event.target.value }))} />
            <p className="clipp-test-runner-help">Credential values are used only for this run and are not persisted.</p>
          </div>

          <button className="btn btn-primary" disabled={running} onClick={() => void onRun()}><Play /> Run</button>
          {error ? <p className="form-error">{error}</p> : null}
        </div>

        <div className="clipp-test-runner-output">
          <div className="clipp-test-runner-status">
            <span className="status-dot" />
            {status === "running" ? <><AlertTriangle /> Running…</> : null}
            {status === "success" ? <><CheckCircle2 /> Success</> : null}
            {status === "error" ? <><AlertTriangle /> Failed</> : null}
            {result ? <span>{result.durationMs}ms</span> : null}
          </div>
          {result ? (
            <>
              <pre className="clipp-test-runner-pre">$ node {result.argv.join(" ")}</pre>
              <pre className="clipp-test-runner-pre">{result.stdout || "(no stdout)"}</pre>
              <pre className="clipp-test-runner-pre clipp-test-runner-pre-stderr">{result.stderr || "(no stderr)"}</pre>
            </>
          ) : <p>No run output yet.</p>}
        </div>
      </div>
    </section>
  );
}
