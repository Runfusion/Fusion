/*
FNXC:DesktopOAuth 2026-07-18-04:00:
OAuth login handlers call window.open AFTER awaiting POST /auth/login. When
the round trip outlives Chromium's transient user activation (~5s — observed
with the OpenAI Codex flow while the Anthropic flow, being faster, worked),
the popup is silently blocked in the desktop app and the system browser never
opens. On desktop, prefer the activation-free shell:openExternal IPC bridge;
in the web app fall back to window.open.
*/

interface DesktopShellApi {
  openExternal?: (url: string) => Promise<boolean>;
}

function desktopShellApi(): DesktopShellApi | undefined {
  const w = window as unknown as { fusionAPI?: DesktopShellApi; electronAPI?: DesktopShellApi };
  return w.fusionAPI ?? w.electronAPI;
}

/*
FNXC:DesktopOAuth 2026-07-18-06:00:
Review finding: the old "fall back to window.open when the IPC declines" ran
window.open from an async continuation — exactly the activation-less context
this module exists to avoid, so the fallback was always popup-blocked. On
desktop the IPC is the ONLY viable opener; a failure is logged instead of
pretending a blocked fallback helped.
*/
/** Open a URL in the user's browser: desktop IPC when available, window.open otherwise. */
export function openExternalUrl(url: string): void {
  const api = desktopShellApi();
  if (typeof api?.openExternal === "function") {
    void api.openExternal(url).then((opened) => {
      if (!opened) console.error(`openExternalUrl: desktop shell declined to open ${url}`);
    }).catch((error: unknown) => {
      console.error(`openExternalUrl: desktop shell failed to open ${url}`, error);
    });
    return;
  }
  window.open(url, "_blank");
}
