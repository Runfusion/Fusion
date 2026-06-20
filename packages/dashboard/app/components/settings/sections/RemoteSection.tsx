import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Globe, CheckCircle, AlertTriangle } from "lucide-react";
import { updateRemoteSettings, startRemoteTunnel, stopRemoteTunnel, killExternalTunnel, regenerateRemotePersistentToken, generateShortLivedRemoteToken, fetchRemoteUrl, fetchRemoteQr, type RemoteSettings, type RemoteStatus, } from "../../../api";
import type { ToastType } from "../../../hooks/useToast";
import type { SectionBaseProps, SettingsFormState } from "./context";
export interface RemoteSectionData {
    projectId?: string;
    addToast: (message: string, type?: ToastType) => void;
    remoteStatus: RemoteStatus | null;
    externalTunnel: {
        provider: string;
        url: string | null;
    } | null;
    tunnelShareLink: {
        url: string;
        qrSvg: string | null;
    } | null;
    remoteBusyAction: string | null;
    cloudflaredInstalling: boolean;
    cloudflaredInstallError: string | null;
    cloudflaredManualInstallCommand: () => string;
    cloudflaredMacFallbackCommand: () => string | null;
    handleInstallCloudflared: () => Promise<void>;
    runRemoteAction: (label: string, action: () => Promise<void>) => Promise<void>;
    remoteShortLivedToken: {
        token: string;
        expiresAt: string;
        ttlMs: number;
    } | null;
    setRemoteShortLivedToken: (value: {
        token: string;
        expiresAt: string;
        ttlMs: number;
    } | null) => void;
    remoteAuthLinkTokenType: "persistent" | "short-lived";
    setRemoteAuthLinkTokenType: (value: "persistent" | "short-lived") => void;
    remoteUrlPreview: {
        url: string;
        expiresAt: string | null;
        tokenType: "persistent" | "short-lived";
    } | null;
    setRemoteUrlPreview: (value: {
        url: string;
        expiresAt: string | null;
        tokenType: "persistent" | "short-lived";
    } | null) => void;
    remoteQrSvg: string | null;
    setRemoteQrSvg: (value: string | null) => void;
}
export interface RemoteSectionProps extends SectionBaseProps {
    scopeBanner: ReactNode;
    remote: RemoteSectionData;
}
export function RemoteSection({ scopeBanner, form, setForm, remote }: RemoteSectionProps) {
    const { t } = useTranslation("app");
    const { projectId, addToast, remoteStatus, externalTunnel, tunnelShareLink, remoteBusyAction, cloudflaredInstalling, cloudflaredInstallError, cloudflaredManualInstallCommand, cloudflaredMacFallbackCommand, handleInstallCloudflared, runRemoteAction, remoteShortLivedToken, setRemoteShortLivedToken, remoteAuthLinkTokenType, setRemoteAuthLinkTokenType, remoteUrlPreview, setRemoteUrlPreview, remoteQrSvg, setRemoteQrSvg, } = remote;
    const remoteForm = form as Record<string, unknown>;
    const activeProvider = (remoteForm.remoteActiveProvider as "tailscale" | "cloudflare" | null) ?? null;
    const tunnelState = (remoteStatus?.state as RemoteStatus["state"] | "error" | undefined) ?? "stopped";
    const statusColor = tunnelState === "running"
        ? "running"
        : tunnelState === "starting"
            ? "starting"
            : tunnelState === "failed" || tunnelState === "error"
                ? "error"
                : "stopped";
    const buildSavePayload = (provider: "tailscale" | "cloudflare"): Partial<RemoteSettings> => {
        const formState = form as Record<string, unknown>;
        return {
            remoteActiveProvider: provider,
            remoteTailscaleEnabled: provider === "tailscale",
            remoteTailscaleHostname: String(formState.remoteTailscaleHostname ?? ""),
            remoteTailscaleTargetPort: Number(formState.remoteTailscaleTargetPort ?? 4040),
            remoteTailscaleAcceptRoutes: Boolean(formState.remoteTailscaleAcceptRoutes),
            remoteCloudflareEnabled: provider === "cloudflare",
            remoteCloudflareQuickTunnel: Boolean(formState.remoteCloudflareQuickTunnel ?? true),
            remoteCloudflareTunnelName: String(formState.remoteCloudflareTunnelName ?? ""),
            remoteCloudflareTunnelToken: (formState.remoteCloudflareTunnelToken as string | null) || null,
            remoteCloudflareIngressUrl: String(formState.remoteCloudflareIngressUrl ?? ""),
            remoteShortLivedEnabled: Boolean(formState.remoteShortLivedEnabled),
            remoteShortLivedTtlMs: Number(formState.remoteShortLivedTtlMs ?? 900000),
            remoteRememberLastRunning: Boolean(formState.remoteRememberLastRunning),
        };
    };
    return (<>
      {scopeBanner}
      <h4 className="settings-section-heading">{t("settings.remote.remoteAccess", "Remote Access")}</h4>
      <div className={`remote-status-bar remote-status-bar--${statusColor}`}>
        <span className={`remote-status-dot remote-status-dot--${statusColor}`}/>
        <strong>{tunnelState}</strong>
        {remoteStatus?.provider && <span> · {remoteStatus.provider}</span>}
        {remoteStatus?.url && <code className="remote-status-url">{remoteStatus.url}</code>}
        {remoteStatus?.lastError && <span className="field-error">{remoteStatus.lastError}</span>}
      </div>
      {tunnelState === "stopped" && externalTunnel && (<div className="remote-external-tunnel-panel" role="status">
          <div className="remote-external-tunnel-header">
            <Globe aria-hidden="true"/>
            <strong>{t("settings.remote.external", "External ")}{externalTunnel.provider}{t("settings.remote.tunnelDetected", " tunnel detected")}</strong>
          </div>
          {externalTunnel.url && <code className="settings-url-output">{externalTunnel.url}</code>}
          {tunnelShareLink?.qrSvg && (<div className="remote-external-tunnel-qr">
              <small>{t("settings.remote.scanToOpen", "Scan to open:")}</small>
              <img src={`data:image/svg+xml;utf8,${encodeURIComponent(tunnelShareLink.qrSvg)}`} alt={t("settings.remote.externalTunnelQRCode", "External tunnel QR code")} className="settings-qr-preview-image"/>
            </div>)}
        </div>)}
      {tunnelState === "running" && (remoteStatus?.url || tunnelShareLink) && (() => {
            let accessCode: string | null = null;
            let tailnetUrl: string | null = remoteStatus?.url ?? null;
            if (tunnelShareLink?.url) {
                try {
                    const parsed = new URL(tunnelShareLink.url);
                    accessCode = parsed.searchParams.get("rt");
                    if (!tailnetUrl)
                        tailnetUrl = `${parsed.origin}/`;
                }
                catch {
                    // fall through
                }
            }
            return (<div className="remote-share-block">
            {tailnetUrl && (<div className="remote-share-row">
                <small>{t("settings.remote.tailnetURL", "Tailnet URL:")}</small>
                <code className="settings-url-output">{tailnetUrl}</code>
              </div>)}
            {accessCode && (<div className="remote-share-row">
                <small>{t("settings.remote.remoteAccessCode", "Remote access code:")}</small>
                <code className="settings-url-output">{accessCode}</code>
              </div>)}
            {tunnelShareLink?.qrSvg && (<div className="remote-share-row">
                <small>{t("settings.remote.scanToConnect", "Scan to connect:")}</small>
                <img src={`data:image/svg+xml;utf8,${encodeURIComponent(tunnelShareLink.qrSvg)}`} alt={t("settings.remote.remoteAccessQRCode", "Remote access QR code")} className="settings-qr-preview-image"/>
              </div>)}
          </div>);
        })()}

      <div className="form-group">
        <div className="remote-provider-selector" role="radiogroup" aria-label={t("settings.remote.remoteProvider", "Remote provider")}>
          <label className="remote-provider-option">
            <input type="radio" name="remoteProvider" value="tailscale" checked={activeProvider === "tailscale"} onChange={() => setForm((f) => ({ ...f, remoteActiveProvider: "tailscale" } as SettingsFormState))}/>
            <span>
              <span className="remote-provider-option-content">
                <span data-testid="remote-provider-icon-tailscale" aria-hidden="true"><Globe size={16}/></span>
                <span>{t("settings.remote.tailscale", "Tailscale")}</span>
              </span>
            </span>
          </label>
          <label className="remote-provider-option">
            <input type="radio" name="remoteProvider" value="cloudflare" checked={activeProvider === "cloudflare"} onChange={() => setForm((f) => ({ ...f, remoteActiveProvider: "cloudflare" } as SettingsFormState))}/>
            <span>
              <span className="remote-provider-option-content">
                <span data-testid="remote-provider-icon-cloudflare" aria-hidden="true" className="remote-provider-option-icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" data-testid="remote-cloudflare-option-icon">
                    <path d="M7 16.5h10.8a2.9 2.9 0 0 0 .3-5.8 4.9 4.9 0 0 0-9.3-1.6A3.6 3.6 0 0 0 7 16.5m-1.9 0h3.2a2.5 2.5 0 0 0 .2-5 3.4 3.4 0 0 0-3.4 3.4c0 .6 0 1 .2 1.6" fill="var(--provider-cloudflare)"/>
                  </svg>
                </span>
                <span>{t("settings.remote.cloudflare", "Cloudflare")}</span>
              </span>
            </span>
          </label>
        </div>
        {!activeProvider && <small>{t("settings.remote.selectAProviderAboveToConfigureRemoteAccess", "Select a provider above to configure remote access.")}</small>}
      </div>

      {activeProvider === "cloudflare" && remoteStatus?.cloudflaredAvailable === true && (<div className="remote-cli-detection remote-cli-detection--available" role="status">
          <CheckCircle aria-hidden="true"/>
          <span>{t("settings.remote.cloudflaredIsInstalled", "cloudflared is installed")}</span>
        </div>)}

      {activeProvider === "cloudflare" && remoteStatus?.cloudflaredAvailable === false && (<div className="remote-cli-detection remote-cli-detection--missing" role="status">
          <AlertTriangle aria-hidden="true"/>
          <div className="remote-cli-detection-content">
            <span>{t("settings.remote.cloudflaredIsNotInstalled", "cloudflared is not installed")}</span>
            <button type="button" className="btn btn-sm" disabled={cloudflaredInstalling || remoteBusyAction !== null} onClick={() => void handleInstallCloudflared()}>
              {cloudflaredInstalling ? t("settings.remote.installing", "Installing…") : t("settings.remote.installCloudflared", "Install cloudflared")}
            </button>
            {cloudflaredInstallError && <small className="remote-cli-install-error">{cloudflaredInstallError}</small>}
            <small className="remote-cli-manual">{t("settings.remote.manualInstall", "Manual install: ")}<code>{cloudflaredManualInstallCommand()}</code></small>
            {cloudflaredMacFallbackCommand()
                ? <small className="remote-cli-manual">{t("settings.remote.ifHomebrewIsUnavailable", "If Homebrew is unavailable: ")}<code>{cloudflaredMacFallbackCommand()}</code></small>
                : null}
          </div>
        </div>)}

      {activeProvider && (<div className="form-group remote-provider-settings">
          {activeProvider === "tailscale" ? (<>
              <small>{t("settings.remote.tailscaleFunnelWillExposeThisDashboardOnYour", "Tailscale Funnel will expose this dashboard on your tailnet's public ")}{`https://<machine>.<tailnet>.ts.net/`}{t("settings.remote.uRLNoHostnameOrPortConfigurationNeeded", " URL \u2014 no hostname or port configuration needed.")}</small>
              <label htmlFor="remoteTailscaleAcceptRoutes" className="checkbox-label">
                <input id="remoteTailscaleAcceptRoutes" type="checkbox" checked={Boolean(remoteForm.remoteTailscaleAcceptRoutes)} onChange={(e) => setForm((f) => ({ ...f, remoteTailscaleAcceptRoutes: e.target.checked } as SettingsFormState))}/>{t("settings.remote.acceptRoutes", " Accept routes ")}</label>
            </>) : (<>
              <small>
                {(remoteForm.remoteCloudflareQuickTunnel ?? true)
                    ? t("settings.remote.usingQuickTunnel", "Using Quick Tunnel — automatically creates a random trycloudflare.com URL, no account needed.")
                    : t("settings.remote.namedTunnelModeEnabled", "Named Tunnel mode enabled — configure tunnel name, token, and ingress URL below.")}
              </small>
              <details className="remote-cf-advanced-details" open={!(remoteForm.remoteCloudflareQuickTunnel ?? true)} onToggle={(event) => {
                    const detailsOpen = event.currentTarget.open;
                    setForm((f) => {
                        const currentQuickTunnel = Boolean((f as Record<string, unknown>).remoteCloudflareQuickTunnel ?? true);
                        const nextQuickTunnel = !detailsOpen;
                        if (currentQuickTunnel === nextQuickTunnel) {
                            return f;
                        }
                        return { ...f, remoteCloudflareQuickTunnel: nextQuickTunnel } as SettingsFormState;
                    });
                }}>
                <summary>{t("settings.remote.advancedNamedTunnel", "Advanced (Named Tunnel)")}</summary>
                {!(remoteForm.remoteCloudflareQuickTunnel ?? true) ? (<div className="remote-cf-advanced-fields">
                    <label htmlFor="remoteCloudflareTunnelName">{t("settings.remote.tunnelName", "Tunnel name")}</label>
                    <input id="remoteCloudflareTunnelName" type="text" placeholder={t("settings.remote.tunnelName", "Tunnel name")} value={String(remoteForm.remoteCloudflareTunnelName ?? "")} onChange={(e) => setForm((f) => ({ ...f, remoteCloudflareTunnelName: e.target.value } as SettingsFormState))}/>
                    <label htmlFor="remoteCloudflareTunnelToken">{t("settings.remote.tunnelToken", "Tunnel token")}</label>
                    <input id="remoteCloudflareTunnelToken" type="password" placeholder={t("settings.remote.tunnelToken", "Tunnel token")} value={String(remoteForm.remoteCloudflareTunnelToken ?? "")} onChange={(e) => setForm((f) => ({ ...f, remoteCloudflareTunnelToken: e.target.value } as SettingsFormState))}/>
                    <label htmlFor="remoteCloudflareIngressUrl">{t("settings.remote.ingressURL", "Ingress URL")}</label>
                    <input id="remoteCloudflareIngressUrl" type="text" placeholder={t("settings.remote.httpsYourDomainExample", "https://your-domain.example")} value={String(remoteForm.remoteCloudflareIngressUrl ?? "")} onChange={(e) => setForm((f) => ({ ...f, remoteCloudflareIngressUrl: e.target.value } as SettingsFormState))}/>
                  </div>) : null}
              </details>
            </>)}
        </div>)}

      <div className="form-group remote-tunnel-actions">
        {tunnelState === "running" || tunnelState === "starting" ? (<button type="button" className="btn btn-danger" disabled={remoteBusyAction !== null} onClick={() => void runRemoteAction("stop", async () => {
                await stopRemoteTunnel(projectId);
                addToast(t("settings.remote.tunnelStopped", "Remote tunnel stopped"), "success");
            })}>
            {remoteBusyAction === "stop" ? t("settings.remote.stopping", "Stopping…") : t("settings.remote.stopTunnel", "Stop Tunnel")}
          </button>) : (<>
            {externalTunnel ? (<div className="remote-external-tunnel-actions">
                <button type="button" className="btn" disabled={!activeProvider || remoteBusyAction !== null} onClick={() => void runRemoteAction("start fresh", async () => {
                    if (!activeProvider)
                        return;
                    await updateRemoteSettings(buildSavePayload(activeProvider), projectId);
                    await killExternalTunnel(projectId);
                    await startRemoteTunnel(projectId);
                    addToast(t("settings.remote.tunnelRestarted", "Remote tunnel restarted"), "success");
                })}>
                  {remoteBusyAction === "start fresh" ? t("settings.remote.restarting", "Restarting…") : t("settings.remote.startFresh", "Start Fresh")}
                </button>
                <button type="button" className="btn btn-primary" disabled={!activeProvider || remoteBusyAction !== null} onClick={() => void runRemoteAction("use existing", async () => {
                    if (!activeProvider)
                        return;
                    await updateRemoteSettings(buildSavePayload(activeProvider), projectId);
                    await startRemoteTunnel(projectId);
                    addToast(t("settings.remote.tunnelStarted", "Remote tunnel started"), "success");
                })}>
                  {remoteBusyAction === "use existing" ? t("settings.remote.starting", "Starting…") : t("settings.remote.useExisting", "Use Existing")}
                </button>
              </div>) : (<button type="button" className="btn btn-primary" disabled={!activeProvider || remoteBusyAction !== null} onClick={() => void runRemoteAction("start", async () => {
                    if (!activeProvider)
                        return;
                    // Server overrides remoteTailscaleTargetPort with
                    // req.socket.localPort when starting the tunnel; the value sent
                    // here is only a fallback if that override doesn't fire.
                    await updateRemoteSettings(buildSavePayload(activeProvider), projectId);
                    await startRemoteTunnel(projectId);
                    addToast(t("settings.remote.tunnelStarted", "Remote tunnel started"), "success");
                })}>
                {remoteBusyAction === "start" ? t("settings.remote.starting", "Starting…") : t("settings.remote.startTunnel", "Start Tunnel")}
              </button>)}
            {activeProvider === "cloudflare" && remoteStatus?.cloudflaredAvailable === false ? (<small className="field-error">{t("settings.remote.cloudflaredMustBeInstalledToStartTheTunnel", "cloudflared must be installed to start the tunnel")}</small>) : null}
          </>)}
      </div>

      <details className="remote-advanced-details">
        <summary>{t("settings.remote.advancedSettings", "Advanced Settings")}</summary>
        <div className="form-group">
          <label htmlFor="remoteShortLivedEnabled" className="checkbox-label">
            <input id="remoteShortLivedEnabled" type="checkbox" checked={Boolean(remoteForm.remoteShortLivedEnabled)} onChange={(e) => setForm((f) => ({ ...f, remoteShortLivedEnabled: e.target.checked } as SettingsFormState))}/>{t("settings.remote.enableShortLivedTokens", " Enable short-lived tokens ")}</label>
          <label htmlFor="remoteShortLivedTtlMs">{t("settings.remote.shortLivedTTLMs", "Short-lived TTL (ms)")}</label>
          <input id="remoteShortLivedTtlMs" type="number" min={60000} max={86400000} value={Number(remoteForm.remoteShortLivedTtlMs ?? 900000)} onChange={(e) => setForm((f) => ({ ...f, remoteShortLivedTtlMs: Number(e.target.value || 900000) } as SettingsFormState))}/>
          {remoteShortLivedToken && <small>{t("settings.remote.lastShortLivedTokenExpiresAt", "Last short-lived token expires at ")}{new Date(remoteShortLivedToken.expiresAt).toLocaleString()} ({remoteShortLivedToken.ttlMs}{t("settings.remote.ms", "ms)")}</small>}
        </div>
        <div className="form-group">
          <label htmlFor="remoteRememberLastRunning" className="checkbox-label">
            <input id="remoteRememberLastRunning" type="checkbox" checked={Boolean(remoteForm.remoteRememberLastRunning)} onChange={(e) => setForm((f) => ({ ...f, remoteRememberLastRunning: e.target.checked } as SettingsFormState))}/>{t("settings.remote.rememberLastRunningState", " Remember last running state ")}</label>
          <small>{t("settings.remote.automaticallyRestoreTunnelOnStartupIfItWas", "Automatically restore tunnel on startup if it was running when last stopped.")}</small>
        </div>
        <div className="form-group">
          <label>{t("settings.remote.authLinks", "Auth Links")}</label>
          <div className="settings-button-row">
            <button type="button" className="btn btn-sm" disabled={remoteBusyAction !== null} onClick={() => void runRemoteAction("regenerate persistent token", async () => {
            await regenerateRemotePersistentToken(projectId);
            addToast(t("settings.remote.persistentTokenRegenerated", "Persistent token regenerated"), "success");
        })}>{t("settings.remote.regeneratePersistentToken", "Regenerate persistent token")}</button>
            <button type="button" className="btn btn-sm" disabled={remoteBusyAction !== null} onClick={() => void runRemoteAction("generate short-lived token", async () => {
            const ttlMs = Number(remoteForm.remoteShortLivedTtlMs ?? 900000);
            const generated = await generateShortLivedRemoteToken(ttlMs, projectId);
            setRemoteShortLivedToken(generated);
            addToast(t("settings.remote.shortLivedTokenGenerated", "Short-lived token generated"), "success");
        })}>{t("settings.remote.generateShortLivedToken", "Generate short-lived token")}</button>
            <button type="button" className="btn btn-sm" disabled={remoteBusyAction !== null} onClick={() => void runRemoteAction("fetch remote url", async () => {
            const ttlMs = Number(remoteForm.remoteShortLivedTtlMs ?? 900000);
            const nextUrl = await fetchRemoteUrl({ projectId, tokenType: remoteAuthLinkTokenType, ttlMs: remoteAuthLinkTokenType === "short-lived" ? ttlMs : undefined });
            setRemoteUrlPreview(nextUrl);
            setRemoteQrSvg(null);
        })}>{t("settings.remote.showURL", "Show URL")}</button>
            <button type="button" className="btn btn-sm" disabled={remoteBusyAction !== null} onClick={() => void runRemoteAction("generate QR", async () => {
            const ttlMs = Number(remoteForm.remoteShortLivedTtlMs ?? 900000);
            const qr = await fetchRemoteQr("image/svg", { projectId, tokenType: remoteAuthLinkTokenType, ttlMs: remoteAuthLinkTokenType === "short-lived" ? ttlMs : undefined });
            setRemoteUrlPreview({ url: qr.url, expiresAt: qr.expiresAt, tokenType: qr.tokenType });
            setRemoteQrSvg(qr.data ?? null);
        })}>{t("settings.remote.generateQR", "Generate QR")}</button>
          </div>
          <label htmlFor="remoteAuthLinkTokenType">{t("settings.remote.authLinkTokenType", "Auth link token type")}</label>
          <select id="remoteAuthLinkTokenType" value={remoteAuthLinkTokenType} onChange={(e) => setRemoteAuthLinkTokenType(e.target.value as "persistent" | "short-lived")}>
            <option value="persistent">{t("settings.remote.persistentToken", "Persistent token")}</option>
            <option value="short-lived">{t("settings.remote.shortLivedToken", "Short-lived token")}</option>
          </select>
          <small>{t("settings.remote.uRLAndQRGenerationUseTheSelectedToken", " URL and QR generation use the selected token type. ")}{remoteAuthLinkTokenType === "short-lived" ? ` TTL: ${Number(remoteForm.remoteShortLivedTtlMs ?? 900000)}ms.` : ""}
          </small>
          {remoteUrlPreview?.url && (<>
              <small>{t("settings.remote.authenticatedURL", "Authenticated URL:")}<code className="settings-url-output">{remoteUrlPreview.url}</code></small>
              <small>{t("settings.remote.tokenType", " Token type: ")}<strong>{remoteUrlPreview.tokenType}</strong>
                {remoteUrlPreview.expiresAt
                    ? t("settings.remote.expiresAt", " · Expires at {{expiresAt}}", { expiresAt: new Date(remoteUrlPreview.expiresAt).toLocaleString() })
                    : t("settings.remote.noExpiry", " · No expiry")}
              </small>
            </>)}
          {remoteQrSvg && (<div className="settings-qr-preview" aria-live="polite">
              <p className="settings-qr-preview-label">{t("settings.remote.scanThisQRCodeOnYourPhone", "Scan this QR code on your phone")}</p>
              <div className="settings-qr-preview-image-wrap">
                <img src={`data:image/svg+xml;utf8,${encodeURIComponent(remoteQrSvg)}`} alt={t("settings.remote.remoteAccessQRCode", "Remote access QR code")} className="settings-qr-preview-image"/>
              </div>
              <details>
                <summary>{t("settings.remote.qRSVGMarkup", "QR SVG markup")}</summary>
                <pre className="settings-raw-output">{remoteQrSvg}</pre>
              </details>
            </div>)}
        </div>
      </details>
    </>);
}
export default RemoteSection;
