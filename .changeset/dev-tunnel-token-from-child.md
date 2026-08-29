---
"@runfusion/fusion": patch
---

summary: `pnpm dev --tunnel` now prints the dev server's real token instead of reporting none.
category: fix
dev: The tunnel banner re-derived the token by reading `~/.fusion/settings.json`, which is not a reliable source — on a real run that file held no `daemonToken` while the dashboard printed a working token two lines above, so the banner fell back to its `token-pending` wording. The dashboard now includes its resolved `dashboardAuthToken` in the `DEV_SERVER_LISTENING_MESSAGE` IPC report alongside the bound port, and `resolveDevTunnelAuth` prefers that `reportedToken` over the env/file lookup, which remains only for targets that report nothing (an explicit `--tunnel=PORT`). The token crosses the existing parent/child IPC channel only; it is never logged or forwarded.
