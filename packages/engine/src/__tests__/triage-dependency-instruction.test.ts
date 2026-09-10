import { describe, expect, it } from "vitest";
import { buildPlanningDependencyInstallationInstruction } from "../triage.js";

describe("planning dependency installation instruction", () => {
  it("names unresolved manifests, commands, and the Plan Review consequence", () => {
    const instruction = buildPlanningDependencyInstallationInstruction([{
      repository: "api",
      readiness: {
        readiness: "unresolved",
        plan: [{ ecosystem: "go", manifests: ["go.mod"], command: "go mod download", binary: "go" }],
        evidence: [],
        unresolvedRepos: [{ ecosystem: "go", manifests: ["go.mod"], command: "go mod download", binary: "go" }],
        entries: [{ ecosystem: "go", manifests: ["go.mod"], command: "go mod download", outcome: "toolchain-missing", fingerprint: "one", reason: "Required toolchain is not available on PATH: go" }],
      },
    }]);

    expect(instruction).toContain("## Dependency installation");
    expect(instruction).toContain("`api`");
    expect(instruction).toContain("go.mod");
    expect(instruction).toContain("`go mod download`");
    expect(instruction).toContain("toolchain");
    expect(instruction).toContain("Dependencies are not installed.");
  });

  it("directs unrecognized evidence to the engine-observed planning tool", () => {
    const instruction = buildPlanningDependencyInstallationInstruction([{
      repository: "web",
      readiness: {
        readiness: "unrecognized",
        plan: [],
        evidence: ["flake.nix"],
        unresolvedRepos: [],
        entries: [],
      },
    }]);

    expect(instruction).toContain("flake.nix");
    expect(instruction).toContain("fn_install_worktree_dependencies");
    expect(instruction).toContain("`none`");
  });

  it("explains how an ambiguous uv selection may be closed", () => {
    const instruction = buildPlanningDependencyInstallationInstruction([{ repository: "api", readiness: {
      readiness: "unresolved", evidence: [],
      plan: [{ ecosystem: "python-uv", manifests: ["uv.lock", "pyproject.toml"], command: "uv sync --frozen --all-extras --all-groups", refusal: "configuration-required", refusedCommand: "uv sync --frozen" }],
      unresolvedRepos: [{ ecosystem: "python-uv", manifests: ["uv.lock", "pyproject.toml"], command: "uv sync --frozen --all-extras --all-groups", refusal: "configuration-required", refusedCommand: "uv sync --frozen" }],
      entries: [{ ecosystem: "python-uv", manifests: ["uv.lock"], command: "uv sync --frozen --all-extras --all-groups", outcome: "configuration-required", fingerprint: "one", reason: "test and lint are optional selections; configure worktreeInitCommand" }],
    } }]);
    expect(instruction).toContain("worktreeInitCommand");
    expect(instruction).toContain("explicitly naming extras or groups");
    expect(instruction).toContain("uv sync --frozen");
  });

  it("keeps the common satisfied and dependency-free cases out of the planner prompt", () => {
    expect(buildPlanningDependencyInstallationInstruction([
      { repository: "static", readiness: { readiness: "not-needed", plan: [], evidence: [], unresolvedRepos: [], entries: [] } },
      { repository: "app", readiness: { readiness: "satisfied", plan: [], evidence: [], unresolvedRepos: [], entries: [] } },
    ])).toBe("");
  });
});
