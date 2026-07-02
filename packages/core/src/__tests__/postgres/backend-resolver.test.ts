import { describe, it, expect } from "vitest";
import {
  resolveBackend,
  resolveBackendWithOptions,
  looksLikePoolerUrl,
  poolerWarning,
  describeBackendForLog,
  POOLER_PREPARED_STATEMENT_WARNING,
  DATABASE_URL_ENV,
  DATABASE_MIGRATION_URL_ENV,
} from "../../postgres/backend-resolver.js";

describe("backend-resolver: resolveBackend (env-based)", () => {
  it("resolves to embedded mode when DATABASE_URL is unset", () => {
    const backend = resolveBackend({});
    expect(backend.mode).toBe("embedded");
    expect(backend.runtimeUrl).toBeNull();
    expect(backend.migrationUrl).toBeNull();
    expect(backend.migrationUrlOverridden).toBe(false);
  });

  it("resolves to embedded mode when DATABASE_URL is empty", () => {
    const backend = resolveBackend({ [DATABASE_URL_ENV]: "" });
    expect(backend.mode).toBe("embedded");
  });

  it("resolves to embedded mode when DATABASE_URL is whitespace-only", () => {
    const backend = resolveBackend({ [DATABASE_URL_ENV]: "   " });
    expect(backend.mode).toBe("embedded");
  });

  it("resolves to external mode when DATABASE_URL is set (VAL-CONN-002)", () => {
    const url = "postgresql://user:pass@localhost:5432/fusion";
    const backend = resolveBackend({ [DATABASE_URL_ENV]: url });
    expect(backend.mode).toBe("external");
    expect(backend.runtimeUrl).toBe(url);
    expect(backend.migrationUrl).toBe(url); // falls back to runtime
    expect(backend.migrationUrlOverridden).toBe(false);
  });
});

describe("backend-resolver: resolveBackendWithOptions", () => {
  it("DATABASE_URL set resolves to external and skips embedded start", () => {
    const url = "postgresql://user:pass@localhost:5432/fusion";
    const backend = resolveBackendWithOptions({ databaseUrl: url });
    expect(backend.mode).toBe("external");
    expect(backend.runtimeUrl).toBe(url);
  });

  it("DATABASE_URL unset signals embedded mode", () => {
    const backend = resolveBackendWithOptions({ databaseUrl: null });
    expect(backend.mode).toBe("embedded");
    expect(backend.runtimeUrl).toBeNull();
  });

  it("DATABASE_MIGRATION_URL routes schema work to it while runtime uses DATABASE_URL (VAL-CONN-003)", () => {
    const runtimeUrl = "postgresql://user:pass@pooler.supabase.com:6543/fusion";
    const migrationUrl = "postgresql://user:pass@db.supabase.co:5432/fusion";
    const backend = resolveBackendWithOptions({
      databaseUrl: runtimeUrl,
      databaseMigrationUrl: migrationUrl,
    });
    expect(backend.mode).toBe("external");
    expect(backend.runtimeUrl).toBe(runtimeUrl);
    expect(backend.migrationUrl).toBe(migrationUrl);
    expect(backend.migrationUrlOverridden).toBe(true);
  });

  it("migrationUrl falls back to runtimeUrl when DATABASE_MIGRATION_URL is not set", () => {
    const url = "postgresql://user:pass@localhost:5432/fusion";
    const backend = resolveBackendWithOptions({
      databaseUrl: url,
      databaseMigrationUrl: null,
    });
    expect(backend.migrationUrl).toBe(url);
    expect(backend.migrationUrlOverridden).toBe(false);
  });

  it("DATABASE_MIGRATION_URL without DATABASE_URL still resolves to embedded mode", () => {
    const backend = resolveBackendWithOptions({
      databaseUrl: null,
      databaseMigrationUrl: "postgresql://user:pass@localhost:5432/fusion",
    });
    expect(backend.mode).toBe("embedded");
    expect(backend.runtimeUrl).toBeNull();
    // migrationUrl is null in embedded mode (no runtime URL to fall back to)
    expect(backend.migrationUrl).toBeNull();
  });
});

describe("backend-resolver: looksLikePoolerUrl", () => {
  it("detects Supavisor pooler hosts", () => {
    expect(looksLikePoolerUrl("postgresql://user:pw@abc.supavisor.supabase.com:6543/db")).toBe(true);
  });

  it("detects Supabase pooler hosts", () => {
    expect(looksLikePoolerUrl("postgresql://user:pw@xyz.pooler.supabase.com:6543/db")).toBe(true);
  });

  it("detects explicit pgbouncer=true param", () => {
    expect(looksLikePoolerUrl("postgresql://user:pw@localhost:5432/db?pgbouncer=true")).toBe(true);
  });

  it("detects explicit pool_mode=transaction param", () => {
    expect(looksLikePoolerUrl("postgresql://user:pw@localhost:5432/db?pool_mode=transaction")).toBe(true);
  });

  it("does not flag a plain localhost connection", () => {
    expect(looksLikePoolerUrl("postgresql://user:pw@localhost:5432/fusion")).toBe(false);
  });

  it("does not flag a plain remote server", () => {
    expect(looksLikePoolerUrl("postgresql://user:pw@db.example.com:5432/fusion")).toBe(false);
  });
});

describe("backend-resolver: poolerWarning (VAL-CONN-008)", () => {
  it("warns when runtime URL is a pooler and no migration URL is set", () => {
    const backend = resolveBackendWithOptions({
      databaseUrl: "postgresql://user:pw@xyz.pooler.supabase.com:6543/db",
    });
    const warning = poolerWarning(backend);
    expect(warning).not.toBeNull();
    expect(warning).toBe(POOLER_PREPARED_STATEMENT_WARNING);
  });

  it("does not warn when migration URL is set (the split resolves the risk)", () => {
    const backend = resolveBackendWithOptions({
      databaseUrl: "postgresql://user:pw@xyz.pooler.supabase.com:6543/db",
      databaseMigrationUrl: "postgresql://user:pw@db.supabase.co:5432/db",
    });
    expect(poolerWarning(backend)).toBeNull();
  });

  it("does not warn for a non-pooler URL", () => {
    const backend = resolveBackendWithOptions({
      databaseUrl: "postgresql://user:pw@localhost:5432/db",
    });
    expect(poolerWarning(backend)).toBeNull();
  });

  it("does not warn in embedded mode", () => {
    const backend = resolveBackendWithOptions({ databaseUrl: null });
    expect(poolerWarning(backend)).toBeNull();
  });

  it("warning message mentions prepared-statement risk", () => {
    const backend = resolveBackendWithOptions({
      databaseUrl: "postgresql://user:pw@xyz.pooler.supabase.com:6543/db",
    });
    const warning = poolerWarning(backend);
    expect(warning).toMatch(/prepared statement/i);
  });
});

describe("backend-resolver: describeBackendForLog (VAL-CONN-005)", () => {
  it("embedded mode logs without any URL", () => {
    const backend = resolveBackendWithOptions({ databaseUrl: null });
    const desc = describeBackendForLog(backend);
    expect(desc).toContain("embedded");
    expect(desc).not.toContain("postgresql://");
  });

  it("external mode logs a redacted URL (no password)", () => {
    const backend = resolveBackendWithOptions({
      databaseUrl: "postgresql://admin:hunter2@localhost:5432/fusion",
    });
    const desc = describeBackendForLog(backend);
    expect(desc).toContain("external");
    expect(desc).toContain("localhost:5432");
    expect(desc).not.toContain("hunter2");
    expect(desc).toContain("********");
  });

  it("migration URL override is logged with redacted URL", () => {
    const backend = resolveBackendWithOptions({
      databaseUrl: "postgresql://admin:pw1@host1:5432/db",
      databaseMigrationUrl: "postgresql://admin:pw2@host2:5432/db",
    });
    const desc = describeBackendForLog(backend);
    expect(desc).toContain("DATABASE_MIGRATION_URL");
    expect(desc).not.toContain("pw1");
    expect(desc).not.toContain("pw2");
    expect(desc).toContain("host1");
    expect(desc).toContain("host2");
  });
});
