/**
 * Shared visual shell for the three runtime-provider settings cards
 * (Hermes, OpenClaw, Paperclip).
 *
 * Renders a consistent header (logo + name + status badge + Learn more link),
 * a description block, a slot for connection-mode tabs, the form contents the
 * caller passes as children, and a footer with Test/Save/Save & Test buttons
 * plus a status toast that surfaces probe + save outcomes.
 */

import { ReactNode } from "react";
import { Loader2 } from "lucide-react";

export type RuntimeStatusKind = "neutral" | "ok" | "err" | "loading";

export interface RuntimeCardShellProps {
  /** Name shown next to the logo (e.g. "Hermes"). */
  name: string;
  /** Optional sub-line under the name (e.g. "by Nous Research"). */
  subname?: string;
  /** The provider logo. Use a `<ProviderIcon>` or an inline `<img>` for brand SVGs. */
  logo: ReactNode;
  /** "Learn more" target — official documentation/site. */
  learnMoreHref: string;
  /** Status kind drives the badge color. */
  statusKind: RuntimeStatusKind;
  /** Status text (e.g. "✓ Detected v0.8.0"). */
  statusText: string;
  /** Description shown under the header. */
  description: ReactNode;
  /** Optional extra header chrome (e.g. tabs). Rendered above the form. */
  tabs?: ReactNode;
  /** The form fields. */
  children: ReactNode;
  /** Disabled state for the action row. */
  busy: "loading" | "saving" | "testing" | "save-test" | null;
  /** Disable Test if some required input is missing. */
  canTest?: boolean;
  /** Toast under the action row — shown when not null. */
  toast?: { kind: "ok" | "err"; message: string } | null;
  onTest: () => void;
  onSave: () => void;
  onSaveAndTest: () => void;
  /** Optional extra content right above the footer (e.g. an install hint). */
  belowForm?: ReactNode;
  /** A test-id forwarded to the root element. */
  testId?: string;
}

export function RuntimeCardShell(props: RuntimeCardShellProps) {
  const {
    name,
    subname,
    logo,
    learnMoreHref,
    statusKind,
    statusText,
    description,
    tabs,
    children,
    busy,
    canTest = true,
    toast,
    onTest,
    onSave,
    onSaveAndTest,
    belowForm,
    testId,
  } = props;

  const statusClass =
    statusKind === "ok"
      ? "runtime-card__status runtime-card__status--ok"
      : statusKind === "err"
        ? "runtime-card__status runtime-card__status--err"
        : "runtime-card__status runtime-card__status--neutral";

  return (
    <div className="runtime-card" data-testid={testId} aria-live="polite">
      <header className="runtime-card__header">
        <span className="runtime-card__logo">{logo}</span>
        <div className="runtime-card__title">
          <h3 className="runtime-card__name">{name}</h3>
          {subname && (
            <small className="runtime-card__cobrand">{subname}</small>
          )}
          <small className={statusClass}>
            {statusKind === "loading" && <Loader2 size={12} className="animate-spin" />}
            {statusText}
          </small>
        </div>
        <a
          className="runtime-card__learn-more btn btn-sm btn-ghost"
          href={learnMoreHref}
          target="_blank"
          rel="noreferrer"
        >
          Learn more →
        </a>
      </header>

      <p className="runtime-card__description">{description}</p>

      {tabs}

      <div className="runtime-card__form">{children}</div>

      {belowForm}

      <footer className="runtime-card__footer">
        {toast && (
          <span
            className={
              toast.kind === "ok"
                ? "runtime-card__toast runtime-card__toast--ok"
                : "runtime-card__toast runtime-card__toast--err"
            }
            role="status"
          >
            {toast.message}
          </span>
        )}
        <button
          type="button"
          className="btn btn-sm"
          onClick={onTest}
          disabled={busy !== null || !canTest}
        >
          {busy === "testing" ? (
            <>
              <Loader2 size={12} className="animate-spin" /> Testing…
            </>
          ) : (
            "Test"
          )}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={onSave}
          disabled={busy !== null}
        >
          {busy === "saving" ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={onSaveAndTest}
          disabled={busy !== null || !canTest}
        >
          {busy === "save-test" ? (
            <>
              <Loader2 size={12} className="animate-spin" /> Saving…
            </>
          ) : (
            "Save & Test"
          )}
        </button>
      </footer>
    </div>
  );
}
