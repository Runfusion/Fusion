import { useCallback, useEffect, useState } from "react";
import "./WhatsAppChatPairingPanel.css";

type WhatsAppStatus = {
  status: "starting" | "awaiting-qr" | "awaiting-code" | "connected" | "disconnected" | "error";
  jid?: string;
  lastError?: string;
  qrDataUrl?: string;
  pairingCode?: string;
};

export interface WhatsAppChatPairingPanelProps {
  projectId?: string;
  settings?: Record<string, unknown>;
}

const PLUGIN_PATH = "/api/plugins/fusion-plugin-whatsapp-chat";
const E164_DIGITS = /^\d+$/;

function pluginUrl(path: string, projectId?: string): string {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  return `${PLUGIN_PATH}${path}${query}`;
}

/**
 * FNXC:WhatsAppSettingsPairing 2026-07-20-12:00:
 * WhatsApp pairing belongs in Plugin Manager settings: operators need a scannable QR, connection feedback, and configuration guidance without discovering raw plugin API routes.
 */
export function WhatsAppChatPairingPanel({ projectId, settings }: WhatsAppChatPairingPanelProps) {
  const [connection, setConnection] = useState<WhatsAppStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [phoneNumber, setPhoneNumber] = useState(() => String(settings?.pairingPhoneNumber ?? ""));
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"code" | "logout" | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const response = await fetch(pluginUrl("/status", projectId));
      const payload = await response.json() as WhatsAppStatus & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "WhatsApp pairing is unavailable. Enable the plugin and try again.");
      setConnection(payload);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [projectId]);

  useEffect(() => {
    void refreshStatus();
    const interval = window.setInterval(() => void refreshStatus(), 5000);
    return () => window.clearInterval(interval);
  }, [refreshStatus]);

  const requestPairingCode = async () => {
    const normalizedPhoneNumber = phoneNumber.trim();
    if (!normalizedPhoneNumber || !E164_DIGITS.test(normalizedPhoneNumber)) {
      setActionError("Enter an E.164 phone number using digits only, without +.");
      return;
    }
    setBusy("code");
    setActionError(null);
    try {
      const response = await fetch(pluginUrl("/pair-code", projectId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber: normalizedPhoneNumber, ...(projectId ? { projectId } : {}) }),
      });
      const payload = await response.json() as { pairingCode?: string; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Could not request a pairing code.");
      setConnection((current) => ({ status: "awaiting-code", ...current, pairingCode: payload.pairingCode }));
      await refreshStatus();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const logoutForRepair = async () => {
    setBusy("logout");
    setActionError(null);
    try {
      const response = await fetch(pluginUrl("/logout", projectId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(projectId ? { projectId } : {}),
      });
      if (!response.ok) {
        const payload = await response.json() as { error?: string };
        throw new Error(payload.error ?? "Could not log out from WhatsApp.");
      }
      /**
       * FNXC:WhatsAppSettingsRePair 2026-07-20-12:00:
       * The logout control relies on the connection layer immediately scheduling a fresh pairing session, so polling can replace the old session with a QR or code-ready state.
       */
      await refreshStatus();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const pairingMode = settings?.pairingMode === "code" ? "code" : "qr";
  const state = connection?.status ?? "starting";

  return (
    <section className="whatsapp-pairing-panel" aria-labelledby="whatsapp-pairing-heading">
      <div className="whatsapp-pairing-heading-row">
        <div>
          <h5 id="whatsapp-pairing-heading" className="plugin-detail-section-heading">WhatsApp pairing</h5>
          <p className="whatsapp-pairing-description">Pair and monitor this project&apos;s WhatsApp connection here.</p>
        </div>
        <button className="btn btn-secondary btn-sm" type="button" onClick={() => void refreshStatus()}>Refresh status</button>
      </div>

      <div className={`whatsapp-pairing-status whatsapp-pairing-status--${state}`} role="status" data-testid="whatsapp-pairing-status">
        <strong>Status: {state}</strong>
        {connection?.jid && <span>Connected as {connection.jid}</span>}
        {(connection?.lastError || loadError) && <span className="field-error">{connection?.lastError ?? loadError}</span>}
      </div>

      {state === "awaiting-qr" && (
        <div className="whatsapp-pairing-qr" data-testid="whatsapp-pairing-qr">
          {connection?.qrDataUrl ? (
            <img src={connection.qrDataUrl} alt="WhatsApp pairing QR code" className="whatsapp-pairing-qr-image" />
          ) : (
            <p className="text-muted">Waiting for a fresh QR code. Keep this panel open and refresh if needed.</p>
          )}
        </div>
      )}

      {(pairingMode === "code" || state === "awaiting-code") && (
        <div className="whatsapp-pairing-code">
          <label htmlFor="whatsapp-pairing-phone">Phone number (E.164 digits without +)</label>
          <div className="whatsapp-pairing-code-controls">
            <input id="whatsapp-pairing-phone" className="input" value={phoneNumber} onChange={(event) => setPhoneNumber(event.target.value)} inputMode="numeric" />
            <button className="btn btn-secondary" type="button" onClick={() => void requestPairingCode()} disabled={busy !== null}>
              {busy === "code" ? "Requesting code..." : "Request pairing code"}
            </button>
          </div>
          {connection?.pairingCode && <output className="whatsapp-pairing-code-output">{connection.pairingCode}</output>}
        </div>
      )}

      {state === "connected" && <p className="whatsapp-pairing-success">WhatsApp is paired and ready to receive messages from allowed senders.</p>}
      {actionError && <p className="field-error">{actionError}</p>}

      <button className="btn btn-danger" type="button" onClick={() => void logoutForRepair()} disabled={busy !== null} data-testid="whatsapp-pairing-logout">
        {busy === "logout" ? "Logging out..." : "Logout and re-pair"}
      </button>

      <aside className="whatsapp-pairing-instructions" aria-label="WhatsApp pairing instructions" data-testid="whatsapp-pairing-instructions">
        <h6>Pairing and configuration</h6>
        <ol>
          <li>Install and enable this plugin, then keep this settings panel open.</li>
          <li>Set <strong>Allowed WhatsApp Senders</strong>; an empty list blocks all inbound messages.</li>
          <li>Choose <strong>QR</strong> to scan in WhatsApp Linked Devices, or <strong>code</strong> to enter a phone number and request a pairing code.</li>
          <li>Wait for the status above to become <strong>connected</strong>.</li>
          <li>Use Logout and re-pair to start over. If QR is still pending, wait briefly or refresh status for a new code.</li>
        </ol>
      </aside>
    </section>
  );
}
