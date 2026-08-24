---
"@runfusion/fusion": patch
---

summary: Remote tunnels now target the port the dashboard is really on, instead of assuming 4040.
category: fix
dev: An audit for repeats of the `pnpm dev --tunnel` port bug found the same mistake shipped in remote access: `ProjectEngine`'s Cloudflare quick tunnel hardcoded `http://localhost:4040`, so a dashboard started with `--port`, with a `PORT` override, or rebound to an ephemeral port by `runDashboard`'s EADDRINUSE path published a public tunnel to whatever else owned 4040 — another app, another Fusion, or nothing. `setLocalDashboardPort()` records the bound port (from both `runDashboard` and headless `serve`) and `getLocalDashboardPort()` supplies the tunnel target, defaulting to 4040 only while nothing has reported. `register-discovery-routes` already derived its port from `req.socket.localPort` and is unchanged.
