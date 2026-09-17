/** FNXC:ExternalSessions 2026-09-17-04:00: Only these exact POST routes use collector credentials instead of the dashboard bearer token. */
export function isExternalSessionIngestionRequest(req: { method: string; path: string }): boolean {
  return req.method === "POST" && /^\/api\/external-sessions\/(ingest|heartbeat)\/?$/.test(req.path);
}
