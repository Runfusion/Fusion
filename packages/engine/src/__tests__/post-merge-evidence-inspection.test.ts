import { describe, expect, it, vi } from "vitest";
import { readPostMergeArtifact } from "../executor/read-post-merge-artifact.js";
vi.mock("../executor/read-post-merge-artifact.js", () => ({ readPostMergeArtifact: vi.fn(async () => "artifact evidence") }));
import { createPostMergeInspectionTool } from "../executor/post-merge-evidence-inspection.js";

function harness() {
  const run = vi.fn(async () => ({ stdout: "evidence", stderr: "" }));
  const deps = { rootDir: "/project", store: { getTask: vi.fn(async () => ({ workspaceWorktrees: { app: { worktreePath: "/task/app" } } })) } };
  const tool = createPostMergeInspectionTool(deps as never, "FN-1", run);
  return { run, invoke: (params: Record<string, unknown>) => tool.execute("call", params, undefined, undefined, undefined as never) };
}

describe("bounded post-merge evidence inspection", () => {
  it.each([
    ["git_ref", { ref: "main" }, ["rev-parse", "--verify", "main^{commit}"]],
    ["git_diff", { ref: "abc123", otherRef: "main", path: "src/app.ts" }, ["diff", "--no-ext-diff", "--no-textconv", "abc123", "main", "--", "src/app.ts"]],
    ["git_file", { ref: "abc123", path: "src/app.ts" }, ["show", "--no-ext-diff", "--no-textconv", "abc123:src/app.ts"]],
  ])("reads %s without shell execution", async (operation, params, args) => {
    const { run, invoke } = harness();
    expect(await invoke({ operation, ...params })).toMatchObject({ details: { output: "evidence" } });
    expect(run).toHaveBeenCalledWith("git", ["--no-optional-locks", ...args], expect.objectContaining({ cwd: "/project", timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }));
  });

  it("uses only a recorded workspace checkout", async () => {
    const { run, invoke } = harness();
    await invoke({ operation: "git_status", workspaceRepository: "app" });
    expect(run).toHaveBeenCalledWith("git", expect.any(Array), expect.objectContaining({ cwd: "/task/app" }));
    run.mockClear();
    expect(await invoke({ operation: "git_status", workspaceRepository: "../../other" })).toMatchObject({ isError: true });
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ["github_runs", { repository: "owner/repo" }, "repos/owner/repo/actions/runs?per_page=100&page=1"],
    ["github_jobs", { repository: "owner/repo", runId: 123 }, "repos/owner/repo/actions/runs/123/jobs?per_page=100&page=1"],
    ["github_artifacts", { repository: "owner/repo", runId: 123, page: 2 }, "repos/owner/repo/actions/runs/123/artifacts?per_page=100&page=2"],
    ["github_job_log", { repository: "owner/repo", jobId: 321 }, "repos/owner/repo/actions/jobs/321/logs"],
  ])("reads %s with a fixed GET endpoint", async (operation, params, endpoint) => {
    const { run, invoke } = harness();
    await invoke({ operation, ...params });
    expect(run).toHaveBeenCalledWith("gh", ["api", "--method", "GET", endpoint], expect.any(Object));
  });

  it.each([
    { operation: "git_ref", ref: "--exec=bad" },
    { operation: "git_file", ref: "main", path: "../secret" },
    { operation: "github_runs", repository: "https://evil.example" },
    { operation: "github_runs", repository: "../.." },
    { operation: "github_run", repository: "owner/repo", runId: -1 },
    { operation: "github_jobs", repository: "owner/repo", runId: 1, page: 0 },
    { operation: "shell", command: "touch unexpected" },
  ])("rejects unsupported or injected input $operation", async (params) => {
    const { run, invoke } = harness();
    expect(await invoke(params)).toMatchObject({ isError: true });
    expect(run).not.toHaveBeenCalled();
  });

  it("reads a selected artifact through the bounded archive reader", async () => {
    const { run, invoke } = harness();
    expect(await invoke({ operation: "github_artifact_contents", repository: "owner/repo", artifactId: 42 })).toMatchObject({ details: { output: "artifact evidence" } });
    expect(readPostMergeArtifact).toHaveBeenCalledWith({ repository: "owner/repo", artifactId: 42, cwd: "/project", signal: undefined });
    expect(run).not.toHaveBeenCalled();
  });

  it("reports unavailable evidence instead of treating subprocess failure as success", async () => {
    const { run, invoke } = harness();
    run.mockRejectedValue(new Error("output exceeded limit"));
    expect(await invoke({ operation: "git_status" })).toMatchObject({ isError: true });
  });

  it("pages large output without silently hiding evidence", async () => {
    const { run, invoke } = harness();
    run.mockResolvedValue({ stdout: "x".repeat(8_000) + "last evidence", stderr: "" });
    expect(await invoke({ operation: "git_show", ref: "main" })).toMatchObject({ details: { nextOffset: 8_000 } });
    expect(await invoke({ operation: "git_show", ref: "main", outputOffset: 8_000 })).toMatchObject({ details: { output: "last evidence" } });
  });

  it("reports negative ancestry as evidence", async () => {
    const { run, invoke } = harness();
    run.mockRejectedValue(Object.assign(new Error("not ancestor"), { code: 1 }));
    expect(await invoke({ operation: "git_ancestor", ref: "abc123", otherRef: "main" })).toMatchObject({ details: { output: "false" } });
  });
});
