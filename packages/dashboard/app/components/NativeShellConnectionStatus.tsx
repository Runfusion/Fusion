import type { ShellConnectionState } from "../types/native-shell";
import "./NativeShellConnectionStatus.css";

interface NativeShellConnectionStatusProps {
  state: ShellConnectionState;
  onManage: () => void;
}

export function NativeShellConnectionStatus({ state, onManage }: NativeShellConnectionStatusProps) {
  const activeProfile = state.profiles.find((profile) => profile.id === state.activeProfileId) ?? null;
  const label =
    state.host === "desktop-shell" && state.desktopMode === "local"
      ? "Local Fusion"
      : activeProfile?.name ?? "Disconnected";

  return (
    <button type="button" className="btn native-shell-status" onClick={onManage} data-testid="native-shell-status-btn">
      <span className={`status-dot ${activeProfile || state.desktopMode === "local" ? "status-dot--online" : "status-dot--error"}`} aria-hidden="true" />
      <span className="native-shell-status__label">{label}</span>
    </button>
  );
}
