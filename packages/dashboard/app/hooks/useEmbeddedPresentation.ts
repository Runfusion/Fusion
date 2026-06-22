/*
FNXC:EmbeddedPresentation 2026-06-22-12:00:
Seven modal components (ActivityLogModal, GitManagerModal, GitHubImportModal, ScheduledTasksModal, PlanningModeModal, SettingsModal, WorkflowNodeEditor) each independently grew the same "embedded vs modal" presentation switch for the right-dock / main-content-area redesign. Each derived `isEmbedded = presentation === "embedded"` locally and gated the same modal-only behaviors off it: mobile scroll lock, modal resize-persist, Escape-to-close, and overlay click-dismiss.

This hook collapses that copy-pasted pattern into one place. The returned booleans are the enabled-arg for the hooks/handlers the components already call (e.g. `useMobileScrollLock(open && scrollLockEnabled)`), so the gating stays a single boolean expression and the underlying hooks remain CALLED UNCONDITIONALLY (React hook rules) — only their enabled arg flips.

Embedded surfaces are persistent main-content destinations owned by the dock/router, so all four modal-only affordances are disabled when embedded; every flag is simply `!isEmbedded`. Modal presentation (the default) keeps every affordance on, byte-identical to the historical behavior.
*/

/** Presentation surface for a component that can render as a fixed dialog overlay or inline in the main content area. */
export type ModalPresentation = "modal" | "embedded";

/**
 * Derived presentation flags shared by the embedded-capable modal components.
 *
 * - `isEmbedded` / `isModal` — the raw mode test.
 * - `scrollLockEnabled` — gate for `useMobileScrollLock`; off when embedded (the host page owns scrolling).
 * - `resizePersistEnabled` — gate for `useModalResizePersist`; off when embedded (the view fills its container).
 * - `escapeEnabled` — gate for Escape-to-close handlers; off when embedded (the dock/router owns lifecycle).
 * - `overlayDismissEnabled` — gate for backdrop click-to-dismiss; off when embedded (no overlay backdrop exists).
 */
export interface EmbeddedPresentation {
  isEmbedded: boolean;
  isModal: boolean;
  scrollLockEnabled: boolean;
  resizePersistEnabled: boolean;
  escapeEnabled: boolean;
  overlayDismissEnabled: boolean;
}

/**
 * Resolve the shared embedded-presentation flags for a component.
 *
 * @param presentation - The component's `presentation` prop. Defaults to "modal" so callers that omit it keep full modal behavior.
 */
export function useEmbeddedPresentation(presentation: ModalPresentation = "modal"): EmbeddedPresentation {
  const isEmbedded = presentation === "embedded";
  // Every modal-only affordance is disabled in embedded mode; embedded surfaces are persistent and host-owned.
  return {
    isEmbedded,
    isModal: !isEmbedded,
    scrollLockEnabled: !isEmbedded,
    resizePersistEnabled: !isEmbedded,
    escapeEnabled: !isEmbedded,
    overlayDismissEnabled: !isEmbedded,
  };
}
