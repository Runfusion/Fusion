import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BackupManager,
  createBackupManager,
  resolveBackendConnectionString,
} from "../backup/backup.js";
import {
  clearActiveEmbeddedRuntimeUrl,
  getActiveEmbeddedRuntimeUrl,
  invalidateEmbeddedRuntimeUrl,
  registerEmbeddedRuntimeUrl,
  releaseEmbeddedRuntimeLease,
} from "../postgres/active-backend-registry.js";

const embeddedUrl = "postgresql://postgres:embedded-secret@127.0.0.1:55432/fusion";
const externalUrl = "postgresql://operator:external-secret@db.example.test:5432/fusion";

afterEach(() => {
  clearActiveEmbeddedRuntimeUrl();
  vi.unstubAllEnvs();
});

describe("embedded backup runtime URL registry", () => {
  it("resolves a registered embedded backend and lets BackupManager construct", () => {
    vi.stubEnv("DATABASE_URL", "");
    registerEmbeddedRuntimeUrl(embeddedUrl, { ownsProcess: true });

    expect(resolveBackendConnectionString()).toBe(embeddedUrl);
    expect(() => createBackupManager("/tmp/project/.fusion")).not.toThrow();
  });

  it("keeps an external DATABASE_URL ahead of the embedded registry", () => {
    vi.stubEnv("DATABASE_URL", externalUrl);
    registerEmbeddedRuntimeUrl(embeddedUrl, { ownsProcess: true });

    expect(resolveBackendConnectionString()).toBe(externalUrl);
  });

  it("preserves the actionable error before an embedded lifecycle boots", () => {
    vi.stubEnv("DATABASE_URL", "");

    expect(resolveBackendConnectionString()).toBeUndefined();
    expect(() => new BackupManager("/tmp/project/.fusion")).toThrow(
      "BackupManager requires a PostgreSQL connection string",
    );
  });

  it("keeps an owner URL live when only a joiner releases", () => {
    const owner = registerEmbeddedRuntimeUrl(embeddedUrl, { ownsProcess: true });
    const joiner = registerEmbeddedRuntimeUrl(embeddedUrl, { ownsProcess: false });

    releaseEmbeddedRuntimeLease(joiner);
    expect(getActiveEmbeddedRuntimeUrl()).toBe(embeddedUrl);

    releaseEmbeddedRuntimeLease(owner);
    expect(getActiveEmbeddedRuntimeUrl()).toBeUndefined();
  });

  it("invalidates every joiner when the postmaster owner stops", () => {
    registerEmbeddedRuntimeUrl(embeddedUrl, { ownsProcess: true });
    registerEmbeddedRuntimeUrl(embeddedUrl, { ownsProcess: false });

    invalidateEmbeddedRuntimeUrl(embeddedUrl);
    expect(resolveBackendConnectionString()).toBeUndefined();
    expect(() => new BackupManager("/tmp/project/.fusion")).toThrow(
      "BackupManager requires a PostgreSQL connection string",
    );
  });

  it("makes an old joiner release inert after owner invalidation and re-registration", () => {
    registerEmbeddedRuntimeUrl(embeddedUrl, { ownsProcess: true });
    const oldJoiner = registerEmbeddedRuntimeUrl(embeddedUrl, { ownsProcess: false });
    invalidateEmbeddedRuntimeUrl(embeddedUrl);
    registerEmbeddedRuntimeUrl(embeddedUrl, { ownsProcess: true });

    releaseEmbeddedRuntimeLease(oldJoiner);
    expect(getActiveEmbeddedRuntimeUrl()).toBe(embeddedUrl);
  });

  it("makes leases from a test reset inert for a re-registered URL", () => {
    const oldLease = registerEmbeddedRuntimeUrl(embeddedUrl, { ownsProcess: false });
    clearActiveEmbeddedRuntimeUrl();
    registerEmbeddedRuntimeUrl(embeddedUrl, { ownsProcess: true });

    releaseEmbeddedRuntimeLease(oldLease);
    expect(getActiveEmbeddedRuntimeUrl()).toBe(embeddedUrl);
  });

  it("does not let a stale owner invalidate a replacement cluster that reused its URL", () => {
    const oldOwner = registerEmbeddedRuntimeUrl(embeddedUrl, { ownsProcess: true });
    const replacementOwner = registerEmbeddedRuntimeUrl(embeddedUrl, { ownsProcess: true });

    invalidateEmbeddedRuntimeUrl(embeddedUrl, oldOwner);
    expect(getActiveEmbeddedRuntimeUrl()).toBe(embeddedUrl);

    releaseEmbeddedRuntimeLease(replacementOwner);
    expect(getActiveEmbeddedRuntimeUrl()).toBeUndefined();
  });

  it("uses the last live registration and ignores unknown invalidation/releases", () => {
    const firstUrl = "postgresql://postgres:a@127.0.0.1:55431/fusion";
    const first = registerEmbeddedRuntimeUrl(firstUrl, { ownsProcess: true });
    const second = registerEmbeddedRuntimeUrl(embeddedUrl, { ownsProcess: false });
    expect(getActiveEmbeddedRuntimeUrl()).toBe(embeddedUrl);

    invalidateEmbeddedRuntimeUrl("postgresql://unknown@127.0.0.1:9/missing");
    releaseEmbeddedRuntimeLease({} as never);
    expect(getActiveEmbeddedRuntimeUrl()).toBe(embeddedUrl);

    releaseEmbeddedRuntimeLease(second);
    expect(getActiveEmbeddedRuntimeUrl()).toBe(firstUrl);
    releaseEmbeddedRuntimeLease(first);
    expect(getActiveEmbeddedRuntimeUrl()).toBeUndefined();
  });
});
