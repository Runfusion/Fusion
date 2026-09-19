---
"@runfusion/fusion": minor
---

summary: Close three ways the dashboard API could be served or ungated without authentication.
category: security
dev: |
  Three independent fixes, none of which depend on the identity/actor model (plan U22, U19, U20 in
  docs/plans/2026-08-07-001-feat-pluggable-user-identity-plan.md).

  1. A launch with no daemon token no longer serves `/api/*` open. Auth previously mounted only
     `if (daemonToken)`, so whether the API was protected depended on how the process happened to be
     started. Serving unauthenticated is now an explicit opt-in (`--no-auth` / `noAuth: true`); a launch
     with neither a token nor that flag refuses `/api/*` with 503 via
     `createUnconfiguredAuthRefusalMiddleware()`. The same inversion was applied to the three WebSocket
     upgrade paths (terminal, badge, cli-session), which had the identical `token && !noAuth && !authed`
     short-circuit and therefore accepted every upgrade when no token was configured.
  2. The Electron desktop host passed no token and called `app.listen(0)` with no host argument, binding
     all interfaces — exposing the whole API including the shell-capable terminal WebSocket to the LAN.
     Both desktop entrypoints (`local-server.ts`, `local-runtime.ts`) now mint a per-process token and bind
     `127.0.0.1`, matching the existing pin in `fn dashboard`. The token reaches the renderer over the
     channel `baseUrl` already used (runtime status -> `shell:getState` IPC -> `?token=` on navigation).
  3. `POST /api/action-gate/reload` is deleted. It replaced the action gate's module-global exempt-tool
     set process-wide, and because `exempt` maps straight to `allow`, one request could disable agent
     action gating for every agent in every project at any preset — unaudited and unscoped. The
     in-process `reloadExemptTools()` / `addToExemptTools()` helpers remain for engine and test use.

  Tests that boot a server now declare `noAuth: true` explicitly rather than relying on the previous
  implicit-open behavior.
