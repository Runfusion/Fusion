import { describe, expect, it } from "vitest";
import {
  classifyDependencyInstallFailure,
  dependencyFailureRepeatsWithoutChange,
  dependencyFailureSignature,
} from "../worktree/dependency-failure-classifier.js";

const result = (stderr: string, overrides: Record<string, unknown> = {}) => ({ stdout: "", stderr, exitCode: 2, timedOut: false, ...overrides });

describe("dependency failure classifier", () => {
  it("classifies stable configuration failures and transient transport failures", () => {
    expect(classifyDependencyInstallFailure(result("No interpreter found for Python >=3.13"))).toEqual({ failureClass: "deterministic", failureCode: "INTERPRETER_INCOMPATIBLE" });
    expect(classifyDependencyInstallFailure(result("unknown dependency group: docs"))).toEqual({ failureClass: "deterministic", failureCode: "INVALID_DEPENDENCY_SELECTION" });
    for (const failure of [result("ECONNRESET"), result("socket hang up"), result("429 rate limit"), result("ignored", { timedOut: true })]) {
      expect(classifyDependencyInstallFailure(failure)).toEqual({ failureClass: "transient", failureCode: "DEPENDENCY_INSTALL_TRANSIENT" });
    }
    expect(classifyDependencyInstallFailure(result("No interpreter found", { spawnError: "ECONNRESET" }))).toEqual({ failureClass: "transient", failureCode: "DEPENDENCY_INSTALL_TRANSIENT" });
  });

  it("normalizes volatile diagnostic details for signatures", () => {
    const same = dependencyFailureSignature({ command: "uv sync", exitCode: 2, diagnostic: "at /tmp/a/foo in 123ms id deadbeef" });
    expect(same).toBe(dependencyFailureSignature({ command: "uv sync", exitCode: 2, diagnostic: "at /var/tmp/b/foo in 999ms id cafe1234" }));
    expect(same).not.toBe(dependencyFailureSignature({ command: "uv sync --all", exitCode: 2, diagnostic: "at /tmp/a/foo in 123ms id deadbeef" }));
    expect(same).not.toBe(dependencyFailureSignature({ command: "uv sync", exitCode: 1, diagnostic: "at /tmp/a/foo in 123ms id deadbeef" }));
    expect(same).not.toBe(dependencyFailureSignature({ command: "uv sync", exitCode: 2, diagnostic: "a meaningful change" }));
  });

  it("requires a proven unchanged state before calling a failure a repeat", () => {
    const prior = { signature: "a", worktreeState: "git:one" };
    expect(dependencyFailureRepeatsWithoutChange(prior, prior)).toBe(true);
    expect(dependencyFailureRepeatsWithoutChange(prior, { signature: "a", worktreeState: "git:two" })).toBe(false);
    expect(dependencyFailureRepeatsWithoutChange(prior, { signature: "b", worktreeState: "git:one" })).toBe(false);
    expect(dependencyFailureRepeatsWithoutChange(prior, { signature: "a", worktreeState: "indeterminate" })).toBe(false);
    expect(dependencyFailureRepeatsWithoutChange({ signature: "a", worktreeState: "indeterminate" }, { signature: "a", worktreeState: "indeterminate" })).toBe(false);
    expect(dependencyFailureRepeatsWithoutChange(undefined, prior)).toBe(false);
  });
});
