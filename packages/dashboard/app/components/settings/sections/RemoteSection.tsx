import { useTranslation } from "react-i18next";
import { Globe, CheckCircle, AlertTriangle } from "lucide-react";
import { updateRemoteSettings, startRemoteTunnel, stopRemoteTunnel, killExternalTunnel, regenerateRemotePersistentToken, generateShortLivedRemoteToken, fetchRemoteUrl, fetchRemoteQr, type RemoteSettings, type RemoteStatus, } from "../../../api";
import type { ToastType } from "../../../hooks/useToast";
import { SettingsToggleRow } from "../SettingsToggleRow";
import { SettingsTextRow } from "../SettingsTextRow";
import { SettingsNumberRow } from "../SettingsNumberRow";
import { SettingsHelpTip } from "../SettingsHelpTip";
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
    remote: RemoteSectionData;
}
/*
FNXC:SettingsScope 2026-07-15-17:35:
Remote rows carry the "global" badge because these flattened form fields are not standalone settings keys: the shell's save-split (settings/save-split.ts, buildRemoteAccessPatch) folds them into the nested `remoteAccess` object, and `remoteAccess` is declared in DEFAULT_GLOBAL_SETTINGS. A tunnel belongs to the machine, not to one project, so the badge tells an operator these travel across every project on this node.
Descriptor keys stay FLAT (`remoteShortLivedTtlMs`), not dotted, because flat is genuinely what `form.<key>` holds here — the flattening happens in the form, and the dotted-leaf idiom is only for sections that read `form.blob.leaf` directly.

FNXC:SettingsStyling 2026-07-15-17:35:
Migrated rows are pulled OUT of their `form-group` wrappers instead of being nested inside them: `.form-group label` (narrowed further by `.settings-content .form-group label:not(.checkbox-label)`) out-specifies `.settings-field-row-label`, so a nested row would render its label uppercase/muted — the exact treatment the primitives retire. Wrappers are kept only around the bespoke content that still needs their inset.

FNXC:SettingsStyling 2026-07-15-17:35:
Deliberately NOT migrated, and why:
- The provider radio group (`remoteActiveProvider`) is a two-card radiogroup with provider icons, not a select.
- `remoteCloudflareQuickTunnel` is driven by the Advanced disclosure's open/closed state, not by a checkbox.
- The named-tunnel trio (`remoteCloudflareTunnelName`/`TunnelToken`/`IngressUrl`) stays whole inside that disclosure: `remoteCloudflareTunnelToken` is type="password" and SettingsTextRow hard-codes type="text", which would render the tunnel token UNMASKED. Splitting the other two out would strand the token alone.
- The Auth Links block (`remoteAuthLinkTokenType` select) stays with the buttons and URL/QR output it configures; it is also local UI state, not a settings key.
*/
export function RemoteSection({ form, setForm, remote }: RemoteSectionProps) {
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
        {/*
        FNXC:SettingsHelp 2026-07-15-21:40:
        Stays inline: this is the empty-state instruction for the whole provider block, shown only while nothing is picked, not help for one control. Behind a "?" the one operator who needs it — the one who has not chosen a provider yet — would never find it.
        */}
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

      {activeProvider === "tailscale" && (<>
          <div className="form-group remote-provider-settings">
            {/*
            FNXC:SettingsHelp 2026-07-16-12:45:
            Stays inline: this is the block-level description for the whole Tailscale provider mode, and the block has no heading or label of its own to host a "?" trigger — the nearest heading ("Remote Access") describes both providers, so a tip there would misattribute provider-specific copy. Same reasoning as the Cloudflare mode `<small>` below, which is additionally live state (its text switches with Quick Tunnel mode).
            */}
            <small>{t("settings.remote.tailscaleFunnelWillExposeThisDashboardOnYour", "Tailscale Funnel will expose this dashboard on your tailnet's public ")}{`https://<machine>.<tailnet>.ts.net/`}{t("settings.remote.uRLNoHostnameOrPortConfigurationNeeded", " URL \u2014 no hostname or port configuration needed.")}</small>
          </div>
          <SettingsToggleRow
            descriptor={{
              key: "remoteTailscaleAcceptRoutes",
              label: t("settings.remote.acceptRoutes", " Accept routes "),
              help: t("settings.remote.acceptRoutesHint", "Default: disabled."),
              scope: "global",
            }}
            value={Boolean(remoteForm.remoteTailscaleAcceptRoutes)}
            onChange={(v) => setForm((f) => ({ ...f, remoteTailscaleAcceptRoutes: v === true } as SettingsFormState))}
          />
        </>)}
      {activeProvider === "cloudflare" && (<div className="form-group remote-provider-settings">
              <small>
                {(remoteForm.remoteCloudflareQuickTunnel ?? true)
                    ? t("settings.remote.usingQuickTunnel", "Using Quick Tunnel — automatically creates a random trycloudflare.com URL, no account needed. Default: enabled.")
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
                {/*
                FNXC:SettingsSecurity 2026-07-15-18:52:
                The tunnel token renders through `type: "password"` (masked, `autocomplete="off"` by default). Before the descriptor carried `type`, the shared row would have rendered it in plain text, which is why this whole trio stayed hand-rolled.
                `remoteCloudflareIngressUrl` keeps `type: "text"` even though it holds a URL: it was a text input before, and promoting it to `type="url"` would attach native URL validation and switch the mobile keyboard — a behavior change disguised as a refactor. The placeholder already communicates the format.
                These rows carry no help text of their own; the descriptor omits `help` rather than inventing copy.
                */}
                {!(remoteForm.remoteCloudflareQuickTunnel ?? true) ? (<div className="remote-cf-advanced-fields">
                    <SettingsTextRow
                      descriptor={{
                        key: "remoteCloudflareTunnelName",
                        label: t("settings.remote.tunnelName", "Tunnel name"),
                        placeholder: t("settings.remote.tunnelName", "Tunnel name"),
                        scope: "global",
                      }}
                      value={String(remoteForm.remoteCloudflareTunnelName ?? "")}
                      onChange={(v) => setForm((f) => ({ ...f, remoteCloudflareTunnelName: v ?? "" } as SettingsFormState))}
                    />
                    <SettingsTextRow
                      descriptor={{
                        key: "remoteCloudflareTunnelToken",
                        label: t("settings.remote.tunnelToken", "Tunnel token"),
                        placeholder: t("settings.remote.tunnelToken", "Tunnel token"),
                        type: "password",
                        scope: "global",
                      }}
                      value={String(remoteForm.remoteCloudflareTunnelToken ?? "")}
                      onChange={(v) => setForm((f) => ({ ...f, remoteCloudflareTunnelToken: v ?? "" } as SettingsFormState))}
                    />
                    <SettingsTextRow
                      descriptor={{
                        key: "remoteCloudflareIngressUrl",
                        label: t("settings.remote.ingressURL", "Ingress URL"),
                        placeholder: t("settings.remote.httpsYourDomainExample", "https://your-domain.example"),
                        scope: "global",
                      }}
                      value={String(remoteForm.remoteCloudflareIngressUrl ?? "")}
                      onChange={(v) => setForm((f) => ({ ...f, remoteCloudflareIngressUrl: v ?? "" } as SettingsFormState))}
                    />
                  </div>) : null}
              </details>
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
        <SettingsToggleRow
          descriptor={{
            key: "remoteShortLivedEnabled",
            label: t("settings.remote.enableShortLivedTokens", " Enable short-lived tokens "),
            help: t("settings.remote.shortLivedEnabledHint", "Default: disabled."),
            scope: "global",
          }}
          value={Boolean(remoteForm.remoteShortLivedEnabled)}
          onChange={(v) => setForm((f) => ({ ...f, remoteShortLivedEnabled: v === true } as SettingsFormState))}
        />
        {/*
        FNXC:RemoteTokens 2026-07-15-17:35:
        The TTL stays enabled even when short-lived tokens are off: the Advanced "Generate short-lived token" / URL / QR actions below read this value directly, so it is live regardless of the toggle.
        A cleared field settles back to the 900000 default rather than to null — the token generators would otherwise mint a NaN TTL. Only an EMPTY field defaults: a typed 0 stores 0, matching the hand-rolled `Number(e.target.value || 900000)` where the string "0" is truthy and survives. Coercing 0 to the default here would silently rewrite an operator's input.
        */}
        <SettingsNumberRow
          descriptor={{
            key: "remoteShortLivedTtlMs",
            label: t("settings.remote.shortLivedTTLMs", "Short-lived TTL (ms)"),
            help: t("settings.remote.shortLivedTtlMsHint", "Default: 900000 (15 minutes)."),
            scope: "global",
            min: 60000,
            max: 86400000,
          }}
          value={Number(remoteForm.remoteShortLivedTtlMs ?? 900000)}
          onChange={(v) => setForm((f) => ({ ...f, remoteShortLivedTtlMs: v === null ? 900000 : v } as SettingsFormState))}
        />
        {remoteShortLivedToken && (<div className="form-group">
          <small>{t("settings.remote.lastShortLivedTokenExpiresAt", "Last short-lived token expires at ")}{new Date(remoteShortLivedToken.expiresAt).toLocaleString()} ({remoteShortLivedToken.ttlMs}{t("settings.remote.ms", "ms)")}</small>
        </div>)}
        <SettingsToggleRow
          descriptor={{
            key: "remoteRememberLastRunning",
            label: t("settings.remote.rememberLastRunningState", " Remember last running state "),
            help: t("settings.remote.automaticallyRestoreTunnelOnStartupIfItWas", "Automatically restore tunnel on startup if it was running when last stopped. Default: disabled."),
            scope: "global",
          }}
          value={Boolean(remoteForm.remoteRememberLastRunning)}
          onChange={(v) => setForm((f) => ({ ...f, remoteRememberLastRunning: v === true } as SettingsFormState))}
        />
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
          {/*
          FNXC:SettingsHelp 2026-07-15-21:40:
          This select stays hand-rolled (it drives local UI state, not a settings key — see the note above), but its help moves behind the shared "?" anyway: a section that mixes rows with a help icon and rows with a paragraph reads as two different surfaces. The live TTL fragment rides along inside the tip because it qualifies the token-type choice rather than reporting a result.
          */}
          <div className="settings-field-label-row">
            <label htmlFor="remoteAuthLinkTokenType">{t("settings.remote.authLinkTokenType", "Auth link token type")}</label>
            <SettingsHelpTip settingKey="remoteAuthLinkTokenType">{t("settings.remote.uRLAndQRGenerationUseTheSelectedToken", " URL and QR generation use the selected token type. ")}{remoteAuthLinkTokenType === "short-lived" ? ` TTL: ${Number(remoteForm.remoteShortLivedTtlMs ?? 900000)}ms.` : ""}</SettingsHelpTip>
          </div>
          <select id="remoteAuthLinkTokenType" value={remoteAuthLinkTokenType} onChange={(e) => setRemoteAuthLinkTokenType(e.target.value as "persistent" | "short-lived")}>
            <option value="persistent">{t("settings.remote.persistentToken", "Persistent token")}</option>
            <option value="short-lived">{t("settings.remote.shortLivedToken", "Short-lived token")}</option>
          </select>
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
