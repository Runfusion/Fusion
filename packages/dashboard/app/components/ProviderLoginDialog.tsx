import { useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { CheckCircle2, ExternalLink, Loader2, X } from "lucide-react";
import { OAuthManualCodeForm } from "./OAuthManualCodeForm";
import { LoginInstructions } from "./LoginInstructions";
import { nextFloatingZ } from "./floatingWindowStack";
import "./ProviderLoginDialog.css";

/*
FNXC:ProviderAuth 2026-08-18-03:05:
A PASTE-BACK LOGIN MUST BE VISIBLE FOR ITS WHOLE DURATION, IN ONE PLACE.

Before this dialog the flow scattered itself across three surfaces: a pre-flight confirm that warned
about paste-back and then vanished, a provider card that changed to a small disabled "Waiting for
login…" chip, and the paste field + instructions rendered inline INSIDE that card — below the fold of
a scrolling modal, so the operator finished signing in, returned to the dashboard, and found no
obvious place to put the redirect URL and no indication of what the app was waiting for.

So the dialog opens when the login starts and STAYS until the flow ends: it names the step the flow
is on, re-offers the sign-in URL (the popup is easy to lose behind the dashboard), always shows the
paste field, and surfaces the terminal outcome inline instead of as a toast that disappears.

FNXC:ProviderAuth 2026-08-18-04:20:
LAYOUT CONTRACT — this dialog uses the shared `.modal-header` / `.modal-actions` primitives rather
than hand-rolled padding. The first version set its own header/action padding and drifted from every
other dialog in the app (reported as "doesn't have proper spacing"). Those primitives already carry
`var(--modal-padding)`; only the step list, which has no primitive, defines its own inset, and it
reuses the same token. Do not reintroduce bespoke padding on the header or action row here.
*/

export type ProviderLoginPhase = "waiting" | "submitting" | "failed" | "succeeded";

export interface ProviderLoginDialogProps {
  providerName: string;
  /** Auth URL the flow opened, re-offered because the popup is easy to lose or dismiss. */
  authUrl?: string;
  instructions?: string;
  phase: ProviderLoginPhase;
  /** Terminal failure reason, shown inline; never a disappearing toast. */
  errorMessage?: string;
  manualCode: { prompt: string; placeholder?: string; helpText?: string };
  codeValue: string;
  onCodeChange: (value: string) => void;
  onSubmitCode: () => void;
  onOpenAuthUrl: () => void;
  onCancel: () => void;
  "data-testid"?: string;
}

const STEP_STATE = {
  done: "provider-login-dialog__step--done",
  active: "provider-login-dialog__step--active",
  idle: "",
} as const;

export function ProviderLoginDialog({
  providerName,
  authUrl,
  instructions,
  phase,
  errorMessage,
  manualCode,
  codeValue,
  onCodeChange,
  onSubmitCode,
  onOpenAuthUrl,
  onCancel,
  "data-testid": testId,
}: ProviderLoginDialogProps) {
  const { t } = useTranslation("app");
  /*
  FNXC:ProviderAuth 2026-08-18-04:20:
  Claim the top of the shared floating stack ONCE on open, the same way ConfirmDialog does. The first
  version called `nextFloatingZ()` inline in the parent's JSX, which re-claimed on every render of a
  modal that re-renders on a 2s auth poll — a side effect during render, and a number that changed
  underneath the host window instead of settling above it.
  */
  const [overlayZ, setOverlayZ] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    setOverlayZ(nextFloatingZ());
  }, []);

  if (typeof document === "undefined") {
    return null;
  }

  const signInState = phase === "waiting" ? STEP_STATE.active : STEP_STATE.done;
  const exchangeState =
    phase === "submitting" ? STEP_STATE.active : phase === "succeeded" ? STEP_STATE.done : STEP_STATE.idle;

  return createPortal(
    <div
      className="modal-overlay open provider-login-dialog-overlay"
      style={overlayZ === undefined ? undefined : { zIndex: overlayZ }}
      data-testid={testId}
      /*
      FNXC:ProviderAuth 2026-08-18-04:20:
      STOP REACT-TREE PROPAGATION. A portal moves the DOM node to <body> but NOT the React tree, so
      events raised in here still bubble to whatever rendered it. This dialog is rendered by a
      component hosted in a FloatingWindow, and that window raises itself to a fresh `nextFloatingZ()`
      on every pointerdown/focus it sees — so each click INSIDE this dialog lifted the window above
      it, and the next click landed on the window instead ("it keeps getting covered by the onboarding
      dialog, any click goes to the dialog below"). The parent also renders this outside its
      FloatingWindow subtree; this guard keeps the contract if that ever changes.
      */
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onFocus={(event) => event.stopPropagation()}
    >
      <div className="modal provider-login-dialog" role="dialog" aria-modal="true" aria-label={t("providerLogin.signingInTo", "Signing in to {{provider}}", { provider: providerName })}>
        <div className="modal-header">
          <h3>{t("providerLogin.signingInTo", "Signing in to {{provider}}", { provider: providerName })}</h3>
          <button className="modal-close" onClick={onCancel} aria-label={t("providerLogin.cancel", "Cancel login")} title={t("providerLogin.cancel", "Cancel login")}>
            <X size={18} />
          </button>
        </div>

        <div className="provider-login-dialog__body">
          <ol className="provider-login-dialog__steps">
            <li className={`provider-login-dialog__step ${signInState}`}>
              <span className="provider-login-dialog__step-icon" aria-hidden="true">
                {phase === "waiting" ? <Loader2 size={16} className="provider-login-dialog__spinner" /> : <CheckCircle2 size={16} />}
              </span>
              <span className="provider-login-dialog__step-body">
                <strong>{t("providerLogin.approveInBrowser", "Approve the sign-in in your browser")}</strong>
                <small>
                  {phase === "waiting"
                    ? t("providerLogin.finishInBrowser", "A tab should have opened. Finish signing in there — this dialog stays put.")
                    : t("providerLogin.authorizationReceived", "Authorization received.")}
                </small>
                {authUrl && phase === "waiting" && (
                  <button className="btn btn-sm provider-login-dialog__reopen" onClick={onOpenAuthUrl}>
                    <ExternalLink size={14} /> {t("providerLogin.openSignInAgain", "Open the sign-in page again")}
                  </button>
                )}
              </span>
            </li>

            <li className={`provider-login-dialog__step ${exchangeState}`}>
              <span className="provider-login-dialog__step-icon" aria-hidden="true">
                {phase === "submitting" ? <Loader2 size={16} className="provider-login-dialog__spinner" /> : <CheckCircle2 size={16} />}
              </span>
              <span className="provider-login-dialog__step-body">
                <strong>{t("providerLogin.handAuthorizationBack", "Hand the authorization back to Fusion")}</strong>
                <small>
                  {phase === "submitting"
                    ? t("providerLogin.exchangingCode", "Exchanging the authorization code…")
                    : phase === "succeeded"
                      ? t("providerLogin.connected", "Connected.")
                      : t("providerLogin.pasteRedirectUrl", "Usually automatic. If your browser lands on an error page, paste that page's full URL below.")}
                </small>
              </span>
            </li>
          </ol>

          {instructions && <LoginInstructions instructions={instructions} data-testid="provider-login-dialog-instructions" />}
        </div>

        {/*
        FNXC:ProviderAuth 2026-08-18-05:05:
        PINNED, NOT SCROLLED. The paste field and its Submit are the dialog's reason to exist, so they
        sit outside the scrolling body: with them inside it, a short viewport (or a provider with long
        instructions) pushed Submit below the fold, leaving the operator holding a copied URL and no
        visible way to hand it over. Only the steps and instructions scroll.
        */}
        {phase !== "succeeded" && (
          <div className="provider-login-dialog__paste">
            <OAuthManualCodeForm
              value={codeValue}
              onChange={onCodeChange}
              onSubmit={onSubmitCode}
              prompt={manualCode.prompt}
              placeholder={manualCode.placeholder}
              helpText={manualCode.helpText}
              disabled={phase === "submitting"}
              submitLabel={phase === "submitting" ? "Submitting…" : "Submit code"}
              data-testid="provider-login-dialog-manual-code"
            />
            {phase === "failed" && errorMessage && (
              <p className="field-error provider-login-dialog__error" data-testid="provider-login-dialog-error">
                {errorMessage}
              </p>
            )}
          </div>
        )}

        {phase === "succeeded" && errorMessage && (
          <p className="field-error provider-login-dialog__error" data-testid="provider-login-dialog-error">
            {errorMessage}
          </p>
        )}

        <div className="modal-actions">
          <button className="btn btn-sm" onClick={onCancel}>
            {phase === "succeeded" ? "Close" : "Cancel login"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
