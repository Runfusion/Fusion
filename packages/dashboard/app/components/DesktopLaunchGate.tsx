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

function applyServerBaseUrl(baseUrl: string): void {
  // Reload the page with the local runtime URL so shell-host bootstrap reads
  // it and routes API calls through it (the page itself is loaded via file://
  // so relative /api fetches would otherwise fail).
  const url = new URL(window.location.href);
  url.searchParams.set("serverBaseUrl", baseUrl);
  url.searchParams.set("shellKind", "desktop-shell");
  url.searchParams.set("shellMode", "local");
  window.location.replace(url.toString());
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
          const params = new URLSearchParams(window.location.search);
          if (params.has("serverBaseUrl")) {
            setPhase({ kind: "ready", serverBaseUrl: params.get("serverBaseUrl") ?? undefined });
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
           */
          const rt = state.localRuntime;
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
          applyServerBaseUrl(baseUrl);
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
              applyServerBaseUrl(baseUrl);
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
