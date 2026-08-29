import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import {
  fetchOpenClawStatus,
  fetchPluginSettings,
  fetchPlugins,
  updatePluginSettings,
  type OpenClawProviderStatus,
} from "../api";
import { ProviderIcon } from "./ProviderIcon";
import { RuntimeCardShell } from "./RuntimeCardShell";

const PLUGIN_ID = "fusion-plugin-openclaw-runtime";
const OPENCLAW_LEARN_MORE = "https://docs.openclaw.ai/";
const OPENCLAW_GITHUB = "https://github.com/openclaw/openclaw";

type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "adaptive"
  | "max";

const THINKING_LEVEL_OPTIONS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "adaptive",
  "max",
];

interface OpenClawSettings {
  binaryPath: string;
  agentId: string;
  model: string;
  thinking: ThinkingLevel;
  useGateway: boolean;
  cliTimeoutSec: number;
  cliTimeoutMs: number;
}

const DEFAULT_SETTINGS: OpenClawSettings = {
  binaryPath: "",
  agentId: "main",
  model: "",
  thinking: "off",
  useGateway: false,
  cliTimeoutSec: 0,
  cliTimeoutMs: 300_000,
};

function settingsFromRecord(raw: Record<string, unknown>): OpenClawSettings {
  return {
    binaryPath:
      typeof raw.binaryPath === "string" ? raw.binaryPath : DEFAULT_SETTINGS.binaryPath,
    agentId:
      typeof raw.agentId === "string" ? raw.agentId : DEFAULT_SETTINGS.agentId,
    model: typeof raw.model === "string" ? raw.model : DEFAULT_SETTINGS.model,
    thinking: (THINKING_LEVEL_OPTIONS as string[]).includes(raw.thinking as string)
      ? (raw.thinking as ThinkingLevel)
      : DEFAULT_SETTINGS.thinking,
    useGateway:
      typeof raw.useGateway === "boolean" ? raw.useGateway : DEFAULT_SETTINGS.useGateway,
    cliTimeoutSec:
      typeof raw.cliTimeoutSec === "number"
        ? raw.cliTimeoutSec
        : DEFAULT_SETTINGS.cliTimeoutSec,
    cliTimeoutMs:
      typeof raw.cliTimeoutMs === "number"
        ? raw.cliTimeoutMs
        : DEFAULT_SETTINGS.cliTimeoutMs,
  };
}

export function OpenClawRuntimeCard() {
  const { t } = useTranslation("app");
  const [settings, setSettings] = useState<OpenClawSettings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<OpenClawProviderStatus | null>(null);
  const [busy, setBusy] = useState<"loading" | "saving" | "testing" | "save-test" | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; message: string } | null>(null);
  /*
   * FNXC:PluginManager 2026-07-07-00:00:
   * FN-7629 — Plugin Manager is the source of truth for the runtime's enable/disable decision.
   * Mirror the installed project-state so this card never claims OpenClaw is active/detected when
   * the user has disabled it there.
   */
  const [runtimeDisabled, setRuntimeDisabled] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchPlugins()
      .then((list) => {
        if (cancelled) return;
        const installed = list.find((p) => p.id === PLUGIN_ID);
        setRuntimeDisabled(installed ? !installed.enabled : false);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Load saved settings on mount.
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

  const probe = useCallback(async (): Promise<OpenClawProviderStatus | null> => {
    try {
      const next = await fetchOpenClawStatus(
        settings.binaryPath ? { binaryPath: settings.binaryPath } : undefined,
      );
      if (mountedRef.current) setStatus(next);
      return next;
    } catch (err) {
      if (mountedRef.current)
        setToast({ kind: "err", message: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }, [settings.binaryPath]);

  // Initial probe.
  useEffect(() => {
    void probe();
  }, [probe]);

  const buildPayload = useCallback(
    (): Record<string, unknown> => ({
      binaryPath: settings.binaryPath,
      agentId: settings.agentId,
      model: settings.model,
      thinking: settings.thinking,
      useGateway: settings.useGateway,
      cliTimeoutSec: settings.cliTimeoutSec,
      cliTimeoutMs: settings.cliTimeoutMs,
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
      setToast({ kind: "err", message: t("openclaw.testFailed", "Test failed — see status above.") });
    } else if (next.binary.available) {
      setToast({
        kind: "ok",
        message: t("openclaw.detected", `✓ openclaw detected{{version}}{{path}}.`, { version: next.binary.version ? ` (${next.binary.version})` : "", path: next.binary.binaryPath ? ` at ${next.binary.binaryPath}` : "" }),
      });
    } else {
      setToast({
        kind: "err",
        message: t("openclaw.notFound", `✗ ${next.binary.reason ?? "openclaw not found"}`),
      });
    }
  }, [probe, t]);

  const handleSave = useCallback(async () => {
    setBusy("saving");
    setToast(null);
    try {
      await updatePluginSettings(PLUGIN_ID, buildPayload());
      if (mountedRef.current) setToast({ kind: "ok", message: t("openclaw.saved", "Settings saved.") });
    } catch (err) {
      if (mountedRef.current)
        setToast({ kind: "err", message: err instanceof Error ? err.message : String(err) });
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [buildPayload, t]);

  const handleSaveAndTest = useCallback(async () => {
    setBusy("save-test");
    setToast(null);
    try {
      await updatePluginSettings(PLUGIN_ID, buildPayload());
      const next = await probe();
      if (!mountedRef.current) return;
      if (!next) {
        setToast({ kind: "err", message: t("openclaw.savedProbeFailed", "Saved, but probe failed.") });
      } else if (next.binary.available) {
        setToast({
          kind: "ok",
          message: t("openclaw.savedDetected", `Saved · ✓ openclaw detected{{version}}{{path}}.`, { version: next.binary.version ? ` (${next.binary.version})` : "", path: next.binary.binaryPath ? ` at ${next.binary.binaryPath}` : "" }),
        });
      } else {
        setToast({
          kind: "err",
          message: t("openclaw.savedNotFound", `Saved · ✗ ${next.binary.reason ?? "openclaw not found"}`),
        });
      }
    } catch (err) {
      if (mountedRef.current)
        setToast({ kind: "err", message: err instanceof Error ? err.message : String(err) });
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [buildPayload, probe, t]);

  const binary = status?.binary;
  const statusKind = runtimeDisabled
    ? "neutral"
    : status === null ? "loading" : binary?.available ? "ok" : "err";
  const statusText = runtimeDisabled
    ? t("openclaw.statusDisabledInPluginManager", "Disabled in Plugin Manager")
    : status === null
      ? t("openclaw.probing", "Probing local openclaw binary…")
      : binary?.available
        ? t("openclaw.statusDetected", `✓ Detected{{version}}{{path}}`, { version: binary.version ? ` ${binary.version}` : "", path: binary.binaryPath ? ` · ${binary.binaryPath}` : "" })
        : t("openclaw.statusNotFound", `✗ ${binary?.reason ?? "not detected on PATH"}`);

  return (
    <RuntimeCardShell
      testId="openclaw-runtime-card"
      logo={<ProviderIcon provider="openclaw" size="lg" />}
      name="OpenClaw"
      learnMoreHref={OPENCLAW_LEARN_MORE}
      statusKind={statusKind}
      statusText={statusText}
      description={
        <Trans
          i18nKey="app:openclaw.description"
          defaults="Drives the local <code1>openclaw</code1> CLI as a subprocess. Each Fusion prompt is dispatched via <code2>openclaw agent --local --json</code2>; the agent definition, model, and thinking level are resolved by OpenClaw. This card only sets overrides and the binary path."
          components={{ code1: <code />, code2: <code /> }}
        />
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
              <Trans
                i18nKey="app:openclaw.notDetectedInstall"
                defaults="<code>openclaw</code> not detected. Install the upstream agent:"
                components={{ code: <code /> }}
              />
            </p>
            <pre>
              <code>npm install -g openclaw</code>
            </pre>
            <p>
              <a href={OPENCLAW_GITHUB} target="_blank" rel="noreferrer">
                {t("openclaw.githubLink", "openclaw on GitHub")}
              </a>
            </p>
          </div>
        ) : null
      }
    >
      <div className="form-group">
        <label htmlFor="openclaw-binaryPath">{t("openclaw.binaryPath", "Binary path")}</label>
        <input
          id="openclaw-binaryPath"
          type="text"
          placeholder={t("openclaw.binaryPathPlaceholder", "openclaw (defaults to PATH)")}
          value={settings.binaryPath}
          onChange={(e) => setSettings((s) => ({ ...s, binaryPath: e.target.value }))}
        />
        <small>{t("openclaw.binaryPathHint", "Leave blank to resolve openclaw from your PATH.")}</small>
      </div>

      <div className="form-group">
        <label htmlFor="openclaw-agentId">{t("openclaw.agentId", "Agent ID")}</label>
        <input
          id="openclaw-agentId"
          type="text"
          placeholder={t("openclaw.agentIdPlaceholder", "main")}
          value={settings.agentId}
          onChange={(e) => setSettings((s) => ({ ...s, agentId: e.target.value }))}
        />
        <small>{t("openclaw.agentIdHint", "OpenClaw agent definition to run (default: main).")}</small>
      </div>

      <div className="form-group">
        <label htmlFor="openclaw-model">{t("openclaw.model", "Model override")}</label>
        <input
          id="openclaw-model"
          type="text"
          placeholder={t("openclaw.modelPlaceholder", "e.g. anthropic/claude-haiku-4-5, minimax/MiniMax-M3")}
          value={settings.model}
          onChange={(e) => setSettings((s) => ({ ...s, model: e.target.value }))}
        />
        <small>{t("openclaw.modelHint", "Optional — overrides the OpenClaw default model.")}</small>
      </div>

      <div className="form-group">
        <label htmlFor="openclaw-thinking">{t("openclaw.thinking", "Thinking level")}</label>
        <select
          id="openclaw-thinking"
          value={settings.thinking}
          onChange={(e) =>
            setSettings((s) => ({ ...s, thinking: e.target.value as ThinkingLevel }))
          }
        >
          {THINKING_LEVEL_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
        <small>{t("openclaw.thinkingHint", "Controls how much extended thinking the model uses.")}</small>
      </div>

      <div className="form-group">
        <label
          htmlFor="openclaw-useGateway"
          style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-xs)" }}
        >
          <input
            id="openclaw-useGateway"
            type="checkbox"
            checked={settings.useGateway}
            onChange={(e) => setSettings((s) => ({ ...s, useGateway: e.target.checked }))}
          />
          {t("openclaw.gateway", "Route through OpenClaw gateway (otherwise embedded)")}
        </label>
        <small>{t("openclaw.gatewayHint", "When enabled, calls pass through the OpenClaw gateway service.")}</small>
      </div>

      <div className="form-group">
        <label htmlFor="openclaw-cliTimeoutSec">{t("openclaw.cliTimeout", "OpenClaw timeout (sec)")}</label>
        <input
          id="openclaw-cliTimeoutSec"
          type="number"
          min={0}
          step={1}
          value={settings.cliTimeoutSec}
          onChange={(e) =>
            setSettings((s) => ({
              ...s,
              cliTimeoutSec: parseInt(e.target.value, 10) || 0,
            }))
          }
        />
        <small>{t("openclaw.cliTimeoutHint", "OpenClaw-side run timeout in seconds (0 = no timeout).")}</small>
      </div>

      <div className="form-group">
        <label htmlFor="openclaw-cliTimeoutMs">{t("openclaw.subprocess", "CLI subprocess timeout (ms)")}</label>
        <input
          id="openclaw-cliTimeoutMs"
          type="number"
          min={0}
          step={1000}
          value={settings.cliTimeoutMs}
          onChange={(e) =>
            setSettings((s) => ({
              ...s,
              cliTimeoutMs:
                parseInt(e.target.value, 10) || DEFAULT_SETTINGS.cliTimeoutMs,
            }))
          }
        />
        <small>
          {t("openclaw.subprocessHint", "Fusion-side hard cap before the CLI subprocess is killed (default: {{default}}s).", { default: DEFAULT_SETTINGS.cliTimeoutMs / 1000 })}
        </small>
      </div>
    </RuntimeCardShell>
  );
}
