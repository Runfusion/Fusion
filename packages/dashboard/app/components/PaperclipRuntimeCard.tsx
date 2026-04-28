/**
 * Paperclip runtime settings card.
 *
 * Two transport modes:
 *   - "api": user supplies `apiUrl` + `apiKey` directly.
 *   - "cli": auto-derives `apiUrl` (and, for local-trusted, `apiKey`) from the
 *     local `paperclipai` instance config (default
 *     `~/.paperclip/instances/default/config.json`).
 *
 * After a connection is established the card auto-loads the company list (or
 * the single company the agent key is scoped to) and the agent list inside
 * the chosen company so the user picks a real agent rather than typing IDs.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchPaperclipAgents,
  fetchPaperclipCliDiscovery,
  fetchPaperclipCompanies,
  fetchPaperclipStatus,
  fetchPluginSettings,
  mintPaperclipApiKey,
  updatePluginSettings,
  type PaperclipAgentSummary,
  type PaperclipCliDiscoveryResult,
  type PaperclipCompanySummary,
  type PaperclipProviderStatus,
} from "../api";
import { ProviderIcon } from "./ProviderIcon";
import { RuntimeCardShell } from "./RuntimeCardShell";

const PLUGIN_ID = "fusion-plugin-paperclip-runtime";
const PAPERCLIP_LEARN_MORE = "https://paperclip.ing/";
const PAPERCLIP_GITHUB = "https://github.com/paperclipai/paperclip";

type PaperclipMode = "issue-per-prompt" | "rolling-issue" | "wakeup-only";
type Transport = "api" | "cli";

const MODE_OPTIONS: { value: PaperclipMode; label: string; help: string }[] = [
  {
    value: "rolling-issue",
    label: "Rolling issue (default)",
    help: "One Paperclip issue per Fusion session; subsequent prompts are added as comments. Closest to a chat experience.",
  },
  {
    value: "issue-per-prompt",
    label: "Issue per prompt",
    help: "Each prompt creates a new top-level Paperclip issue. Maximally explicit; tends to clutter the board.",
  },
  {
    value: "wakeup-only",
    label: "Wakeup only (advanced)",
    help: "No issue side-effects; the prompt is delivered via the wakeup payload only. Requires the agent's prompt template to know how to handle a payload-driven wake.",
  },
];

interface PaperclipSettings {
  transport: Transport;
  apiUrl: string;
  apiKey: string;
  cliBinaryPath: string;
  cliConfigPath: string;
  agentId: string;
  companyId: string;
  mode: PaperclipMode;
  parentIssueId: string;
  projectId: string;
  goalId: string;
  runTimeoutMs: number;
}

const DEFAULT_SETTINGS: PaperclipSettings = {
  transport: "api",
  apiUrl: "http://localhost:3100",
  apiKey: "",
  cliBinaryPath: "paperclipai",
  cliConfigPath: "",
  agentId: "",
  companyId: "",
  mode: "rolling-issue",
  parentIssueId: "",
  projectId: "",
  goalId: "",
  runTimeoutMs: 600_000,
};

const VALID_MODES = new Set<PaperclipMode>([
  "issue-per-prompt",
  "rolling-issue",
  "wakeup-only",
]);

function settingsFromRecord(raw: Record<string, unknown>): PaperclipSettings {
  const str = (k: string, fallback: string): string =>
    typeof raw[k] === "string" ? (raw[k] as string) : fallback;
  const num = (k: string, fallback: number): number =>
    typeof raw[k] === "number" ? (raw[k] as number) : fallback;
  const transport: Transport = raw.transport === "cli" ? "cli" : "api";
  const mode: PaperclipMode = VALID_MODES.has(raw.mode as PaperclipMode)
    ? (raw.mode as PaperclipMode)
    : DEFAULT_SETTINGS.mode;
  return {
    transport,
    apiUrl: str("apiUrl", DEFAULT_SETTINGS.apiUrl),
    apiKey: str("apiKey", DEFAULT_SETTINGS.apiKey),
    cliBinaryPath: str("cliBinaryPath", DEFAULT_SETTINGS.cliBinaryPath),
    cliConfigPath: str("cliConfigPath", DEFAULT_SETTINGS.cliConfigPath),
    agentId: str("agentId", DEFAULT_SETTINGS.agentId),
    companyId: str("companyId", DEFAULT_SETTINGS.companyId),
    mode,
    parentIssueId: str("parentIssueId", DEFAULT_SETTINGS.parentIssueId),
    projectId: str("projectId", DEFAULT_SETTINGS.projectId),
    goalId: str("goalId", DEFAULT_SETTINGS.goalId),
    runTimeoutMs: num("runTimeoutMs", DEFAULT_SETTINGS.runTimeoutMs),
  };
}

export function PaperclipRuntimeCard() {
  const [settings, setSettings] = useState<PaperclipSettings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<PaperclipProviderStatus | null>(null);
  const [cliDiscovery, setCliDiscovery] =
    useState<PaperclipCliDiscoveryResult | null>(null);
  const [companies, setCompanies] = useState<PaperclipCompanySummary[]>([]);
  const [agents, setAgents] = useState<PaperclipAgentSummary[]>([]);
  const [busy, setBusy] = useState<
    "loading" | "saving" | "testing" | "save-test" | null
  >(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; message: string } | null>(null);
  const [apiKeyDirty, setApiKeyDirty] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // The "effective" apiUrl/apiKey used for status + dropdowns.
  // In CLI mode we prefer whatever cliDiscovery returned, falling back to the
  // typed apiUrl if discovery hasn't completed yet.
  const effectiveAuth = useMemo<{ apiUrl: string; apiKey?: string }>(() => {
    if (settings.transport === "cli" && cliDiscovery && cliDiscovery.ok) {
      return {
        apiUrl: cliDiscovery.apiUrl,
        apiKey: settings.apiKey || cliDiscovery.apiKey || undefined,
      };
    }
    return {
      apiUrl: settings.apiUrl,
      apiKey: settings.apiKey || undefined,
    };
  }, [settings.transport, settings.apiUrl, settings.apiKey, cliDiscovery]);

  // Load saved settings on mount.
  useEffect(() => {
    setBusy("loading");
    fetchPluginSettings(PLUGIN_ID)
      .then((raw) => {
        if (mountedRef.current) setSettings(settingsFromRecord(raw));
      })
      .catch(() => {
        // Defaults remain.
      })
      .finally(() => {
        if (mountedRef.current) setBusy(null);
      });
  }, []);

  // CLI discovery whenever transport=cli (and cliConfigPath changes).
  useEffect(() => {
    if (settings.transport !== "cli") {
      setCliDiscovery(null);
      return;
    }
    let cancelled = false;
    fetchPaperclipCliDiscovery({
      cliConfigPath: settings.cliConfigPath || undefined,
    })
      .then((r) => {
        if (!cancelled && mountedRef.current) setCliDiscovery(r);
      })
      .catch(() => {
        if (!cancelled && mountedRef.current)
          setCliDiscovery({ ok: false, reason: "Discovery request failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [settings.transport, settings.cliConfigPath]);

  // Probe + load companies/agents whenever effective auth changes.
  const probe = useCallback(async (): Promise<PaperclipProviderStatus | null> => {
    if (!effectiveAuth.apiUrl) return null;
    try {
      const next = await fetchPaperclipStatus(effectiveAuth);
      if (mountedRef.current) setStatus(next);
      // Then load companies + agents for the picker.
      const cs = await fetchPaperclipCompanies(effectiveAuth);
      if (!mountedRef.current) return next;
      setCompanies(cs);
      // Auto-pick a company: keep current selection if it exists in cs;
      // otherwise default to identity's company; otherwise the first one.
      let picked = settings.companyId;
      if (!cs.some((c) => c.id === picked)) {
        picked =
          next.connection.identity?.companyId ?? (cs[0]?.id ?? "");
        if (picked && picked !== settings.companyId) {
          setSettings((s) => ({ ...s, companyId: picked }));
        }
      }
      if (picked) {
        const ag = await fetchPaperclipAgents({
          ...effectiveAuth,
          companyId: picked,
        });
        if (mountedRef.current) {
          setAgents(ag);
          // Auto-pick agent the same way.
          if (!ag.some((a) => a.id === settings.agentId)) {
            const nextAgent =
              next.connection.identity?.agentId ?? (ag[0]?.id ?? "");
            if (nextAgent && nextAgent !== settings.agentId) {
              setSettings((s) => ({ ...s, agentId: nextAgent }));
            }
          }
        }
      } else {
        if (mountedRef.current) setAgents([]);
      }
      return next;
    } catch (err) {
      if (mountedRef.current)
        setToast({ kind: "err", message: err instanceof Error ? err.message : String(err) });
      return null;
    }
    // Deliberately keyed only on the URL/key — companyId/agentId changes are
    // handled by a separate effect below.
  }, [effectiveAuth.apiUrl, effectiveAuth.apiKey, settings.companyId, settings.agentId]);

  useEffect(() => {
    void probe();
  }, [probe]);

  // Reload agent list when the user manually changes companyId.
  useEffect(() => {
    if (!effectiveAuth.apiUrl || !settings.companyId) {
      setAgents([]);
      return;
    }
    let cancelled = false;
    fetchPaperclipAgents({
      ...effectiveAuth,
      companyId: settings.companyId,
    })
      .then((ag) => {
        if (!cancelled && mountedRef.current) setAgents(ag);
      })
      .catch(() => {
        if (!cancelled && mountedRef.current) setAgents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveAuth.apiUrl, effectiveAuth.apiKey, settings.companyId]);

  const buildPayload = useCallback((): Record<string, unknown> => {
    const payload: Record<string, unknown> = {
      transport: settings.transport,
      mode: settings.mode,
      parentIssueId: settings.parentIssueId,
      projectId: settings.projectId,
      goalId: settings.goalId,
      runTimeoutMs: settings.runTimeoutMs,
      agentId: settings.agentId,
      companyId: settings.companyId,
    };
    if (settings.transport === "api") {
      payload.apiUrl = settings.apiUrl;
    } else {
      payload.cliBinaryPath = settings.cliBinaryPath;
      if (settings.cliConfigPath) payload.cliConfigPath = settings.cliConfigPath;
    }
    if (apiKeyDirty) payload.apiKey = settings.apiKey;
    return payload;
  }, [settings, apiKeyDirty]);

  const handleTest = useCallback(async () => {
    setBusy("testing");
    setToast(null);
    const next = await probe();
    if (!mountedRef.current) return;
    setBusy(null);
    if (!next) {
      if (settings.transport === "cli" && cliDiscovery && !cliDiscovery.ok) {
        setToast({
          kind: "err",
          message: `✗ CLI discovery failed: ${cliDiscovery.reason}`,
        });
      } else {
        setToast({ kind: "err", message: "Test failed — see status above." });
      }
    } else if (next.connection.available) {
      const id = next.connection.identity;
      setToast({
        kind: "ok",
        message: id
          ? `✓ Connected as ${id.agentName}${id.companyName ? ` at ${id.companyName}` : ""}.`
          : "✓ Connected.",
      });
    } else {
      setToast({
        kind: "err",
        message: `✗ ${next.connection.reason ?? "Paperclip server unreachable"}`,
      });
    }
  }, [probe, settings.transport, cliDiscovery]);

  const handleSave = useCallback(async () => {
    setBusy("saving");
    setToast(null);
    try {
      await updatePluginSettings(PLUGIN_ID, buildPayload());
      if (mountedRef.current) {
        setToast({ kind: "ok", message: "Settings saved." });
        setApiKeyDirty(false);
      }
    } catch (err) {
      if (mountedRef.current)
        setToast({ kind: "err", message: err instanceof Error ? err.message : String(err) });
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [buildPayload]);

  const handleSaveAndTest = useCallback(async () => {
    setBusy("save-test");
    setToast(null);
    try {
      await updatePluginSettings(PLUGIN_ID, buildPayload());
      if (mountedRef.current) setApiKeyDirty(false);
      const next = await probe();
      if (!mountedRef.current) return;
      if (!next) {
        if (settings.transport === "cli" && cliDiscovery && !cliDiscovery.ok) {
          setToast({
            kind: "err",
            message: `Saved · ✗ CLI discovery failed: ${cliDiscovery.reason}`,
          });
        } else {
          setToast({ kind: "err", message: "Saved, but probe failed." });
        }
      } else if (next.connection.available) {
        const id = next.connection.identity;
        setToast({
          kind: "ok",
          message: id
            ? `Saved · ✓ Connected as ${id.agentName}${id.companyName ? ` at ${id.companyName}` : ""}.`
            : "Saved · ✓ Connected.",
        });
      } else {
        setToast({
          kind: "err",
          message: `Saved · ✗ ${next.connection.reason ?? "Paperclip server unreachable"}`,
        });
      }
    } catch (err) {
      if (mountedRef.current)
        setToast({ kind: "err", message: err instanceof Error ? err.message : String(err) });
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [buildPayload, probe, settings.transport, cliDiscovery]);

  const connected = status?.connection.available ?? null;
  const identity = status?.connection.identity;
  const cliOk = cliDiscovery?.ok === true;

  const statusKind =
    status === null
      ? "loading"
      : connected
        ? "ok"
        : "err";

  const statusText =
    status === null
      ? settings.transport === "cli" && cliDiscovery && !cliOk
        ? `✗ CLI discovery failed: ${cliDiscovery.reason}`
        : "Probing Paperclip server…"
      : connected
        ? identity
          ? `✓ Connected as ${identity.agentName}${identity.role ? ` (${identity.role})` : ""}${identity.companyName ? ` at ${identity.companyName}` : ""}`
          : "✓ Connected"
        : `✗ ${status.connection.reason ?? "Unreachable"}`;

  const tabs = (
    <div
      className="runtime-card__tabs"
      role="tablist"
      aria-label="Paperclip connection mode"
    >
      <button
        type="button"
        role="tab"
        aria-selected={settings.transport === "api"}
        className="runtime-card__tab"
        onClick={() => setSettings((s) => ({ ...s, transport: "api" }))}
      >
        API (URL + token)
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={settings.transport === "cli"}
        className="runtime-card__tab"
        onClick={() => setSettings((s) => ({ ...s, transport: "cli" }))}
      >
        Local CLI (auto-derive)
      </button>
    </div>
  );

  return (
    <RuntimeCardShell
      testId="paperclip-runtime-card"
      logo={<ProviderIcon provider="paperclip" size="lg" />}
      name="Paperclip"
      learnMoreHref={PAPERCLIP_LEARN_MORE}
      statusKind={statusKind}
      statusText={statusText}
      description={
        <>
          Drive a Paperclip agent ("employee") in a Paperclip company. Each
          prompt dispatches a task-shaped request; governance, budgets, and
          approvals are enforced by Paperclip. Expect seconds-to-minutes
          latency per turn.
        </>
      }
      tabs={tabs}
      busy={busy}
      toast={toast}
      onTest={() => void handleTest()}
      onSave={() => void handleSave()}
      onSaveAndTest={() => void handleSaveAndTest()}
      belowForm={
        connected === false ? (
          <div className="onboarding-helper-text">
            <p>Make sure a Paperclip server is running. To install Paperclip:</p>
            <pre>
              <code>npm install -g paperclipai</code>
            </pre>
            <p>
              <a href={PAPERCLIP_LEARN_MORE} target="_blank" rel="noreferrer">
                Paperclip docs
              </a>{" "}
              ·{" "}
              <a href={PAPERCLIP_GITHUB} target="_blank" rel="noreferrer">
                GitHub
              </a>
            </p>
          </div>
        ) : null
      }
    >
      {/* CLI discovery banner */}
      {settings.transport === "cli" && cliDiscovery && (
        <div className="settings-muted" style={{ marginBottom: "var(--space-sm)" }}>
          {cliOk ? (
            <small>
              CLI config: <code>{(cliDiscovery as { configPath: string }).configPath}</code>{" "}
              · resolved <code>{cliDiscovery.apiUrl}</code>
              {(cliDiscovery as { deploymentMode?: string }).deploymentMode
                ? ` · ${(cliDiscovery as { deploymentMode?: string }).deploymentMode}`
                : ""}
            </small>
          ) : (
            <small>CLI discovery failed: {cliDiscovery.reason}</small>
          )}
        </div>
      )}

      {/* API mode fields */}
      {settings.transport === "api" && (
        <>
          <div className="form-group">
            <label htmlFor="paperclip-apiUrl">API URL</label>
            <input
              id="paperclip-apiUrl"
              type="text"
              placeholder="http://localhost:3100"
              value={settings.apiUrl}
              onChange={(e) => setSettings((s) => ({ ...s, apiUrl: e.target.value }))}
            />
            <small>Base URL of the Paperclip server.</small>
          </div>

          <div className="form-group">
            <label htmlFor="paperclip-apiKey">API key</label>
            <input
              id="paperclip-apiKey"
              type="password"
              placeholder={apiKeyDirty ? "" : "••••••••  (leave blank to keep existing)"}
              value={settings.apiKey}
              onChange={(e) => {
                setSettings((s) => ({ ...s, apiKey: e.target.value }));
                setApiKeyDirty(true);
              }}
            />
            <small>Agent API key. Local-trusted deployments may leave this blank.</small>
          </div>
        </>
      )}

      {/* CLI mode fields */}
      {settings.transport === "cli" && (
        <>
          <div className="form-group">
            <label htmlFor="paperclip-cliBinaryPath">paperclipai binary</label>
            <input
              id="paperclip-cliBinaryPath"
              type="text"
              placeholder="paperclipai"
              value={settings.cliBinaryPath}
              onChange={(e) =>
                setSettings((s) => ({ ...s, cliBinaryPath: e.target.value }))
              }
            />
            <small>
              Optional — informational; the adapter currently reads the instance
              config file directly.
            </small>
          </div>
          <div className="form-group">
            <label htmlFor="paperclip-cliConfigPath">Instance config path</label>
            <input
              id="paperclip-cliConfigPath"
              type="text"
              placeholder="~/.paperclip/instances/default/config.json"
              value={settings.cliConfigPath}
              onChange={(e) =>
                setSettings((s) => ({ ...s, cliConfigPath: e.target.value }))
              }
            />
            <small>
              Override the path to <code>config.json</code>. Leave blank for the
              default.
            </small>
          </div>
          <div className="form-group">
            <label htmlFor="paperclip-cli-apikey">API key (override, optional)</label>
            <input
              id="paperclip-cli-apikey"
              type="password"
              placeholder={
                apiKeyDirty ? "" : "Optional — only required for non-local-trusted modes"
              }
              value={settings.apiKey}
              onChange={(e) => {
                setSettings((s) => ({ ...s, apiKey: e.target.value }));
                setApiKeyDirty(true);
              }}
            />
            <small>Local-trusted deployments do not require a key.</small>
            {/* Mint button: show when CLI mode, connection attempted but unavailable, and agent selected */}
            {status !== null && connected === false && settings.agentId && (
              <button
                type="button"
                className="btn btn--sm"
                style={{ marginTop: "0.4rem" }}
                disabled={busy !== null}
                onClick={async () => {
                  const agentId = settings.agentId;
                  const companyId = settings.companyId.trim();
                  if (!agentId || !companyId) {
                    setToast({
                      kind: "err",
                      message: "✗ Company ID is required to mint a Paperclip API key.",
                    });
                    return;
                  }
                  setBusy("testing");
                  setToast(null);
                  const result = await mintPaperclipApiKey({
                    cliBinaryPath: settings.cliBinaryPath || undefined,
                    agentRef: agentId,
                    companyId,
                    keyName: "fusion-runtime",
                    configPath: settings.cliConfigPath || undefined,
                  });
                  if (!mountedRef.current) return;
                  setBusy(null);
                  if (result.ok) {
                    setSettings((s) => ({ ...s, apiKey: result.key.apiKey }));
                    setApiKeyDirty(true);
                    setToast({
                      kind: "ok",
                      message: `✓ API key minted via paperclipai (key 'fusion-runtime' installed for agent ${agentId}). Click Save to persist.`,
                    });
                    void probe();
                  } else {
                    setToast({
                      kind: "err",
                      message: `✗ Mint failed: ${result.reason}. Run \`paperclipai onboard\` first if your CLI isn't authenticated.`,
                    });
                  }
                }}
              >
                ✨ Mint API key via paperclipai
              </button>
            )}
          </div>
        </>
      )}

      {/* Company picker */}
      <div className="form-group">
        <label htmlFor="paperclip-companyId">Company</label>
        <select
          id="paperclip-companyId"
          value={settings.companyId}
          onChange={(e) => setSettings((s) => ({ ...s, companyId: e.target.value }))}
          disabled={companies.length === 0}
        >
          {companies.length === 0 ? (
            <option value="">
              {connected ? "No companies discovered" : "Connect to populate"}
            </option>
          ) : (
            companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.id})
              </option>
            ))
          )}
        </select>
        <small>Select a Paperclip company.</small>
      </div>

      {/* Agent picker */}
      <div className="form-group">
        <label htmlFor="paperclip-agentId">Agent</label>
        <select
          id="paperclip-agentId"
          value={settings.agentId}
          onChange={(e) => setSettings((s) => ({ ...s, agentId: e.target.value }))}
          disabled={agents.length === 0}
        >
          {agents.length === 0 ? (
            <option value="">
              {settings.companyId ? "No agents discovered" : "Pick a company first"}
            </option>
          ) : (
            agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.role ? ` (${a.role})` : ""}
              </option>
            ))
          )}
        </select>
        <small>Pick the Paperclip agent this Fusion runtime will proxy.</small>
      </div>

      {/* Conversation mode */}
      <div className="form-group">
        <label htmlFor="paperclip-mode">Conversation mode</label>
        <select
          id="paperclip-mode"
          value={settings.mode}
          onChange={(e) =>
            setSettings((s) => ({ ...s, mode: e.target.value as PaperclipMode }))
          }
        >
          {MODE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <small>{MODE_OPTIONS.find((o) => o.value === settings.mode)?.help}</small>
      </div>

      {/* Optional scoping */}
      <div className="form-group">
        <label htmlFor="paperclip-projectId">Project ID (optional)</label>
        <input
          id="paperclip-projectId"
          type="text"
          placeholder="Optional"
          value={settings.projectId}
          onChange={(e) => setSettings((s) => ({ ...s, projectId: e.target.value }))}
        />
        <small>Pin work to a specific Paperclip project.</small>
      </div>

      <div className="form-group">
        <label htmlFor="paperclip-parentIssueId">Parent issue ID (optional)</label>
        <input
          id="paperclip-parentIssueId"
          type="text"
          placeholder="Optional"
          value={settings.parentIssueId}
          onChange={(e) => setSettings((s) => ({ ...s, parentIssueId: e.target.value }))}
        />
        <small>Scope work under an existing parent issue.</small>
      </div>

      <div className="form-group">
        <label htmlFor="paperclip-goalId">Goal ID (optional)</label>
        <input
          id="paperclip-goalId"
          type="text"
          placeholder="Optional"
          value={settings.goalId}
          onChange={(e) => setSettings((s) => ({ ...s, goalId: e.target.value }))}
        />
        <small>Associate work with a Paperclip goal.</small>
      </div>

      <div className="form-group">
        <label htmlFor="paperclip-runTimeoutMs">Run timeout (ms)</label>
        <input
          id="paperclip-runTimeoutMs"
          type="number"
          min={0}
          step={1000}
          value={settings.runTimeoutMs}
          onChange={(e) =>
            setSettings((s) => ({
              ...s,
              runTimeoutMs: parseInt(e.target.value, 10) || DEFAULT_SETTINGS.runTimeoutMs,
            }))
          }
        />
        <small>Local cap before Fusion gives up on a Paperclip run.</small>
      </div>
    </RuntimeCardShell>
  );
}
