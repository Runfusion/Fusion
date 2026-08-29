/*
FNXC:MigrationHoldingPage 2026-07-17-12:25:
The dashboard HTTP server only starts listening AFTER createTaskStoreForBackend
resolves, and that call performs the one-time SQLite→PostgreSQL auto-migration,
which can copy hundreds of thousands of rows and take minutes. During that window
the dashboard port was simply closed: a browser navigating to the dashboard saw
"connection refused" and an already-open dashboard tab silently failed its
fetches with no explanation.

This module binds a tiny temporary HTTP server on the dashboard port for the
boot window and releases it just before the real server's app.listen():
- Any page request gets a self-contained 503 holding page ("Database migration
  in progress") that polls /api/health and reloads itself into the real
  dashboard once boot completes.
- GET /api/health returns 200 JSON with status "starting" (no migration seen
  yet) or "migrating" plus a structured progress snapshot. Already-open
  dashboard tabs poll /api/health every 15s (useDashboardHealth) and use the
  "migrating" status to show the MigrationInProgressBanner instead of failing
  silently. The payload intentionally omits engine/database/taskIdIntegrity so
  the frontend's optional-chained banner gates stay quiet during boot.
- All other /api/* requests get 503 JSON so in-flight app fetches fail cleanly
  instead of parsing HTML.

Bind failures (e.g. port already in use) are soft: boot proceeds without the
holding page and the existing app.listen EADDRINUSE fallback still applies.
*/
import { createServer, type Server } from "node:http";
import { formatMigrationProgress, type MigrationProgressEvent } from "@fusion/core";

export interface MigrationHoldingServer {
  /** The actual bound port (useful when 0 was requested in tests). */
  readonly port: number;
  /** Record the latest structured migration event for the health payload/page. */
  setMigrationProgress(event: MigrationProgressEvent): void;
  /** Release the port. Resolves once every connection is torn down. */
  close(): Promise<void>;
}

interface StartOptions {
  readonly port: number;
  readonly host: string;
  readonly log?: (message: string) => void;
}

/*
FNXC:MigrationHoldingPage 2026-07-17-12:25:
The holding page must be fully self-contained (no dashboard bundle is served
yet), dark, and on-brand (all-blue). It polls /api/health every 1.5s: while the
status is "starting"/"migrating" it updates the progress line; once any other
status (the real server) answers it reloads into the real dashboard. Repeated
fetch failures flip the copy to a "cannot reach Fusion" hint so a crashed boot
does not masquerade as a forever-running migration.
*/
function renderHoldingPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fusion — starting</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #0b0e14; color: #e6e9ef;
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .card { max-width: 30rem; padding: 2rem; text-align: center; }
  .spinner {
    width: 2.25rem; height: 2.25rem; margin: 0 auto 1.25rem;
    border: 3px solid rgba(59, 130, 246, 0.25); border-top-color: #3b82f6;
    border-radius: 50%; animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  h1 { font-size: 1.15rem; margin: 0 0 0.5rem; font-weight: 600; }
  p { margin: 0 0 0.75rem; color: #9aa4b2; }
  .progress { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85rem; color: #7fb1ff; min-height: 1.5em; overflow-wrap: anywhere; }
  .offline { color: #f0883e; }
</style>
</head>
<body>
<div class="card" role="status" aria-live="polite">
  <div class="spinner" aria-hidden="true"></div>
  <h1 id="title">Fusion is starting…</h1>
  <p id="subtitle">If a database migration is needed it runs now and can take a few minutes for large projects. This page reloads automatically when the dashboard is ready.</p>
  <div class="progress" id="progress"></div>
</div>
<script>
(function () {
  var failures = 0;
  var sawMigration = false;
  async function poll() {
    try {
      var res = await fetch("/api/health", { cache: "no-store" });
      if (!res.ok) return;
      failures = 0;
      var data = await res.json();
      if (data && (data.status === "starting" || data.status === "migrating")) {
        if (data.status === "migrating") {
          sawMigration = true;
          document.getElementById("title").textContent = "Database migration in progress";
        }
        var label = data.migration && data.migration.label;
        if (label) document.getElementById("progress").textContent = label;
        return;
      }
      location.reload();
    } catch (err) {
      failures += 1;
      if (failures >= 8) {
        document.getElementById("progress").innerHTML =
          '<span class="offline">Cannot reach Fusion — it may have stopped. Check the terminal, then reload.</span>';
      }
    }
  }
  poll();
  setInterval(poll, 1500);
})();
</script>
</body>
</html>`;
}

export async function startMigrationHoldingServer(
  options: StartOptions,
): Promise<MigrationHoldingServer | null> {
  let latest: MigrationProgressEvent | null = null;

  const server: Server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/api/health" || url.startsWith("/api/health?")) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({
        status: latest ? "migrating" : "starting",
        holding: true,
        migration: latest
          ? {
              active: true,
              phase: latest.phase,
              label: formatMigrationProgress(latest),
              ...("table" in latest ? { table: latest.table, tableIndex: latest.tableIndex, tableCount: latest.tableCount } : {}),
              ...(latest.phase === "table-progress" ? { processedRows: latest.processedRows, sourceRows: latest.sourceRows } : {}),
            }
          : { active: false },
      }));
      return;
    }
    if (url.startsWith("/api/")) {
      res.writeHead(503, { "content-type": "application/json", "retry-after": "2" });
      res.end(JSON.stringify({ error: "Fusion is starting (database migration may be in progress)" }));
      return;
    }
    res.writeHead(503, { "content-type": "text/html; charset=utf-8", "retry-after": "2", "cache-control": "no-store" });
    res.end(renderHoldingPage());
  });

  const bound = await new Promise<boolean>((resolve) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      options.log?.(`migration holding page not available (${error.code ?? error.message}); continuing boot without it`);
      resolve(false);
    });
    server.listen(options.port, options.host, () => resolve(true));
  });
  if (!bound) return null;

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;

  let closed: Promise<void> | null = null;
  return {
    port,
    setMigrationProgress(event: MigrationProgressEvent): void {
      latest = event;
    },
    close(): Promise<void> {
      if (closed) return closed;
      closed = new Promise<void>((resolve) => {
        server.close(() => resolve());
        /*
        FNXC:MigrationHoldingPage 2026-07-17-12:25:
        Keep-alive sockets from the polling page would otherwise hold the port
        open past close() and race the real app.listen() on the same port.
        */
        server.closeAllConnections();
      });
      return closed;
    },
  };
}
