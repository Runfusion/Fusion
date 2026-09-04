/*
FNXC:DashboardResume 2026-08-05-18:08:
Focus-only tab returns are a supported card-resume path distinct from visibility and pageshow. Keep the
trace vocabulary explicit so operators can distinguish its authoritative revalidation from SSE recovery.

FNXC:DashboardResume 2026-08-28-00:13:
FN-205 found the client emitting the supported `focus` trigger while the diagnostics route used a stale
local list and rejected the entire batch. This browser- and server-safe registry is the single vocabulary
so valid resume diagnostics cannot drift between the two bundles.
*/
export const RESUME_TRIGGERS = [
  "visibility",
  "focus",
  "pageshow",
  "sse-error",
  "sse-reconnect",
  "sse-open",
  "remount",
  "route-active",
  "route-inactive",
  "project-context-change",
] as const;

export type ResumeTrigger = (typeof RESUME_TRIGGERS)[number];

export function isResumeTrigger(value: unknown): value is ResumeTrigger {
  return typeof value === "string" && (RESUME_TRIGGERS as readonly string[]).includes(value);
}
