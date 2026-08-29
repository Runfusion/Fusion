---
title: Vite API source modules proxied to the backend in dashboard dev mode
date: 2026-06-08
category: integration-issues
module: dashboard-dev-server
problem_type: integration_issue
component: tooling
symptoms:
  - "Agent-browser snapshots show a blank or broken dashboard even though the dashboard source compiles"
  - "Vite module requests such as /api.ts, /api-node.ts, or /api/legacy.ts are forwarded to the backend instead of served by Vite"
  - "Hot-module or cache-busted source requests with query strings can re-enter the backend proxy"
root_cause: config_error
resolution_type: config_change
severity: medium
related_components:
  - development_workflow
tags: [vite, proxy, agent-browser, hmr, dashboard, worktree, source-modules]
---

# Vite API source modules proxied to the backend in dashboard dev mode

## Problem

The dashboard dev server used a broad `/api` proxy rule that caught the app's own Vite source-module requests. In linked-worktree browser verification, that made `agent-browser` see a blank or broken dashboard because requests for files like `/api.ts` and `/api/legacy.ts` were sent to the backend instead of Vite's module pipeline.

## Symptoms

- `agent-browser` could open the page but could not reliably inspect the Settings UI because the dashboard failed during module loading.
- Direct requests for `/api.ts`, `/api-node.ts`, and `/api/legacy.ts` returned backend/proxy behavior instead of JavaScript from Vite.
- `/api/health` still needed to proxy to the dashboard backend, so simply disabling the proxy was not a valid fix.
- The first regex fix excluded only paths ending in `.ts`; review caught that Vite can append query strings, so `/api/foo.ts?x=1` would still proxy.

## What Didn't Work

- Treating this as an `agent-browser` problem. The browser automation was working; the page it loaded was failing because module requests were misrouted.
- Debugging linked-worktree HMR as a stale bundle issue. Stale bundles are a real worktree trap, but here direct URL checks showed Vite source module paths were being routed to the backend.
- Switching the proxy from `"/api"` to a regex that only excluded `\.ts$`. That fixed plain `/api/foo.ts` but missed query-string requests that Vite may use for module import and HMR cache busting.
- Removing or bypassing the API proxy. Real backend endpoints such as `/api/health` still need to reach the API server during dev.

## Solution

Keep the backend proxy for real API endpoints, but make the proxy key exclude Vite source-module paths under `/api*`.

```ts
// Before: prefix proxy caught both backend endpoints and source modules.
proxy: {
  "/api": {
    target: `http://localhost:${process.env.FUSION_API_PORT ?? "4040"}`,
    changeOrigin: true,
    ws: true,
  },
}
```

The final proxy rule:

```ts
// packages/dashboard/vite.config.ts
server: {
  proxy: {
    // Keep Vite source modules under app/api* on the dev server while proxying real API endpoints.
    "^/api(?!/.*\\.[jt]sx?(?:\\?|$))(/|$)": {
      target: `http://localhost:${process.env.FUSION_API_PORT ?? "4040"}`,
      changeOrigin: true,
      ws: true,
    },
  },
}
```

Verify both sides of the boundary:

```bash
# Should be served by Vite as JavaScript modules.
curl -i "$DASHBOARD_URL/api.ts"
curl -i "$DASHBOARD_URL/api-node.ts"
curl -i "$DASHBOARD_URL/api/legacy.ts?import"

# Should still proxy to the backend API server.
curl -i "$DASHBOARD_URL/api/health"
```

After the fix, `agent-browser` could snapshot the dashboard and navigate Settings -> Project Models, including the Plan/Triage, Executor, and Reviewer controls.

## Why This Works

Vite treats proxy keys beginning with `^` as regular expressions matched against the request URL. The dashboard has source modules whose served URLs begin with `/api`, while the backend API namespace also begins with `/api`; a prefix rule cannot distinguish them.

The negative lookahead rejects source-module extensions before the proxy claims the request:

- `/api/health` matches the proxy and reaches the backend.
- `/api/legacy.ts` does not match the proxy and stays on Vite.
- `/api/legacy.ts?import` also stays on Vite because the source-extension check allows an optional query string.
- `.tsx`, `.js`, and `.jsx` are excluded too so future source modules do not rediscover the same failure.

## Prevention

- When adding a Vite dev-server proxy, test both a real backend endpoint and any source modules that share the same URL prefix.
- Include query-string cases in proxy-regex checks; Vite module and HMR requests are often not bare pathnames.
- Prefer a short inline comment for subtle proxy regexes so future maintainers know which requests must stay on Vite.
- If browser automation sees a blank dashboard, confirm module routing with direct `curl` checks before debugging the browser tool.

## Related Issues

- [Browser-testing the Fusion dashboard from a worktree safely](../developer-experience/browser-testing-dashboard-from-worktree-safely.md) — neighboring worktree browser-testing traps: live engine hazards, reserved ports, and stale bundles.
- [CSS animations silently frozen by transition tokens used as durations](../ui-bugs/css-animation-frozen-by-transition-token-shape-mismatch.md) — mentions the older dev-server blank-page trap from broad `/api` proxying.
