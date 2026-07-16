/**
 * Search entries for the Remote Access section.
 *
 * FNXC:SettingsSearch 2026-07-15-17:35:
 * One entry per descriptor row the section renders, co-located so a setting and its index entry change in the same edit. Labels and help mirror the section's `t()` calls verbatim: the index matches on the copy operators actually read, so a paraphrase here would make search miss the words on screen.
 * The section's still-bespoke controls are deliberately absent — they are not descriptor rows, so indexing them would point search at an anchor that does not exist: the provider radio cards, the Quick/Named Tunnel disclosure and its tunnel name/token/ingress fields, the auth-link token-type select, and the Start/Stop/Regenerate/QR actions with their URL and QR output.
 */
import type { SettingsSearchEntry } from "../search/types";

export const remoteSearchEntries: SettingsSearchEntry[] = [
  {
    sectionId: "remote",
    key: "remoteTailscaleAcceptRoutes",
    labelKey: "settings.remote.acceptRoutes",
    labelFallback: " Accept routes ",
    helpKey: "settings.remote.acceptRoutesHint",
    helpFallback: "Default: disabled.",
    /*
    FNXC:SettingsSearch 2026-07-15-17:35:
    "tailscale" is a keyword rather than left to the copy: the row only renders once Tailscale is the active provider, and its label and help say neither "tailscale" nor "subnet" — the words an operator searching for this actually types.
    */
    keywords: ["tailscale", "subnet", "tailnet", "funnel"],
  },
  {
    sectionId: "remote",
    key: "remoteShortLivedEnabled",
    labelKey: "settings.remote.enableShortLivedTokens",
    labelFallback: " Enable short-lived tokens ",
    helpKey: "settings.remote.shortLivedEnabledHint",
    helpFallback: "Default: disabled.",
    keywords: ["expiring token", "temporary access", "auth link"],
  },
  {
    sectionId: "remote",
    key: "remoteShortLivedTtlMs",
    labelKey: "settings.remote.shortLivedTTLMs",
    labelFallback: "Short-lived TTL (ms)",
    helpKey: "settings.remote.shortLivedTtlMsHint",
    helpFallback: "Default: 900000 (15 minutes).",
    /*
    FNXC:SettingsSearch 2026-07-15-17:35:
    The copy says "TTL" only; "expiry"/"lifetime" are what an operator who has not internalised the acronym searches for.
    */
    keywords: ["expiry", "lifetime", "time to live", "token duration"],
  },
  {
    sectionId: "remote",
    key: "remoteRememberLastRunning",
    labelKey: "settings.remote.rememberLastRunningState",
    labelFallback: " Remember last running state ",
    helpKey: "settings.remote.automaticallyRestoreTunnelOnStartupIfItWas",
    helpFallback:
      "Automatically restore tunnel on startup if it was running when last stopped. Default: disabled.",
    /*
    FNXC:SettingsSearch 2026-07-15-17:35:
    "tunnel" is in the help, but "cloudflared", "autostart", and "reconnect" are not — and they are how operators describe the behavior this setting controls.
    */
    keywords: ["cloudflared", "autostart", "reconnect", "persist tunnel"],
  },
];
