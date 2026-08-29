import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  fetchHermesProfiles,
  fetchHermesStatus,
  fetchPluginSettings,
  fetchPlugins,
  updatePluginSettings,
  type HermesProfileSummary,
  type HermesProviderStatus,
} from "../api";
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
  const { t } = useTranslation("app");
  const [settings, setSettings] = useState<HermesSettings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<HermesProviderStatus | null>(null);
  const [profiles, setProfiles] = useState<HermesProfileSummary[]>([]);
  const [busy, setBusy] = useState<"loading" | "saving" | "testing" | "save-test" | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; message: string } | null>(null);
  /*
   * FNXC:PluginManager 2026-07-07-00:00:
   * FN-7629 — Plugin Manager is the source of truth for the runtime's enable/disable decision.
   * This card must not claim Hermes is active/detected when the user has disabled it there, so
   * mirror the installed project-state (not the local settings form) and override the status
   * badge when disabled.
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
      setToast({ kind: "err", message: t("hermes.testFailed", "Test failed — see status above.") });
    } else if (next.binary.available) {
      setToast({
        kind: "ok",
        message: t("hermes.detected", "✓ hermes detected{{version}}{{path}}.", { version: next.binary.version ? ` (${next.binary.version})` : "", path: next.binary.binaryPath ? ` at ${next.binary.binaryPath}` : "" }),
      });
    } else {
      setToast({
        kind: "err",
        message: t("hermes.notFound", "✗ {{reason}}", { reason: next.binary.reason ?? "hermes not found" }),
      });
    }
  }, [probe, t]);

  const handleSave = useCallback(async () => {
    setBusy("saving");
    setToast(null);
    try {
      await updatePluginSettings(PLUGIN_ID, buildPayload());
      if (mountedRef.current) setToast({ kind: "ok", message: t("hermes.settingsSaved", "Settings saved.") });
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
        setToast({ kind: "err", message: t("hermes.savedProbeFailed", "Saved, but probe failed.") });
      } else if (next.binary.available) {
        setToast({
          kind: "ok",
          message: t("hermes.savedDetected", "Saved · ✓ hermes detected{{version}}.", { version: next.binary.version ? ` (${next.binary.version})` : "" }),
        });
      } else {
        setToast({
          kind: "err",
          message: t("hermes.savedNotFound", "Saved · ✗ {{reason}}", { reason: next.binary.reason ?? "hermes not found" }),
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
    : status === null
      ? "loading"
      : binary?.available
        ? "ok"
        : "err";
  const statusText = runtimeDisabled
    ? t("hermes.statusDisabledInPluginManager", "Disabled in Plugin Manager")
    : status === null
      ? t("hermes.probing", "Probing local hermes binary…")
      : binary?.available
        ? t("hermes.statusDetected", "✓ Detected{{version}}{{path}}", { version: binary.version ? ` ${binary.version}` : "", path: binary.binaryPath ? ` · ${binary.binaryPath}` : "" })
        : t("hermes.statusNotDetected", "✗ {{reason}}", { reason: binary?.reason ?? "not detected on PATH" });

  return (
    <RuntimeCardShell
      testId="hermes-runtime-card"
      logo={
        <span
          style={{
            width: 40,
            height: 40,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: "50%",
            background: "#fff",
          }}
        >
          <img
            src="/brands/hermes-logo.svg"
            alt={t("runtimes.nousResearchLogoAlt", "Nous Research")}
            style={{
              width: 28,
              height: 28,
              display: "block",
              filter: "invert(1) brightness(0)",
            }}
          />
        </span>
      }
      name="Hermes"
      subname={t("hermes.subname", "by Nous Research")}
      learnMoreHref={HERMES_LEARN_MORE}
      statusKind={statusKind}
      statusText={statusText}
      description={
        <>
          {t("hermes.description", "Drives the local {{cmd}} CLI as a subprocess. Each Fusion prompt is sent as {{chatCmd}}; subsequent prompts resume the same hermes session via {{resumeFlag}}. Provider, model, and skills are configured inside hermes itself; this card only chooses overrides.", { cmd: "hermes", chatCmd: "hermes chat -q …", resumeFlag: "--resume" })}
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
              {t("hermes.notDetected", "{{cmd}} not detected. Install the upstream agent:", { cmd: "hermes" })}
            </p>
            <pre>
              <code>pipx install hermes-agent</code>
            </pre>
            <p>
              <a href={HERMES_LEARN_MORE} target="_blank" rel="noreferrer">
                {t("hermes.gitHubLink", "Hermes on GitHub")}
              </a>
            </p>
          </div>
        ) : null
      }
    >
      <div className="form-group">
        <label htmlFor="hermes-profile">{t("hermes.profileLabel", "Profile (optional)")}</label>
        <select
          id="hermes-profile"
          value={settings.profile}
          onChange={(e) => setSettings((s) => ({ ...s, profile: e.target.value }))}
        >
          <option value="">{t("hermes.autoProfile", "Auto / use Hermes default")}</option>
          {profiles.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
              {p.model ? t("hermes.profileModelSeparator", " — {{model}}", { model: p.model }) : ""}
              {p.isDefault ? t("hermes.defaultProfile", " (default)") : ""}
            </option>
          ))}
        </select>
        <small>
          {t("hermes.profileHelp", "Select a Hermes profile to use. Activates the profile by setting {{env}} to the profile directory when invoking {{cmd}}.", { env: "HERMES_HOME", cmd: "hermes chat" })}
        </small>
      </div>

      <div className="form-group">
        <label htmlFor="hermes-binary">{t("hermes.binaryPathLabel", "Binary path")}</label>
        <input
          id="hermes-binary"
          type="text"
          placeholder={t("hermes.binaryPathPlaceholder", "hermes (defaults to PATH)")}
          value={settings.binaryPath}
          onChange={(e) => setSettings((s) => ({ ...s, binaryPath: e.target.value }))}
        />
        <small>
          {t("hermes.binaryPathHelp", "Leave blank to resolve {{cmd}} from your PATH.", { cmd: "hermes" })}
        </small>
      </div>

      <div className="form-group">
        <label htmlFor="hermes-model">{t("hermes.modelLabel", "Model override")}</label>
        <input
          id="hermes-model"
          type="text"
          placeholder={t("hermes.modelPlaceholder", "e.g. claude-sonnet-4-5, MiniMax-M3")}
          value={settings.model}
          disabled={!!settings.profile}
          onChange={(e) => setSettings((s) => ({ ...s, model: e.target.value }))}
        />
        {settings.profile ? (
          <small>{t("hermes.modelControlled", "Controlled by profile: {{profile}}", { profile: settings.profile })}</small>
        ) : (
          <small>{t("hermes.modelHelp", "Optional — overrides Hermes's configured default model.")}</small>
        )}
      </div>

      <div className="form-group">
        <label htmlFor="hermes-provider">{t("hermes.providerLabel", "Provider")}</label>
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
          <small>{t("hermes.providerControlled", "Controlled by profile: {{profile}}", { profile: settings.profile })}</small>
        ) : (
          <small>{t("hermes.providerHelp", "Inference provider Hermes routes calls through (default: {{default}}).", { default: "auto" })}</small>
        )}
      </div>

      <div className="form-group">
        <label htmlFor="hermes-maxTurns">{t("hermes.maxTurnsLabel", "Max turns")}</label>
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
        <small>{t("hermes.maxTurnsHelp", "Cap per Hermes turn. Hermes's own default is 90; we cap lower.")}</small>
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
          {t("hermes.yoloLabel", "Auto-approve dangerous tool calls ({{flag}})", { flag: "--yolo" })}
        </label>
        <small>{t("hermes.yoloHelp", "Required for non-interactive sessions that trigger shell-style tools.")}</small>
      </div>

      <div className="form-group">
        <label htmlFor="hermes-timeoutMs">{t("hermes.timeoutLabel", "CLI hard-kill timeout (ms)")}</label>
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
        <small>{t("hermes.timeoutHelp", "Fusion-side hard cap. Default 5 min.")}</small>
      </div>
    </RuntimeCardShell>
  );
}
