import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FusionShellApi, ShellConnectionState } from "../types/native-shell";
import "./NativeShellOnboardingModal.css";
import { FloatingWindow } from "./FloatingWindow";

function buildRemoteDashboardUrl(serverUrl: string, authToken?: string | null): string {
  const url = new URL(serverUrl);
  if (authToken) {
    url.searchParams.set("rt", authToken);
  }
  return url.toString();
}

interface NativeShellOnboardingModalProps {
  open: boolean;
  shellApi: FusionShellApi;
  shellState: ShellConnectionState;
  onComplete: () => void;
}

export function NativeShellOnboardingModal({ open, shellApi, shellState, onComplete }: NativeShellOnboardingModalProps) {
  const { t } = useTranslation("app");
  const [mode, setMode] = useState<"local" | "remote">(shellState.desktopMode ?? "remote");
  const [name, setName] = useState(t("onboarding.defaultName", "Remote Server"));
  const [serverUrl, setServerUrl] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const isDesktop = shellState.host === "desktop-shell";

  useEffect(() => {
    if (isDesktop) {
      setMode(shellState.desktopMode ?? "remote");
    }
  }, [isDesktop, shellState.desktopMode]);
  const canSubmit = useMemo(() => {
    if (isDesktop && mode === "local") return true;
    return serverUrl.trim().length > 0;
  }, [isDesktop, mode, serverUrl]);

  if (!open) {
    return null;
  }

  return (
    <FloatingWindow windowKey="native-shell-onboarding" modal title={t("onboarding.welcome", "Welcome to Fusion")} ariaLabel={t("onboarding.welcome", "Welcome to Fusion")} onClose={() => {}} hideHeader dragHandleSelector=".native-shell-onboarding-modal .modal-header" className="floating-window--native-shell-onboarding" defaultSize={{ width: 640, height: 560 }} minSize={{ width: 400, height: 320 }} persistGeometryKey="floating-window:native-shell-onboarding" suspendGeometryPersistenceOnMobile suspendGeometryPersistenceOnShortViewport>
      {/* FNXC:ModalTouchGeometry 2026-07-26-16:22: Connection onboarding is blocking, so its shared geometry deliberately has no outside or Escape dismissal. */}
      <div className="modal native-shell-onboarding-modal">
        <div className="modal-header">
          <h2>{t("onboarding.welcome", "Welcome to Fusion")}</h2>
        </div>
        <div className="native-shell-onboarding-body">
          <p>{t("onboarding.description", "Fusion helps you plan, run, and review AI-assisted engineering work.")}</p>
          {isDesktop && (
            <div className="native-shell-onboarding-mode-row">
              <button type="button" className={`btn ${mode === "local" ? "btn-primary" : ""}`} onClick={() => setMode("local")}>{t("onboarding.localFusion", "Local Fusion")}</button>
              <button type="button" className={`btn ${mode === "remote" ? "btn-primary" : ""}`} onClick={() => setMode("remote")}>{t("onboarding.remoteServer", "Remote Server")}</button>
            </div>
          )}
          {(!isDesktop || mode === "remote") && (
            <>
              <button
                type="button"
                className="btn"
                onClick={async () => {
                  setError(null);
                  setScanning(true);
                  try {
                    const result = await shellApi.startQrScan();
                    setServerUrl(result.serverUrl);
                    setAuthToken(result.authToken ?? "");
                  } catch (scanError) {
                    setError((scanError as Error).message);
                  } finally {
                    setScanning(false);
                  }
                }}
                disabled={scanning}
              >
                {scanning ? t("onboarding.scanning", "Scanning…") : t("onboarding.scanQr", "Scan QR")}
              </button>
              <label className="native-shell-onboarding-label" htmlFor="native-shell-onboarding-profile-name">{t("onboarding.profileName", "Profile name")}</label>
              <input id="native-shell-onboarding-profile-name" className="input" value={name} onChange={(event) => setName(event.target.value)} />
              <label className="native-shell-onboarding-label" htmlFor="native-shell-onboarding-server-url">{t("onboarding.serverUrl", "Server URL")}</label>
              <input id="native-shell-onboarding-server-url" className="input" value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder={t("onboarding.serverUrlPlaceholder", "https://your-fusion-host")} />
              <label className="native-shell-onboarding-label" htmlFor="native-shell-onboarding-auth-token">{t("onboarding.authToken", "Auth token (optional)")}</label>
              <input id="native-shell-onboarding-auth-token" className="input" type="password" value={authToken} onChange={(event) => setAuthToken(event.target.value)} />
            </>
          )}
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <div className="modal-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canSubmit || submitting}
            onClick={async () => {
              setError(null);
              setSubmitting(true);
              try {
                if (isDesktop && mode === "local") {
                  await shellApi.setDesktopMode("local");
                  onComplete();
                  return;
                }

                const saved = await shellApi.saveProfile({
                  name: name.trim() || t("onboarding.defaultName", "Remote Server"),
                  serverUrl,
                  authToken: authToken || null,
                });

                if (isDesktop) {
                  await shellApi.setDesktopMode("remote");
                }
                await shellApi.setActiveProfile(saved.id);

                if (typeof window !== "undefined" && shellState.host !== "web") {
                  window.location.href = buildRemoteDashboardUrl(saved.serverUrl, saved.authToken ?? null);
                  return;
                }

                onComplete();
              } catch (submitError) {
                setError((submitError as Error).message);
              } finally {
                setSubmitting(false);
              }
            }}
          >
            {submitting ? t("onboarding.saving", "Saving…") : t("onboarding.continue", "Continue")}
          </button>
        </div>
      </div>
    </FloatingWindow>
  );
}
