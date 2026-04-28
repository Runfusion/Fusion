import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchHermesProfiles,
  fetchHermesStatus,
  fetchPluginSettings,
  updatePluginSettings,
  type HermesProfileSummary,
  type HermesProviderStatus,
} from "../api";
import { ProviderIcon } from "./ProviderIcon";
import { RuntimeCardShell } from "./RuntimeCardShell";

const PLUGIN_ID = "fusion-plugin-hermes-runtime";
const HERMES_LEARN_MORE = "https://github.com/NousResearch/hermes-agent";

const HERMES_PROVIDER_OPTIONS = [
  "auto",
  "anthropic",
  "openrouter",
  "gemini",
  "openai-codex",
  "copilot",
  "copilot-acp",
  "huggingface",
  "zai",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "kilocode",
  "xiaomi",
  "nous",
] as const;

interface HermesSettings {
  binaryPath: string;
  model: string;
  provider: string;
  maxTurns: number;
  yolo: boolean;
  cliTimeoutMs: number;
  /** Hermes profile name; empty = "Auto / use Hermes default". */
  profile: string;
}

const DEFAULT_SETTINGS: HermesSettings = {
  binaryPath: "",
  model: "",
  provider: "auto",
  maxTurns: 12,
  yolo: false,
  cliTimeoutMs: 300_000,
  profile: "",
};

function settingsFromRecord(raw: Record<string, unknown>): HermesSettings {
  return {
    binaryPath: typeof raw.binaryPath === "string" ? raw.binaryPath : DEFAULT_SETTINGS.binaryPath,
    model: typeof raw.model === "string" ? raw.model : DEFAULT_SETTINGS.model,
    provider: typeof raw.provider === "string" ? raw.provider : DEFAULT_SETTINGS.provider,
    maxTurns: typeof raw.maxTurns === "number" ? raw.maxTurns : DEFAULT_SETTINGS.maxTurns,
    yolo: typeof raw.yolo === "boolean" ? raw.yolo : DEFAULT_SETTINGS.yolo,
    cliTimeoutMs:
      typeof raw.cliTimeoutMs === "number" ? raw.cliTimeoutMs : DEFAULT_SETTINGS.cliTimeoutMs,
    profile: typeof raw.profile === "string" ? raw.profile : DEFAULT_SETTINGS.profile,
  };
}

export function HermesRuntimeCard() {
  const [settings, setSettings] = useState<HermesSettings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<HermesProviderStatus | null>(null);
  const [profiles, setProfiles] = useState<HermesProfileSummary[]>([]);
  const [busy, setBusy] = useState<"loading" | "saving" | "testing" | "save-test" | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; message: string } | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setBusy("loading");
    fetchPluginSettings(PLUGIN_ID)
      .then((raw) => {
        if (mountedRef.current) setSettings(settingsFromRecord(raw));
      })
      .catch(() => undefined)
      .finally(() => {
        if (mountedRef.current) setBusy(null);
      });
  }, []);

  useEffect(() => {
    fetchHermesProfiles(settings.binaryPath ? { binaryPath: settings.binaryPath } : {})
      .then((p) => { if (mountedRef.current) setProfiles(p); })
      .catch(() => undefined);
  }, [settings.binaryPath]);

  const probe = useCallback(async (): Promise<HermesProviderStatus | null> => {
    try {
      const next = await fetchHermesStatus(
        settings.binaryPath ? { binaryPath: settings.binaryPath } : {},
      );
      if (mountedRef.current) setStatus(next);
      return next;
    } catch (err) {
      if (mountedRef.current) {
        setToast({
          kind: "err",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return null;
    }
  }, [settings.binaryPath]);

  useEffect(() => {
    void probe();
  }, [probe]);

  const buildPayload = useCallback(
    (): Record<string, unknown> => ({
      binaryPath: settings.binaryPath,
      model: settings.model,
      provider: settings.provider,
      maxTurns: settings.maxTurns,
      yolo: settings.yolo,
      cliTimeoutMs: settings.cliTimeoutMs,
      profile: settings.profile,
    }),
    [settings],
  );

  const handleTest = useCallback(async () => {
    setBusy("testing");
    setToast(null);
    const next = await probe();
    if (!mountedRef.current) return;
    setBusy(null);
    if (!next) {
      setToast({ kind: "err", message: "Test failed — see status above." });
    } else if (next.binary.available) {
      setToast({
        kind: "ok",
        message: `✓ hermes detected${next.binary.version ? ` (${next.binary.version})` : ""}${next.binary.binaryPath ? ` at ${next.binary.binaryPath}` : ""}.`,
      });
    } else {
      setToast({
        kind: "err",
        message: `✗ ${next.binary.reason ?? "hermes not found"}`,
      });
    }
  }, [probe]);

  const handleSave = useCallback(async () => {
    setBusy("saving");
    setToast(null);
    try {
      await updatePluginSettings(PLUGIN_ID, buildPayload());
      if (mountedRef.current) setToast({ kind: "ok", message: "Settings saved." });
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
      const next = await probe();
      if (!mountedRef.current) return;
      if (!next) {
        setToast({ kind: "err", message: "Saved, but probe failed." });
      } else if (next.binary.available) {
        setToast({
          kind: "ok",
          message: `Saved · ✓ hermes detected${next.binary.version ? ` (${next.binary.version})` : ""}.`,
        });
      } else {
        setToast({
          kind: "err",
          message: `Saved · ✗ ${next.binary.reason ?? "hermes not found"}`,
        });
      }
    } catch (err) {
      if (mountedRef.current)
        setToast({ kind: "err", message: err instanceof Error ? err.message : String(err) });
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [buildPayload, probe]);

  const binary = status?.binary;
  const statusKind = status === null
    ? "loading"
    : binary?.available
      ? "ok"
      : "err";
  const statusText =
    status === null
      ? "Probing local hermes binary…"
      : binary?.available
        ? `✓ Detected${binary.version ? ` ${binary.version}` : ""}${binary.binaryPath ? ` · ${binary.binaryPath}` : ""}`
        : `✗ ${binary?.reason ?? "not detected on PATH"}`;

  return (
    <RuntimeCardShell
      testId="hermes-runtime-card"
      logo={<ProviderIcon provider="hermes" size="lg" />}
      name="Hermes"
      subname="by Nous Research"
      learnMoreHref={HERMES_LEARN_MORE}
      statusKind={statusKind}
      statusText={statusText}
      description={
        <>
          Drives the local <code>hermes</code> CLI as a subprocess. Each Fusion
          prompt is sent as <code>hermes chat -q …</code>; subsequent prompts
          resume the same hermes session via <code>--resume</code>. Provider,
          model, and skills are configured inside hermes itself; this card
          only chooses overrides.
        </>
      }
      busy={busy}
      toast={toast}
      onTest={() => void handleTest()}
      onSave={() => void handleSave()}
      onSaveAndTest={() => void handleSaveAndTest()}
      belowForm={
        binary?.available === false ? (
          <div className="onboarding-helper-text">
            <p>
              <code>hermes</code> not detected. Install the upstream agent:
            </p>
            <pre>
              <code>pipx install hermes-agent</code>
            </pre>
            <p>
              <a href={HERMES_LEARN_MORE} target="_blank" rel="noreferrer">
                Hermes on GitHub
              </a>
            </p>
          </div>
        ) : null
      }
    >
      <div className="form-group">
        <label htmlFor="hermes-profile">Profile (optional)</label>
        <select
          id="hermes-profile"
          value={settings.profile}
          onChange={(e) => setSettings((s) => ({ ...s, profile: e.target.value }))}
        >
          <option value="">Auto / use Hermes default</option>
          {profiles.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
              {p.model ? ` — ${p.model}` : ""}
              {p.isDefault ? " (default)" : ""}
            </option>
          ))}
        </select>
        <small>
          Select a Hermes profile to use. Activates the profile by setting{" "}
          <code>HERMES_HOME</code> to the profile directory when invoking{" "}
          <code>hermes chat</code>.
        </small>
      </div>

      <div className="form-group">
        <label htmlFor="hermes-binary">Binary path</label>
        <input
          id="hermes-binary"
          type="text"
          placeholder="hermes (defaults to PATH)"
          value={settings.binaryPath}
          onChange={(e) => setSettings((s) => ({ ...s, binaryPath: e.target.value }))}
        />
        <small>
          Leave blank to resolve <code>hermes</code> from your PATH.
        </small>
      </div>

      <div className="form-group">
        <label htmlFor="hermes-model">Model override</label>
        <input
          id="hermes-model"
          type="text"
          placeholder="e.g. claude-sonnet-4-5, MiniMax-M2.7"
          value={settings.model}
          disabled={!!settings.profile}
          onChange={(e) => setSettings((s) => ({ ...s, model: e.target.value }))}
        />
        {settings.profile ? (
          <small>Controlled by profile: <strong>{settings.profile}</strong></small>
        ) : (
          <small>Optional — overrides Hermes's configured default model.</small>
        )}
      </div>

      <div className="form-group">
        <label htmlFor="hermes-provider">Provider</label>
        <select
          id="hermes-provider"
          value={settings.provider}
          disabled={!!settings.profile}
          onChange={(e) => setSettings((s) => ({ ...s, provider: e.target.value }))}
        >
          {HERMES_PROVIDER_OPTIONS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        {settings.profile ? (
          <small>Controlled by profile: <strong>{settings.profile}</strong></small>
        ) : (
          <small>Inference provider Hermes routes calls through (default: <code>auto</code>)).</small>
        )}
      </div>

      <div className="form-group">
        <label htmlFor="hermes-maxTurns">Max turns</label>
        <input
          id="hermes-maxTurns"
          type="number"
          min={1}
          max={500}
          value={settings.maxTurns}
          onChange={(e) =>
            setSettings((s) => ({
              ...s,
              maxTurns: Number(e.target.value) || DEFAULT_SETTINGS.maxTurns,
            }))
          }
        />
        <small>Cap per Hermes turn. Hermes's own default is 90; we cap lower.</small>
      </div>

      <div className="form-group">
        <label
          htmlFor="hermes-yolo"
          style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-xs)" }}
        >
          <input
            id="hermes-yolo"
            type="checkbox"
            checked={settings.yolo}
            onChange={(e) => setSettings((s) => ({ ...s, yolo: e.target.checked }))}
          />
          Auto-approve dangerous tool calls (<code>--yolo</code>)
        </label>
        <small>Required for non-interactive sessions that trigger shell-style tools.</small>
      </div>

      <div className="form-group">
        <label htmlFor="hermes-timeoutMs">CLI hard-kill timeout (ms)</label>
        <input
          id="hermes-timeoutMs"
          type="number"
          min={1000}
          step={1000}
          value={settings.cliTimeoutMs}
          onChange={(e) =>
            setSettings((s) => ({
              ...s,
              cliTimeoutMs: Number(e.target.value) || DEFAULT_SETTINGS.cliTimeoutMs,
            }))
          }
        />
        <small>Fusion-side hard cap. Default 5 min.</small>
      </div>
    </RuntimeCardShell>
  );
}
