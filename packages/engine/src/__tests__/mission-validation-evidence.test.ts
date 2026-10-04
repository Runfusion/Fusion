import { describe, expect, it, vi } from "vitest";
import { LandedValidationEvidenceProvider } from "../missions/mission-validation-evidence.js";

describe("LandedValidationEvidenceProvider", () => {
  it("materializes the linked task's exact landed SHA without selecting a remote", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const materialize = vi.fn().mockResolvedValue({ dir: "/disposable", dispose });
    const provider = new LandedValidationEvidenceProvider({ materialize, assertSourceClean: vi.fn() });

    const evidence = await provider.prepare({
      rootDir: "/repository-with-upstream-remote",
      task: { mergeDetails: { commitSha: "landed-sha-A" } } as any,
      landedSha: "landed-sha-A",
    });

    expect(materialize).toHaveBeenCalledWith("/repository-with-upstream-remote", "landed-sha-A");
    expect(evidence.checkout?.dir).toBe("/disposable");
    expect(evidence.unavailable).toBeUndefined();
  });

  it("returns bounded durable receipts and read-only forge records when required", async () => {
    const provider = new LandedValidationEvidenceProvider(
      { materialize: vi.fn().mockResolvedValue({ dir: "/disposable", dispose: vi.fn() }), assertSourceClean: vi.fn() },
      { read: vi.fn().mockResolvedValue({ records: [{ source: "forge-record", identifier: "pr:12", excerpt: "Merged pull request comment" }] }) },
    );

    const evidence = await provider.prepare({
      rootDir: "/repo",
      task: { mergeDetails: { commitSha: "landed-sha-C" }, log: [{ action: "merge", outcome: "landed", timestamp: "2026-10-04T00:00:00.000Z" }] } as any,
      landedSha: "landed-sha-C",
      requiresForgeEvidence: true,
    });

    expect(evidence.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "durable-task-evidence", identifier: "landed-commit:landed-sha-C" }),
      expect.objectContaining({ source: "forge-record", identifier: "pr:12" }),
    ]));
  });

  it("redacts task-log receipts before they enter validator evidence", async () => {
    const provider = new LandedValidationEvidenceProvider({ materialize: vi.fn().mockResolvedValue({ dir: "/disposable", dispose: vi.fn() }), assertSourceClean: vi.fn() });

    const evidence = await provider.prepare({
      rootDir: "/repo",
      task: { mergeDetails: { commitSha: "landed-sha-safe" }, log: [{ action: "deploy Authorization: Bearer sk-live-ABCDEFG1234567890abcdef" }] } as any,
      landedSha: "landed-sha-safe",
    });

    expect(evidence.records.map((record) => record.excerpt).join("\n")).not.toContain("sk-live-ABCDEFG1234567890abcdef");
  });

  it("reports forge unavailability independently after materializing the landed revision", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const provider = new LandedValidationEvidenceProvider(
      { materialize: vi.fn().mockResolvedValue({ dir: "/disposable", dispose }), assertSourceClean: vi.fn() },
      { read: vi.fn().mockRejectedValue(new Error("credential must stay redacted")) },
    );

    await expect(provider.prepare({
      rootDir: "/repo",
      task: { mergeDetails: { commitSha: "landed-sha-forge" } } as any,
      landedSha: "landed-sha-forge",
      requiresForgeEvidence: true,
    })).resolves.toMatchObject({
      checkout: { dir: "/disposable" },
      unavailable: { source: "forge-record", retryable: true, reason: "configured forge record read is unavailable" },
    });
    expect(dispose).not.toHaveBeenCalled();
  });

  it("reports forge reader absence separately after materializing the landed revision", async () => {
    const provider = new LandedValidationEvidenceProvider(
      { materialize: vi.fn().mockResolvedValue({ dir: "/disposable", dispose: vi.fn() }), assertSourceClean: vi.fn() },
    );

    await expect(provider.prepare({
      rootDir: "/repo",
      task: { mergeDetails: { commitSha: "landed-sha-forge" } } as any,
      landedSha: "landed-sha-forge",
      requiresForgeEvidence: true,
    })).resolves.toMatchObject({
      unavailable: { source: "forge-record", retryable: true, reason: "configured forge reader is unavailable" },
    });
  });

  it("reports missing or inaccessible delivered revisions as retryable checkout evidence", async () => {
    const materialize = vi.fn().mockRejectedValue(new Error("transport unavailable"));
    const provider = new LandedValidationEvidenceProvider({ materialize, assertSourceClean: vi.fn() });

    await expect(provider.prepare({
      rootDir: "/repo",
      task: { mergeDetails: { commitSha: "landed-sha-B" } } as any,
      landedSha: "landed-sha-B",
    })).resolves.toMatchObject({
      unavailable: { source: "repository-checkout", retryable: true, reason: "landed revision checkout is unavailable" },
    });

    await expect(provider.prepare({
      rootDir: "/repo",
      task: { mergeDetails: {} } as any,
      landedSha: "landed-sha-B",
    })).resolves.toMatchObject({
      unavailable: { source: "repository-checkout", retryable: true, reason: "landed merge SHA is unavailable" },
    });
  });
});
