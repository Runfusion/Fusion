import { useCallback } from "react";
import type { ShellConnectionNativeResult } from "../shell-native";
import "./ShellConnectionStatus.css";

export interface ShellConnectionStatusProps {
  status: ShellConnectionNativeResult;
  onError?: (message: string) => void;
}

/*
FNXC:ShellConnectionStatusPill 2026-07-10-14:20:
First-run review flagged the header pill rendering "Desktop  Desktop local mode  Switch server" — the host-kind word appeared twice (once as a tiny label, once inside the larger summary) with mismatched font sizes.
Requirement: the pill must render the host kind exactly once, as a single uniform-size summary ("Desktop · Local mode", "Desktop · <profile> · <origin>", "Mobile · <profile> · <origin>"), keep the connection dot and the action label ("Switch server" / "Manage connections"), and never mix tiny and large text inside the pill.
The host kind is folded into the summary string here instead of a separate styled span; all states (local, remote, missing connection info) go through the same prefixing so no state can duplicate the word.
*/
function buildSummary(status: ShellConnectionNativeResult): { title: string; actionLabel: string; dotClassName: string } {
  const kindText = status.hostKind === "desktop-shell" ? "Desktop" : "Mobile";

  if (status.hostKind === "desktop-shell" && status.mode === "local") {
    return { title: `${kindText} · Local mode`, actionLabel: "Switch server", dotClassName: "status-dot status-dot--online" };
  }

  const profileText = status.profileLabel ?? status.profileId;
  const originText = status.serverOrigin;
  const summary = profileText && originText ? `${profileText} · ${originText}` : profileText ?? originText;
  const title = summary ? `${kindText} · ${summary}` : `${kindText} · Connection info unavailable`;

  if (status.mode === "remote") {
    return {
      title,
      actionLabel: status.hostKind === "desktop-shell" ? "Switch server" : "Manage connections",
      dotClassName: summary ? "status-dot status-dot--online" : "status-dot status-dot--pending",
    };
  }

  return {
    title,
    actionLabel: "Manage connections",
    dotClassName: summary ? "status-dot status-dot--online" : "status-dot status-dot--pending",
  };
}

export function ShellConnectionStatus({ status, onError }: ShellConnectionStatusProps) {
  if (status.hostKind === "browser" || !status.available) {
    return null;
  }

  const view = buildSummary(status);
  const handleClick = useCallback(async () => {
    const result = await status.openConnectionManager();
    if (!result.ok && result.reason === "failed") {
      onError?.(result.error ?? "Failed to open connection manager");
    }
  }, [onError, status]);

  return (
    <button type="button" className="btn shell-connection-status" onClick={() => void handleClick()} data-testid="shell-connection-status-button">
      <span className={view.dotClassName} aria-hidden="true" />
      <span className="shell-connection-status__summary" title={view.title}>{view.title}</span>
      <span className="shell-connection-status__action">{view.actionLabel}</span>
    </button>
  );
}
