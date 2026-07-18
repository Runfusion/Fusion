/*
FNXC:AppLifecycle 2026-06-24-00:00:
Module-level lifecycle helpers, storage-key constants, and banner/CLI-banner pure functions extracted out of App.tsx so the root component stays an orchestrator. Behavior is byte-identical to the former inline definitions; App.tsx re-exports the unit-tested symbols to preserve its import contract.
*/

import type { AiSessionSummary } from "../api";
import { api, relaunchCliSession } from "../api";
import type { CliActionId } from "../components/SessionNotificationBanner";

export const SETUP_WARNING_DISMISSED_KEY = "kb-setup-warning-dismissed";
export const WORKING_BRANCH_FILTER_STORAGE_KEY = "kb-dashboard-working-branch-filter";
export const BASE_BRANCH_FILTER_STORAGE_KEY = "kb-dashboard-base-branch-filter";
export const NO_BRANCH_FILTER_VALUE = "__fusion:no-branch__";
export const APPROVAL_BANNER_DISMISSED_STORAGE_KEY = "fusion:approval-banner-dismissed";
export const CAPACITY_RISK_DISMISSED_KEY = "kb-capacity-risk-banner-dismissed";
export const RETRY_WARNING_RATIO = 0.8;

export interface ApprovalBannerCandidate {
  dedupeKey: string;
  updatedAtMs: number;
}

export function didEnterAwaitingApproval(nextStatus: string | undefined, previousStatus: string | undefined): boolean {
  return nextStatus === "awaiting-approval" && previousStatus !== "awaiting-approval";
}

export function didEnterDone(nextStatus: string | undefined, previousStatus: string | undefined): boolean {
  return nextStatus === "done" && previousStatus !== undefined && previousStatus !== "done";
}

export function parseDateMs(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function loadApprovalBannerDismissals(): Map<string, number> {
  if (typeof window === "undefined") return new Map();
  try {
    const raw = window.localStorage.getItem(APPROVAL_BANNER_DISMISSED_STORAGE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as Record<string, number>;
    const map = new Map<string, number>();
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        map.set(key, value);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

export function persistApprovalBannerDismissals(map: Map<string, number>): void {
  if (typeof window === "undefined") return;
  try {
    const data: Record<string, number> = {};
    for (const [key, value] of map) {
      data[key] = value;
    }
    window.localStorage.setItem(APPROVAL_BANNER_DISMISSED_STORAGE_KEY, JSON.stringify(data));
  } catch {
    // no-op
  }
}

export function buildRemoteDashboardUrl(serverUrl: string, authToken?: string | null): string {
  const url = new URL(serverUrl);
  if (authToken) {
    url.searchParams.set("rt", authToken);
  }
  return url.toString();
}

export interface DesktopShellRedirectShellState {
  host: "web" | "mobile-shell" | "desktop-shell";
  desktopMode?: "local" | "remote";
  activeProfileId: string | null;
  profiles: Array<{ id: string; serverUrl: string; authToken?: string | null }>;
  localRuntime?: {
    state: "stopped" | "starting" | "running" | "error";
    port?: number;
    baseUrl?: string;
  };
}

/*
 * FNXC:DesktopSwitchServer 2026-07-04-13:20:
 * The in-dashboard "Switch server" (Connection Manager) affordance calls `shellApi.setDesktopMode(...)` /
 * `setActiveProfile(...)` directly and relies on THIS renderer-side redirect to navigate, because it does not
 * route through the Electron main-process launch-mode handlers (`desktopLaunchMode:setMode` in
 * packages/desktop/src/main.ts) the way the native menu does. The desktop preload only ever emits the live
 * `localRuntime` field (see native-shell.d.ts / packages/desktop/src/ipc.ts) — the legacy `localServer` field is
 * never populated and must not be used. This helper is the single decision point shared by both the local- and
 * remote-redirect effects in App.tsx so both switch directions behave like the working native-menu path and
 * so neither introduces a reload loop.
 */
export function resolveDesktopShellRedirectTarget(
  shellState: DesktopShellRedirectShellState,
  currentHref: string,
): string | null {
  if (shellState.host !== "desktop-shell") {
    return null;
  }

  if (shellState.desktopMode === "local") {
    const runtime = shellState.localRuntime;
    if (!runtime || runtime.state !== "running") {
      return null;
    }
    const baseUrl = runtime.baseUrl || (runtime.port ? `http://localhost:${runtime.port}` : undefined);
    if (!baseUrl) {
      return null;
    }
    if (currentHref === baseUrl) {
      return null;
    }
    try {
      const current = new URL(currentHref);
      const target = new URL(baseUrl);
      if (current.origin === target.origin) {
        return null;
      }
    } catch {
      // fall through and navigate — currentHref/baseUrl were not parseable URLs
    }
    return baseUrl;
  }

  if (shellState.desktopMode === "remote") {
    const activeProfile = shellState.profiles.find((profile) => profile.id === shellState.activeProfileId);
    if (!activeProfile) {
      return null;
    }
    const nextUrl = buildRemoteDashboardUrl(activeProfile.serverUrl, activeProfile.authToken ?? null);
    if (currentHref === nextUrl) {
      return null;
    }
    return nextUrl;
  }

  return null;
}

export function requiresNativeShellOnboarding(
  shellState: { host: "web" | "mobile-shell" | "desktop-shell"; desktopMode?: "local" | "remote"; activeProfileId: string | null },
  shellReady: boolean,
  shellOnboardingComplete: boolean,
): boolean {
  if (!shellReady || shellOnboardingComplete || shellState.host === "web") {
    return false;
  }

  if (shellState.host === "mobile-shell") {
    return !shellState.activeProfileId;
  }

  if (shellState.desktopMode === "local") {
    return false;
  }

  return !shellState.activeProfileId;
}

export function shouldShowFirstEverBootLoader(projectsLoading: boolean, projectCount: number): boolean {
  return projectsLoading && projectCount === 0;
}

export function isSessionNeedingInputForBanner(session: AiSessionSummary): boolean {
  return (
    session.status === "awaiting_input" ||
    session.status === "error" ||
    session.status === "waiting_on_input" ||
    session.status === "needs_attention"
  );
}

/*
FNXC:SessionBanner 2026-07-16-20:55:
FN-8229 removes the redundant footer AI pill. Planning has its own docked view
and navigation badge, so it stays out of the banner at every status, including
retained errors. The banner is the replacement progress surface for all other
in-progress and actionable sessions.
*/
export function shouldShowSessionInBanner(session: AiSessionSummary): boolean {
  if (session.type === "planning") return false;
  return isSessionNeedingInputForBanner(session) || session.status === "generating";
}

export function getCliActionDisabledReasonForBanner(session: AiSessionSummary, action: CliActionId): string | null {
  if ((action === "advance" || action === "relaunch") && !session.cliSessionId) {
    return "CLI session id is missing.";
  }
  return null;
}

export interface CliActionDeps {
  currentProjectId?: string;
  retryTask: (id: string) => Promise<unknown>;
  moveTask: (id: string, column: "todo") => Promise<unknown>;
  openAuthenticationSettings: () => void;
  addToast: (message: string, type: "success" | "error") => void;
  apiClient?: typeof api;
  relaunchCliSessionClient?: typeof relaunchCliSession;
}

export async function executeCliSessionBannerAction(
  session: AiSessionSummary,
  action: CliActionId,
  deps: CliActionDeps,
): Promise<void> {
  try {
    /*
     * FNXC:SessionBanner 2026-06-14-19:32:
     * CLI banner verbs must either call an existing dashboard route/flow or be disabled by the banner. `advance` confirms the CLI session, `retry` and `cancel` reuse task operations keyed by the session id until summaries expose a distinct task id, and `reauthenticate` opens the existing authentication settings flow.
     *
     * FNXC:SessionBanner 2026-06-14-20:16:
     * `relaunch` is now a supported route-backed action for resume-exhausted CLI sessions; if `cliSessionId` is absent the handler exits without firing a malformed API call, preserving the no-silent-no-op invariant through the banner disabled reason.
     */
    if (action === "advance") {
      if (!session.cliSessionId) {
        throw new Error("CLI session id is required to advance this session.");
      }
      await (deps.apiClient ?? api)(`/cli-sessions/${encodeURIComponent(session.cliSessionId)}/confirm-advance`, {
        method: "POST",
        body: JSON.stringify({ decision: "advance", ...(deps.currentProjectId ? { projectId: deps.currentProjectId } : {}) }),
      });
      return;
    }

    if (action === "relaunch") {
      if (!session.cliSessionId) return;
      await (deps.relaunchCliSessionClient ?? relaunchCliSession)(session.cliSessionId, deps.currentProjectId);
      deps.addToast("CLI session relaunch requested", "success");
      return;
    }

    if (action === "retry") {
      await deps.retryTask(session.id);
      return;
    }

    if (action === "cancel") {
      await deps.moveTask(session.id, "todo");
      return;
    }

    if (action === "reauthenticate") {
      deps.openAuthenticationSettings();
      return;
    }

    throw new Error("This CLI action is not supported yet.");
  } catch (err) {
    const message = err instanceof Error ? err.message : "CLI action failed";
    deps.addToast(message, "error");
  }
}
