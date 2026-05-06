import { useEffect, useMemo, useState } from "react";
import type { FusionShellApi, ShellConnectionState } from "../types/native-shell";
import "./NativeShellOnboardingModal.css";

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
  const [mode, setMode] = useState<"local" | "remote">(shellState.desktopMode ?? "remote");
  const [name, setName] = useState("Remote Server");
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
    <div className="modal-overlay open">
      <div className="modal native-shell-onboarding-modal">
        <div className="modal-header">
          <h2>Welcome to Fusion</h2>
        </div>
        <div className="native-shell-onboarding-body">
          <p>Fusion helps you plan, run, and review AI-assisted engineering work.</p>
          {isDesktop && (
            <div className="native-shell-onboarding-mode-row">
              <button type="button" className={`btn ${mode === "local" ? "btn-primary" : ""}`} onClick={() => setMode("local")}>Local Fusion</button>
              <button type="button" className={`btn ${mode === "remote" ? "btn-primary" : ""}`} onClick={() => setMode("remote")}>Remote Server</button>
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
                {scanning ? "Scanning…" : "Scan QR"}
              </button>
              <label className="native-shell-onboarding-label" htmlFor="native-shell-onboarding-profile-name">Profile name</label>
              <input id="native-shell-onboarding-profile-name" className="input" value={name} onChange={(event) => setName(event.target.value)} />
              <label className="native-shell-onboarding-label" htmlFor="native-shell-onboarding-server-url">Server URL</label>
              <input id="native-shell-onboarding-server-url" className="input" value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="https://your-fusion-host" />
              <label className="native-shell-onboarding-label" htmlFor="native-shell-onboarding-auth-token">Auth token (optional)</label>
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
                  name: name.trim() || "Remote Server",
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
            {submitting ? "Saving…" : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}
