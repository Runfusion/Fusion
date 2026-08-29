import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../../api/legacy";
import { SettingsFieldRow } from "../SettingsFieldRow";
import { SettingsToggleRow } from "../SettingsToggleRow";
import type { SectionBaseProps } from "./context";
import "./VoiceInputSection.css";

export const VOICE_STATUS_POLL_INTERVAL_MS = 1_000;
type ModelStatus = "not-installed" | "queued" | "downloading" | "installed" | "error";
type VoiceStatus = {
  model: { status: ModelStatus; progress?: number; errorReason?: string; errorMessage?: string };
  runtime: { status: "available" | "unavailable"; unavailableReason?: string };
};

function isVoiceStatus(value: unknown): value is VoiceStatus {
  if (!value || typeof value !== "object") return false;
  const response = value as { model?: { status?: unknown }; runtime?: { status?: unknown } };
  return ["not-installed", "queued", "downloading", "installed", "error"].includes(String(response.model?.status))
    && ["available", "unavailable"].includes(String(response.runtime?.status));
}

/**
 * FNXC:VoiceInput 2026-07-28-12:00:
 * Voice input is opt-in and the Parakeet v3 download remains operator-managed in
 * Settings. Status polling runs only while a download is active, so progress is
 * live without leaving a background timer after the model reaches a terminal state.
 *
 * Missing sherpa-onnx runtime and indeterminate status fail closed: the stored
 * preference is preserved, but the effective toggle is disabled rather than
 * silently rewriting a preference that may become usable after runtime recovery.
 * Model controls stay in SettingsFieldRow slots to retain the shared settings-row
 * contract instead of introducing a parallel panel or row variant.
 *
 * FNXC:VoiceInput 2026-08-13-23:04:
 * Healthy CommonJS runtimes now self-correct during probing. Re-check remains for
 * residual repair-then-recover cases and refreshes status without enabling voice.
 */
export function VoiceInputSection({ form, setForm }: SectionBaseProps) {
  const { t } = useTranslation("app");
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [statusUnavailable, setStatusUnavailable] = useState(false);
  const [recheckingRuntime, setRecheckingRuntime] = useState(false);
  const mounted = useRef(true);

  const loadStatus = useCallback(async () => {
    try {
      const response = await api<unknown>("/voice/status");
      if (!isVoiceStatus(response)) throw new Error("invalid voice status");
      if (mounted.current) {
        setStatus(response);
        setStatusUnavailable(false);
      }
    } catch {
      if (mounted.current) {
        setStatus(null);
        setStatusUnavailable(true);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void loadStatus();
    return () => { mounted.current = false; };
  }, [loadStatus]);

  const modelStatus = status?.model.status;
  useEffect(() => {
    if (modelStatus !== "downloading" && modelStatus !== "queued") return;
    const interval = window.setInterval(() => { void loadStatus(); }, VOICE_STATUS_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [loadStatus, modelStatus]);

  const downloading = modelStatus === "downloading" || modelStatus === "queued";
  const progress = status?.model.progress;
  const statusLoading = status === null && !statusUnavailable;
  const modelReady = modelStatus === "installed";
  const runtimeUnavailable = status?.runtime.status === "unavailable";
  const unavailable = statusLoading || statusUnavailable || !modelReady || runtimeUnavailable;
  const storedEnabled = form.voiceInput?.enabled === true;
  const effectiveEnabled = storedEnabled && !unavailable;
  const runtimeReason = status?.runtime.unavailableReason;
  const unavailableMessage = statusUnavailable
    ? t("settings.voiceInput.statusUnavailable", "Voice runtime status could not be determined; voice mode stays disabled.")
    : !modelReady
      ? (downloading
        ? t("settings.voiceInput.modelPreparing", "Voice input becomes available after the model installation finishes.")
        : modelStatus === "error"
          ? t("settings.voiceInput.modelFailed", "Fix or retry the model installation before enabling voice input.")
          : t("settings.voiceInput.modelRequired", "Download the Parakeet model before enabling voice input."))
      : runtimeReason === "runtime-module-missing"
        ? t("settings.voiceInput.runtimeModuleMissing", "Install a Fusion release that includes the optional voice runtime, then reopen Settings.")
        : runtimeReason === "runtime-platform-load-failed"
          ? t("settings.voiceInput.runtimePlatformLoadFailed", "Reinstall Fusion for this platform so the optional voice runtime can load.")
          : runtimeReason === "runtime-incompatible"
            ? t("settings.voiceInput.runtimeIncompatible", "Update or reinstall Fusion because the installed voice runtime is incompatible.")
            : t("settings.voiceInput.runtimeUnavailable", storedEnabled
              ? "Voice mode is inactive because the sherpa-onnx runtime is unavailable. Your saved preference remains on."
              : "The sherpa-onnx runtime is unavailable, so voice mode stays disabled.");

  const performModelAction = async (path: string, method: "POST" | "DELETE") => {
    try { await api(path, { method }); } finally { await loadStatus(); }
  };
  const performRuntimeRecheck = async () => {
    setRecheckingRuntime(true);
    try { await api("/voice/runtime/recheck", { method: "POST" }); } catch {} finally {
      await loadStatus();
      if (mounted.current) setRecheckingRuntime(false);
    }
  };
  return <section className="voice-input-section" data-testid="voice-input-section">
    <h4 className="settings-section-heading">{t("settings.voiceInput.title", "Voice Input")}</h4>
    <div data-effective-enabled={effectiveEnabled ? "true" : "false"}>
      <SettingsToggleRow
        descriptor={{
          key: "voiceInput.enabled",
          label: t("settings.voiceInput.enable", "Enable voice input"),
          help: t("settings.voiceInput.enableHelp", "Default: off. Voice dictation uses the operator-managed Parakeet v3 model."),
          scope: "project",
          disabled: unavailable,
        }}
        value={effectiveEnabled}
        onChange={(enabled) => setForm((current) => ({ ...current, voiceInput: { ...(current.voiceInput ?? {}), enabled: enabled === true } }))}
      />
    </div>
    {!statusLoading && unavailable && <p className="voice-input-section__message" role="alert" data-testid={statusUnavailable ? "voice-input-status-unavailable" : "voice-input-runtime-unavailable"}>{unavailableMessage}</p>}
    <SettingsFieldRow
      label={t("settings.voiceInput.modelStatus", "Parakeet v3 model status")}
      help={t("settings.voiceInput.modelStatusHelp", "The speech model is installed and managed locally on this device.")}
      scope="project"
    >
      <span className={`voice-input-section__status voice-input-section__status--${modelStatus ?? "unknown"}`} data-testid="voice-input-model-status">
        {statusUnavailable ? t("settings.voiceInput.unknown", "Status unavailable")
          : downloading ? (typeof progress === "number" ? t("settings.voiceInput.downloadingProgress", "Downloading: {{progress}}%", { progress: Math.round(progress * 100) }) : t("settings.voiceInput.downloading", "Downloading model…"))
            : modelStatus === "installed" ? t("settings.voiceInput.installed", "Installed")
              : modelStatus === "error" ? t("settings.voiceInput.error", "Model error: {{message}}", { message: status?.model.errorMessage ?? status?.model.errorReason ?? "Unknown error" })
                : t("settings.voiceInput.notInstalled", "Not installed")}
      </span>
    </SettingsFieldRow>
    <SettingsFieldRow
      label={t("settings.voiceInput.modelActions", "Model management")}
      help={t("settings.voiceInput.modelActionsHelp", "Download or remove the Parakeet v3 speech model.")}
      scope="project"
    >
      <div className="voice-input-section__actions" data-testid="voice-input-model-actions">
        {!statusUnavailable && (modelStatus === "not-installed" || modelStatus === "error") && <button type="button" className="btn btn-secondary" onClick={() => void performModelAction("/voice/model/download", "POST")}>{t("settings.voiceInput.download", "Download")}</button>}
        {!statusUnavailable && modelStatus === "installed" && <button type="button" className="btn btn-secondary" onClick={() => void performModelAction("/voice/model", "DELETE")}>{t("settings.voiceInput.remove", "Remove")}</button>}
        {!statusUnavailable && modelReady && runtimeUnavailable && <button type="button" className="btn btn-secondary" disabled={recheckingRuntime} onClick={() => void performRuntimeRecheck()}>{t(recheckingRuntime ? "settings.voiceInput.recheckingRuntime" : "settings.voiceInput.recheckRuntime", recheckingRuntime ? "Re-checking runtime…" : "Re-check runtime")}</button>}
      </div>
    </SettingsFieldRow>
  </section>;
}

export default VoiceInputSection;
