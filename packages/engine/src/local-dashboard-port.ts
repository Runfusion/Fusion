/*
FNXC:RemoteAccess 2026-08-19-04:00:
The port this process's dashboard is actually serving on.

Remote tunnels used to point at a hardcoded `http://localhost:4040`. That is only correct when the
dashboard happens to hold 4040: `fn dashboard --port`, a `PORT` override, or the EADDRINUSE path in
runDashboard (which rebinds to an ephemeral port) all move it, and the tunnel then published
whatever ELSE owned 4040 — another Fusion, another app, or nothing — under a URL the operator
believes is theirs. The identical mistake in `pnpm dev --tunnel` published a container's own Fusion
instead of the dev server, which is what made it worth hunting down here.

The dashboard records its bound port here as soon as it is listening; the engine reads it when
building tunnel arguments. Same process in every shipping configuration (the dashboard route calls
`engine.startRemoteTunnel()` in-process), so a module-scoped value is the whole mechanism. The 4040
default only applies before anything has reported, which preserves the previous behaviour rather
than inventing a new failure.
*/

/** Port assumed when nothing has reported one — the historical dashboard default. */
export const DEFAULT_DASHBOARD_PORT = 4040;

let reportedPort: number | undefined;

/** Record the port the dashboard is listening on. Called once the server is bound. */
export function setLocalDashboardPort(port: number): void {
  if (!Number.isFinite(port) || port <= 0) return;
  reportedPort = Math.floor(port);
}

/** The dashboard's reported port, or the historical default when it has not reported yet. */
export function getLocalDashboardPort(): number {
  return reportedPort ?? DEFAULT_DASHBOARD_PORT;
}

/** Test seam: forget any reported port. */
export function resetLocalDashboardPortForTests(): void {
  reportedPort = undefined;
}
