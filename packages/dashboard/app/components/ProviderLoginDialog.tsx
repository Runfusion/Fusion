import { ViewHeader } from "./ViewHeader";
import { useTranslation } from "react-i18next";
import { CheckCircle2, ExternalLink, Loader2 } from "lucide-react";
import { OAuthManualCodeForm } from "./OAuthManualCodeForm";
import { LoginInstructions } from "./LoginInstructions";
import "./ProviderLoginDialog.css";
import { FloatingWindow } from "./FloatingWindow";

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
  Claim the top of the shared floating stack ONCE on open. FN-394 delegates that claim to FloatingWindow,
  which raises a newly opened window above every other window regardless of type and never re-claims on
  the 2s auth poll re-render.
  */

  if (typeof document === "undefined") {
    return null;
  }

  const signInState = phase === "waiting" ? STEP_STATE.active : STEP_STATE.done;
  const exchangeState =
    phase === "submitting" ? STEP_STATE.active : phase === "succeeded" ? STEP_STATE.done : STEP_STATE.idle;

  /*
  FNXC:FloatingWindowDialogHosts 2026-09-14-22:36:
  FN-394 hosts the provider sign-in in the shared FloatingWindow as a BLOCKING window, so the OAuth
  protection is unchanged: it still covers the app, still owns its own focus boundary, and snapping or
  moving another window can never implicitly cancel or approve a sign-in.
  */
  return (
    <FloatingWindow
      windowKey={`provider-login-${providerName}`}
      modal
      hideHeader
      surfaceGroup="dialog"
      title={t("providerLogin.signingInTo", "Signing in to {{provider}}", { provider: providerName })}
      ariaLabel={t("providerLogin.signingInTo", "Signing in to {{provider}}", { provider: providerName })}
      onClose={onCancel}
      dragHandleSelector=".provider-login-dialog .modal-header"
      className="floating-window--dialog floating-window--provider-login"
      overlayClassName="provider-login-dialog-overlay"
      defaultSize={{ width: 560, height: 520 }}
      minSize={{ width: 320, height: 240 }}
      suspendGeometryPersistenceOnMobile
      suspendGeometryPersistenceOnShortViewport
      testId={testId}
    >
      <div className="modal provider-login-dialog">
        {/*
        FNXC:ProviderAuth 2026-08-18-04:20:
        A portal moves the DOM node to <body> but NOT the React tree, so a click inside this dialog used to
        bubble to the FloatingWindow that rendered it and lift that window above this static dialog ("any
        click goes to the dialog below").

        FNXC:FloatingWindowDialogHosts 2026-09-14-22:36:
        FN-394 makes the sign-in its own window, so it claims the top of the shared stack itself and a pointer
        press here raises THIS window last (its capture handler runs after its ancestors'). The former
        stop-propagation guard is gone because it also swallowed the delegated header drag, which would have
        made this the only dialog that cannot be moved or snapped.
        */}
        {/* FNXC:StandardizedViewLayout 2026-09-13-21:49: Shared dialog chrome; the cancel-login exit keeps its own label and behaviour. */}
        <ViewHeader
          className="modal-header"
          headingLevel={3}
          title={t("providerLogin.signingInTo", "Signing in to {{provider}}", { provider: providerName })}
          onClose={onCancel}
          closeButtonProps={{ "aria-label": t("providerLogin.cancel", "Cancel login"), title: t("providerLogin.cancel", "Cancel login") }}
        />

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
    </FloatingWindow>
  );
}
