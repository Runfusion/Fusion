/*
FNXC:PgTestProvisioning 2026-08-22-16:55:
A TCP-open PostgreSQL listener can still reject the harness identity or lack PL/pgSQL.
Keep the remediation at the raising seams so failed test setup names the local provisioning command.
*/
export function decoratePgProvisioningError(error: unknown, _urlBase: string): unknown {
  if (!(error instanceof Error)) return error;

  const code = (error as Error & { code?: string }).code;
  const message = error.message;
  let remediation: string | undefined;
  if (code === "58P01" && message.includes("$libdir/plpgsql")) {
    remediation = " PostgreSQL cannot load PL/pgSQL. Run pnpm pg:test:up -- --replace to replace a broken local test server.";
  } else if (code === "28000" && /role\s+["'][^"']+["']\s+does not exist/i.test(message)) {
    remediation = " PostgreSQL is reachable but lacks the configured login role. Run pnpm pg:test:up.";
  } else if (code === "3D000" && /database\s+["'][^"']+["']\s+does not exist/i.test(message)) {
    remediation = " PostgreSQL lacks the configured database. Run pnpm pg:test:up; postgres@3.4.9 resolves the database from the URL path, then PGDATABASE, then the role name.";
  } else if (code === "ECONNREFUSED" || /ECONNREFUSED/.test(message)) {
    remediation = " PostgreSQL refused the connection. Run pnpm pg:test:up.";
  }
  if (!remediation) return error;
  const decorated = new Error(`${message}${remediation}`);
  Object.assign(decorated, error);
  return decorated;
}
