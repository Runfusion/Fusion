import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FusionShellApi, ShellConnectionProfile, ShellConnectionState } from "../types/native-shell";
import "./NativeShellConnectionManager.css";

interface NativeShellConnectionManagerProps {
  open: boolean;
  shellApi: FusionShellApi;
  shellState: ShellConnectionState;
  onClose: () => void;
}

export function NativeShellConnectionManager({ open, shellApi, shellState, onClose }: NativeShellConnectionManagerProps) {
  const { t } = useTranslation("app");
  const activeProfile = useMemo(
    () => shellState.profiles.find((profile) => profile.id === shellState.activeProfileId) ?? null,
    [shellState.activeProfileId, shellState.profiles],
  );
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<ShellConnectionProfile>>({});
  const [deleteCandidate, setDeleteCandidate] = useState<ShellConnectionProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const isAddingConnection = editingProfileId === "__new__";
  const editingProfile = isAddingConnection
    ? null
    : shellState.profiles.find((profile) => profile.id === editingProfileId) ?? activeProfile;
  const workingName = draft.name ?? editingProfile?.name ?? "";
  const workingUrl = draft.serverUrl ?? editingProfile?.serverUrl ?? "";
  const workingToken = draft.authToken ?? editingProfile?.authToken ?? "";

  const resetEditor = () => {
    setEditingProfileId(null);
    setDraft({});
    setError(null);
  };

  const saveCurrent = async () => {
    setError(null);
    try {
      const parsed = new URL(workingUrl.trim());
      if (!/^https?:$/.test(parsed.protocol)) {
        throw new Error(t("shell.serverUrlProtocolError", "Server URL must use http or https"));
      }
      const saved = await shellApi.saveProfile({
        id: isAddingConnection ? undefined : (editingProfileId ?? editingProfile?.id),
        name: workingName || t("shell.defaultProfileName", "Remote Server"),
        serverUrl: workingUrl,
        authToken: workingToken || null,
      });
      await shellApi.setActiveProfile(saved.id);
      setEditingProfileId(saved.id);
      setDraft({});
    } catch (nextError) {
      setError((nextError as Error).message);
    }
  };

  const handleScanQr = async () => {
    setError(null);
    try {
      const result = await shellApi.startQrScan();
      setEditingProfileId("__new__");
      setDraft({
        name: "",
        serverUrl: result.serverUrl,
        authToken: result.authToken ?? "",
      });
    } catch (nextError) {
      setError((nextError as Error).message);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteCandidate) {
      return;
    }
    await shellApi.deleteProfile(deleteCandidate.id);
    setDeleteCandidate(null);
    resetEditor();
  };

  const isDesktopShell = shellState.host === "desktop-shell";
  const isDesktopLocalActive = isDesktopShell && shellState.desktopMode === "local";
  const isProfileActive = (profile: ShellConnectionProfile) => (
    shellState.activeProfileId === profile.id && (!isDesktopShell || shellState.desktopMode === "remote")
  );

  const handleUseLocalServer = async () => {
    resetEditor();
    setDeleteCandidate(null);
    await shellApi.setDesktopMode("local");
  };

  const handleUseProfile = async (profileId: string) => {
    resetEditor();
    if (isDesktopShell) {
      /*
       * FNXC:DesktopSwitchServer 2026-07-03-00:00:
       * Desktop Switch server presents local and remote destinations in one list. A remote profile
       * selection must explicitly enter remote mode before activation, while the Local Server entry
       * is the symmetric return path to the embedded runtime without deleting saved profiles.
       */
      await shellApi.setDesktopMode("remote");
    }
    await shellApi.setActiveProfile(profileId);
  };

  return (
    <div className="modal-overlay open">
      <div className="modal native-shell-connection-manager" role="dialog" aria-label={t("shell.connectionManagerLabel", "Connection Manager")}>
        <div className="modal-header">
          <h2>{t("shell.connectionManager", "Connection Manager")}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label={t("actions.close", "Close")}>
            ×
          </button>
        </div>

        <div className="native-shell-connection-manager__profiles">
          {isDesktopShell && (
            <button
              type="button"
              className="card native-shell-connection-manager__profile native-shell-connection-manager__destination"
              onClick={() => void handleUseLocalServer()}
              aria-pressed={isDesktopLocalActive}
            >
              <span>
                <strong>{t("shell.localServerTitle", "Local Server")}</strong>
                <span className="settings-muted">{t("shell.localServerDescription", "Use the embedded Fusion server on this device.")}</span>
                {isDesktopLocalActive && <span className="native-shell-connection-manager__active-pill">{t("shell.activePill", "Active")}</span>}
              </span>
              <span className="native-shell-connection-manager__profile-actions" aria-hidden="true">
                <span className="btn btn-sm">{isDesktopLocalActive ? t("shell.localServerActive", "Current") : t("shell.use", "Use")}</span>
              </span>
            </button>
          )}

          {shellState.profiles.length === 0 ? (
            <div className="card native-shell-connection-manager__empty-state">
              <p className="settings-muted">{t("shell.noServersSaved", "No remote servers saved yet.")}</p>
              <div className="native-shell-connection-manager__profile-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    setEditingProfileId("__new__");
                    setDraft({ name: "", serverUrl: "", authToken: "" });
                    setError(null);
                  }}
                >
                  {t("shell.addServer", "Add server")}
                </button>
                {shellState.host === "mobile-shell" && (
                  <button type="button" className="btn btn-sm" onClick={() => void handleScanQr()}>
                    {t("shell.scanQr", "Scan QR")}
                  </button>
                )}
              </div>
            </div>
          ) : (
            shellState.profiles.map((profile) => (
              <div className="card native-shell-connection-manager__profile" key={profile.id}>
                <div>
                  <strong>{profile.name}</strong>
                  <div className="settings-muted">{profile.serverUrl}</div>
                  {isProfileActive(profile) && <span className="native-shell-connection-manager__active-pill">{t("shell.activePill", "Active")}</span>}
                </div>
                <div className="native-shell-connection-manager__profile-actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    aria-label={t("shell.editProfile", "Edit {{name}}", { name: profile.name })}
                    onClick={() => {
                      setEditingProfileId(profile.id);
                      setDraft(profile);
                    }}
                  >
                    {t("actions.edit", "Edit")}
                  </button>
                  <button type="button" className="btn btn-sm" aria-label={t("shell.useProfile", "Use {{name}}", { name: profile.name })} onClick={() => void handleUseProfile(profile.id)}>{t("shell.use", "Use")}</button>
                  <button type="button" className="btn btn-sm btn-danger" aria-label={t("shell.deleteProfile", "Delete {{name}}", { name: profile.name })} onClick={() => setDeleteCandidate(profile)}>{t("actions.delete", "Delete")}</button>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="native-shell-connection-manager__mode-row">
          <button
            type="button"
            className="btn"
            onClick={() => {
              setEditingProfileId("__new__");
              setDraft({ name: "", serverUrl: "", authToken: "" });
              setError(null);
            }}
          >
            {t("shell.addConnection", "Add connection")}
          </button>
          {shellState.host === "mobile-shell" && (
            <button type="button" className="btn" onClick={() => void handleScanQr()}>
              {t("shell.scanQr", "Scan QR")}
            </button>
          )}
        </div>

        <div className="form-group native-shell-connection-manager__editor">
          <label htmlFor="native-shell-connection-manager-name">{t("shell.nameLabel", "Name")}</label>
          <input id="native-shell-connection-manager-name" className="input" value={workingName} onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))} />
          <label htmlFor="native-shell-connection-manager-url">{t("shell.serverUrlLabel", "Server URL")}</label>
          <input id="native-shell-connection-manager-url" className="input" value={workingUrl} onChange={(event) => setDraft((value) => ({ ...value, serverUrl: event.target.value }))} />
          <label htmlFor="native-shell-connection-manager-token">{t("shell.authTokenLabel", "Auth token (optional)")}</label>
          <input id="native-shell-connection-manager-token" className="input" type="password" value={workingToken ?? ""} onChange={(event) => setDraft((value) => ({ ...value, authToken: event.target.value }))} />
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>

        {deleteCandidate && (
          <div className="native-shell-connection-manager__delete-confirm" role="alertdialog" aria-label={t("shell.deleteConfirmLabel", "Delete server confirmation")}>
            <p>{t("shell.deleteConfirmMessage", "Delete {{name}}? This removes the saved profile.", { name: deleteCandidate.name })}</p>
            <div className="native-shell-connection-manager__profile-actions">
              <button type="button" className="btn btn-sm" onClick={() => setDeleteCandidate(null)}>{t("actions.cancel", "Cancel")}</button>
              <button type="button" className="btn btn-sm btn-danger" onClick={() => void handleConfirmDelete()}>{t("actions.delete", "Delete")}</button>
            </div>
          </div>
        )}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>{t("actions.close", "Close")}</button>
          <button type="button" className="btn" onClick={resetEditor}>{t("actions.cancel", "Cancel")}</button>
          <button type="button" className="btn btn-primary" onClick={() => void saveCurrent()} disabled={!workingUrl.trim()}>{t("actions.save", "Save")}</button>
        </div>
      </div>
    </div>
  );
}
