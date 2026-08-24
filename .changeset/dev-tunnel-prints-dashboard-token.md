---
"@runfusion/fusion": patch
---

summary: `pnpm dev --tunnel` now prints the dashboard token and a ready-to-open link for the tunnel URL.
category: fix
dev: The tunnel banner previously printed a bare URL labelled "public, unauthenticated", which was wrong for its own default target: `--tunnel` with no port aims at the dashboard, which is bearer-token gated, so the recipient hit a 401 with no token to supply. `resolveDevTunnelAuth` now classifies the target as `token` (dashboard with auth on — prints the token plus a `?token=` link, resolved from `FUSION_DASHBOARD_TOKEN`/`FUSION_DAEMON_TOKEN`/`~/.fusion/settings.json`), `token-pending` (first run, token not minted yet — defers to the dashboard's own banner), `no-auth`, or `foreign` (a non-dashboard port, the only case that is genuinely ungated). Auth is resolved at banner time, after the dev child has started, so a freshly minted token is already readable.
