import { describe, expect, it, vi } from "vitest";

import {
  isBenignAbsentRemovalError,
  isRetryableRemovalError,
  removeDirectoryWithRetry,
} from "../worktree/worktree-removal-retry.js";

function codedError(code: string, message = code): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe("removeDirectoryWithRetry", () => {
  it("retries transient EBUSY failures with injected backoff", async () => {
    const rm = vi.fn()
      .mockRejectedValueOnce(codedError("EBUSY"))
      .mockRejectedValueOnce(codedError("EBUSY"))
      .mockResolvedValueOnce(undefined);
    const sleep = vi.fn();

    await expect(removeDirectoryWithRetry({ path: "/clean-room", rm, sleep, backoffMs: 1 })).resolves.toMatchObject({ removed: true, attempts: 3, benignAbsent: false });
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("clears Windows read-only attributes before retrying EPERM", async () => {
    const rm = vi.fn().mockRejectedValueOnce(codedError("EPERM")).mockResolvedValueOnce(undefined);
    const chmod = vi.fn().mockResolvedValue(undefined);

    await expect(removeDirectoryWithRetry({ path: "/clean-room", rm, chmod, sleep: vi.fn(), platform: "win32" })).resolves.toMatchObject({ removed: true, attempts: 2 });
    expect(chmod).toHaveBeenCalledWith("/clean-room", 0o700);
  });

  it("reports a residual path after exhausting the configured retry budget", async () => {
    const rm = vi.fn().mockRejectedValue(codedError("EBUSY", "busy"));

    await expect(removeDirectoryWithRetry({ path: "/clean-room", rm, sleep: vi.fn(), attempts: 3 })).resolves.toMatchObject({ removed: false, attempts: 3, lastCode: "EBUSY" });
    expect(rm).toHaveBeenCalledTimes(3);
  });

  it("treats ENOENT as a one-attempt idempotent removal", async () => {
    const rm = vi.fn().mockRejectedValue(codedError("ENOENT"));

    await expect(removeDirectoryWithRetry({ path: "/missing", rm, sleep: vi.fn() })).resolves.toMatchObject({ removed: true, benignAbsent: true, attempts: 1 });
    expect(rm).toHaveBeenCalledTimes(1);
  });

  it("does not clear attributes on Linux while still retrying errno failures", async () => {
    const rm = vi.fn().mockRejectedValueOnce(codedError("EPERM")).mockResolvedValueOnce(undefined);
    const chmod = vi.fn();

    await removeDirectoryWithRetry({ path: "/clean-room", rm, chmod, sleep: vi.fn(), platform: "linux" });
    expect(chmod).not.toHaveBeenCalled();
  });

  it("keeps stale-registration and transient filesystem classifiers distinct", () => {
    const staleRegistration = Object.assign(new Error("git failed"), { stderr: "fatal: '/clean-room' is not a working tree" });
    expect(isBenignAbsentRemovalError(staleRegistration)).toBe(true);
    expect(isBenignAbsentRemovalError(codedError("ENOENT"))).toBe(true);
    for (const code of ["EBUSY", "EPERM", "ENOTEMPTY"]) {
      expect(isBenignAbsentRemovalError(codedError(code))).toBe(false);
      expect(isRetryableRemovalError(codedError(code))).toBe(true);
    }
  });
});
