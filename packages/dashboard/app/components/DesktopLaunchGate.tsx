import { useEffect, useState, type PropsWithChildren } from "react";
import { useTranslation } from "react-i18next";
import type { ShellConnectionState } from "../types/native-shell";
import "./DesktopLaunchGate.css";

type Phase =
  | { kind: "loading" }
  | { kind: "chooser"; state: ShellConnectionState }
  | { kind: "starting-local"; message: string }
  | { kind: "local-error"; message: string }
  | { kind: "ready"; serverBaseUrl?: string }
  | { kind: "bypass" };

function getFusionShell() {
  if (typeof window === "undefined") return null;
  return window.fusionShell ?? null;
}

function isDesktopShell(state: ShellConnectionState | null): boolean {
  return state?.host === "desktop-shell";
}

function needsChooser(state: ShellConnectionState): boolean {
  const modeState = state.desktopModeState;
  if (modeState) {
    return modeState.isFirstRun || modeState.desktopMode === null;
  }
  return !state.desktopMode;
}

async function waitForLocalRuntime(
  shell: NonNullable<ReturnType<typeof getFusionShell>>,
  timeoutMs = 30_000,
): Promise<{ baseUrl: string }> {
  const deadline = Date.now() + timeoutMs;
  // The runtime is started by main when setDesktopMode("local") fires; just
  // poll shell:getState until localRuntime reports running.
  while (Date.now() < deadline) {
    const state = await shell.getState();
    const rt = state.localRuntime;
    if (rt?.state === "running" && (rt.baseUrl || rt.port)) {
      const baseUrl = rt.baseUrl ?? `http://127.0.0.1:${rt.port}`;
      return { baseUrl };
    }
    if (rt?.state === "error") {
      throw new Error(rt.error ?? "Local runtime failed to start");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Local runtime did not become ready in time");
}

function navigateToLocalRuntimeOrigin(baseUrl: string): void {
  /*
   * FNXC:DesktopLaunchGate 2026-07-03-02:10:
   * Load the UI FROM the embedded runtime's own origin (http://127.0.0.1:<port>/) rather than
   * staying on the packaged file:// page. The dashboard client makes RELATIVE /api requests; on a
   * file:// origin those resolve to file:///api/… and fail ("Can't reach the Fusion backend / Failed
   * to fetch"), and the embedded server sends no CORS header so a cross-origin fetch would be blocked
   * too. The embedded server also serves the client HTML at /, so navigating there makes /api
   * same-origin and everything just works — this mirrors how remote mode navigates to its server URL.
   */
  const target = new URL("/", baseUrl);
  target.searchParams.set("shellKind", "desktop-shell");
  target.searchParams.set("shellMode", "local");
  window.location.replace(target.toString());
}

export function DesktopLaunchGate({ children }: PropsWithChildren) {
  const { t } = useTranslation("app");
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  useEffect(() => {
    const shell = getFusionShell();
    if (!shell) {
      setPhase({ kind: "bypass" });
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const state = await shell.getState();
        if (cancelled) return;

        if (!isDesktopShell(state)) {
          setPhase({ kind: "bypass" });
          return;
        }

        if (needsChooser(state)) {
          setPhase({ kind: "chooser", state });
          return;
        }

        // Mode already chosen. If local, ensure runtime URL is in the
        // current page URL; if remote, App handles the redirect to the
        // active profile already.
        if (state.desktopMode === "local") {
          /*
           * FNXC:DesktopLaunchGate 2026-07-03-02:10:
           * If this page is already served over http(s), it's the embedded runtime serving the UI,
           * so /api is same-origin — render the app. The packaged renderer first loads from file://
           * (where relative /api fetches fail); there we start the runtime and navigate to its origin
           * (navigateToLocalRuntimeOrigin). Gating on the protocol rather than a serverBaseUrl URL
           * param also avoids the prior reload loop — main.tsx's bootstrapShellHostContext() strips
           * shell query params at module load, so a param-based "already handed off" check always
           * missed and reloaded forever ("rapid Starting Fusion flashing").
           */
          if (window.location.protocol !== "file:") {
            setPhase({ kind: "ready" });
            return;
          }
          setPhase({ kind: "starting-local", message: t("desktop.startingLocalRuntime", "Starting local Fusion runtime…") });
          /*
           * FNXC:DesktopLaunchGate 2026-07-02-14:35:
           * Self-healing start. Do NOT assume main already started the embedded runtime.
           * The gate decides to WAIT from shell `desktopMode:"local"`, but main decides to
           * START from a separate launch-mode file; when those desync (a first local
           * selection whose runtime start failed/was interrupted), main never starts the
           * runtime and this branch would poll a permanently "stopped" runtime until the 30s
           * timeout — the "hangs at Starting local runtime" bug. If the runtime is not already
           * running or starting, actively (re)start it via setDesktopMode("local") — idempotent
           * and awaits startup — before polling, so the gate can never wait for a runtime nobody
           * launched.
           *
           * Re-read the runtime state immediately before deciding: the `state` snapshot was captured
           * at mount and may not yet reflect a runtime main already started, which would fire a
           * redundant setDesktopMode("local") on normal boots.
           */
          const freshState = await shell.getState();
          if (cancelled) return;
          const rt = freshState.localRuntime;
          if (rt?.state !== "running" && rt?.state !== "starting") {
            try {
              await shell.setDesktopMode("local");
            } catch (startError) {
              if (cancelled) return;
              setPhase({
                kind: "local-error",
                message: startError instanceof Error ? startError.message : String(startError),
              });
              return;
            }
            if (cancelled) return;
          }
          const { baseUrl } = await waitForLocalRuntime(shell);
          if (cancelled) return;
          navigateToLocalRuntimeOrigin(baseUrl);
          return;
        }

        setPhase({ kind: "ready" });
      } catch (error) {
        if (cancelled) return;
        setPhase({
          kind: "local-error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const shell = getFusionShell();
    if (!shell?.onResetDesktopModeRequest || !shell.resetDesktopMode) {
      return;
    }
    return shell.onResetDesktopModeRequest(() => {
      void (async () => {
        try {
          await shell.resetDesktopMode?.();
        } catch {
          // Reset best-effort; we still reload to give the user a fresh
          // chooser even if the IPC failed.
        }
        const url = new URL(window.location.href);
        url.searchParams.delete("serverBaseUrl");
        url.searchParams.delete("shellMode");
        window.location.replace(url.toString());
      })();
    });
  }, []);

  if (phase.kind === "loading" || phase.kind === "starting-local") {
    const message = phase.kind === "loading" ? t("desktop.loading", "Loading Fusion…") : phase.message;
    return (
      <div className="desktop-launch-gate" role="status" aria-live="polite">
        <div className="desktop-launch-gate__panel">
          <p>{message}</p>
        </div>
      </div>
    );
  }

  if (phase.kind === "local-error") {
    return (
      <div className="desktop-launch-gate" role="alert">
        <div className="desktop-launch-gate__panel">
          <h2>{t("desktop.couldNotStart", "Couldn't start local Fusion")}</h2>
          <p>{phase.message}</p>
          <button
            type="button"
            className="btn"
            onClick={() => {
              window.location.reload();
            }}
          >
            {t("desktop.retry", "Retry")}
          </button>
        </div>
      </div>
    );
  }

  if (phase.kind === "chooser") {
    return (
      <DesktopModeChooser
        onPick={async (mode) => {
          const shell = getFusionShell();
          if (!shell) return;
          setPhase({
            kind: "starting-local",
            message: mode === "local" ? t("desktop.startingLocalRuntime", "Starting local Fusion runtime…") : t("desktop.settingUpRemote", "Setting up remote connection…"),
          });
          try {
            await shell.setDesktopMode(mode);
            if (mode === "local") {
              const { baseUrl } = await waitForLocalRuntime(shell);
              navigateToLocalRuntimeOrigin(baseUrl);
              return;
            }
            await shell.openConnectionManager();
            // After remote setup the App will pick up the active profile and
            // redirect; reload to flush bootstrap state.
            window.location.reload();
          } catch (error) {
            setPhase({
              kind: "local-error",
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }}
      />
    );
  }

  return <>{children}</>;
}

function DesktopModeChooser({ onPick }: { onPick: (mode: "local" | "remote") => void }) {
  const { t } = useTranslation("app");
  const [pending, setPending] = useState<"local" | "remote" | null>(null);
  return (
    <div className="desktop-launch-gate" role="dialog" aria-labelledby="desktop-launch-gate-title">
      <div className="desktop-launch-gate__panel">
        <h1 id="desktop-launch-gate-title">{t("desktop.chooseMode", "How do you want to run Fusion?")}</h1>
        <p>
          {t("desktop.chooseModeDescription", "Run Fusion locally in this app, or connect to a Fusion server you're already running somewhere else.")}
        </p>
        <div className="desktop-launch-gate__actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={pending !== null}
            onClick={() => {
              setPending("local");
              onPick("local");
            }}
          >
            {pending === "local" ? t("desktop.starting", "Starting…") : t("desktop.runLocalButton", "Run Fusion Locally")}
          </button>
          <button
            type="button"
            className="btn"
            disabled={pending !== null}
            onClick={() => {
              setPending("remote");
              onPick("remote");
            }}
          >
            {pending === "remote" ? t("desktop.opening", "Opening…") : t("desktop.connectRemoteButton", "Connect to Remote Fusion")}
          </button>
        </div>
      </div>
    </div>
  );
}
