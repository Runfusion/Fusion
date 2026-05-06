import { useMemo, useState } from "react";
import type { FusionShellApi, ShellConnectionProfile, ShellConnectionState } from "../types/native-shell";
import "./NativeShellConnectionManager.css";

interface NativeShellConnectionManagerProps {
  open: boolean;
  shellApi: FusionShellApi;
  shellState: ShellConnectionState;
  onClose: () => void;
}

export function NativeShellConnectionManager({ open, shellApi, shellState, onClose }: NativeShellConnectionManagerProps) {
  const activeProfile = useMemo(
    () => shellState.profiles.find((profile) => profile.id === shellState.activeProfileId) ?? null,
    [shellState.activeProfileId, shellState.profiles],
  );
  const [draft, setDraft] = useState<Partial<ShellConnectionProfile>>({});
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const workingName = draft.name ?? activeProfile?.name ?? "";
  const workingUrl = draft.serverUrl ?? activeProfile?.serverUrl ?? "";
  const workingToken = draft.authToken ?? activeProfile?.authToken ?? "";

  const saveCurrent = async () => {
    setError(null);
    try {
      // Early validation for user feedback before bridge persistence rejects.
      const parsed = new URL(workingUrl.trim());
      if (!/^https?:$/.test(parsed.protocol)) {
        throw new Error("Server URL must use http or https");
      }
      const saved = await shellApi.saveProfile({
        id: activeProfile?.id,
        name: workingName || "Remote Server",
        serverUrl: workingUrl,
        authToken: workingToken || null,
      });
      await shellApi.setActiveProfile(saved.id);
      setDraft({});
    } catch (nextError) {
      setError((nextError as Error).message);
    }
  };

  return (
    <div className="modal-overlay open">
      <div className="modal native-shell-connection-manager" role="dialog" aria-label="Connection Manager">
        <div className="modal-header">
          <h2>Connection Manager</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {shellState.host === "desktop-shell" && (
          <div className="native-shell-connection-manager__mode-row">
            <button type="button" className={`btn ${shellState.desktopMode === "local" ? "btn-primary" : ""}`} onClick={() => void shellApi.setDesktopMode("local")}>Local</button>
            <button type="button" className={`btn ${shellState.desktopMode !== "local" ? "btn-primary" : ""}`} onClick={() => void shellApi.setDesktopMode("remote")}>Remote</button>
          </div>
        )}

        <div className="native-shell-connection-manager__profiles">
          {shellState.profiles.map((profile) => (
            <div className="card native-shell-connection-manager__profile" key={profile.id}>
              <div>
                <strong>{profile.name}</strong>
                <div className="settings-muted">{profile.serverUrl}</div>
              </div>
              <div className="native-shell-connection-manager__profile-actions">
                <button type="button" className="btn btn-sm" aria-label={`Edit ${profile.name}`} onClick={() => setDraft(profile)}>Edit</button>
                <button type="button" className="btn btn-sm" aria-label={`Use ${profile.name}`} onClick={() => void shellApi.setActiveProfile(profile.id)}>Use</button>
                <button type="button" className="btn btn-sm btn-danger" aria-label={`Delete ${profile.name}`} onClick={() => void shellApi.deleteProfile(profile.id)}>Delete</button>
              </div>
            </div>
          ))}
        </div>

        <div className="form-group native-shell-connection-manager__editor">
          <label htmlFor="native-shell-connection-manager-name">Name</label>
          <input id="native-shell-connection-manager-name" className="input" value={workingName} onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))} />
          <label htmlFor="native-shell-connection-manager-url">Server URL</label>
          <input id="native-shell-connection-manager-url" className="input" value={workingUrl} onChange={(event) => setDraft((value) => ({ ...value, serverUrl: event.target.value }))} />
          <label htmlFor="native-shell-connection-manager-token">Auth token (optional)</label>
          <input id="native-shell-connection-manager-token" className="input" type="password" value={workingToken ?? ""} onChange={(event) => setDraft((value) => ({ ...value, authToken: event.target.value }))} />
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Close</button>
          <button type="button" className="btn btn-primary" onClick={() => void saveCurrent()} disabled={!workingUrl.trim()}>Save</button>
        </div>
      </div>
    </div>
  );
}
