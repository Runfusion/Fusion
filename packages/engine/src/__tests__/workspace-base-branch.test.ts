import { describe, expect, it } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import {
  recordWorkspaceBaseBranchDecision,
  resolveWorkspaceRepoBaseBranch,
} from "../worktree/workspace-base-branch.js";

const task = (baseBranch?: string) => ({ id: "FN-9164", baseBranch } as Pick<Task, "id" | "baseBranch">);

function execFor(refs: string[], commands: string[] = []) {
  return (async (command: string) => {
    commands.push(command);
    if (refs.some((ref) => command.includes(`${ref}^{commit}`))) return { stdout: "abc123\n", stderr: "" };
    throw new Error("missing ref");
  }) as never;
}

describe("resolveWorkspaceRepoBaseBranch", () => {
  it("uses a verified requested base and shell-quotes it", async () => {
    const commands: string[] = [];
    const resolution = await resolveWorkspaceRepoBaseBranch({
      mode: "acquire",
      repoRootDir: "/missing-repo",
      repoRelPath: "repo-a",
      task: task("release/needle-9164; echo nope"),
      settings: {},
      execImpl: execFor(["release/needle-9164; echo nope"], commands),
    });
    expect(resolution).toMatchObject({ branch: "release/needle-9164; echo nope", source: "task-base-branch" });
    expect(commands[0]).toContain("'release/needle-9164; echo nope^{commit}'");
  });

  it("normalizes a remote-tracking-only base into a local lifecycle target", async () => {
    const commands: string[] = [];
    let localCreated = false;
    const execImpl = (async (command: string) => {
      commands.push(command);
      if (command.includes("origin/release/remote-only^{commit}")) return { stdout: "abc123\n", stderr: "" };
      if (command.includes("release/remote-only^{commit}") && localCreated) return { stdout: "abc123\n", stderr: "" };
      if (command.includes("git branch -- 'release/remote-only' 'origin/release/remote-only'")) {
        localCreated = true;
        return { stdout: "", stderr: "" };
      }
      throw new Error("missing ref");
    }) as never;

    const resolution = await resolveWorkspaceRepoBaseBranch({
      mode: "acquire", repoRootDir: "/missing-repo", repoRelPath: "repo-a", task: task("release/remote-only"), settings: {}, execImpl,
    });

    expect(resolution).toMatchObject({ branch: "release/remote-only", requested: "release/remote-only", source: "task-base-branch" });
    expect(commands).toContain("git branch -- 'release/remote-only' 'origin/release/remote-only'");
  });

  it("falls back without failing acquisition for unresolvable and sibling task refs", async () => {
    const unresolved = await resolveWorkspaceRepoBaseBranch({
      mode: "acquire", repoRootDir: "/missing-repo", repoRelPath: "repo-a", task: task("release/missing"), settings: {}, execImpl: execFor([]),
    });
    const sibling = await resolveWorkspaceRepoBaseBranch({
      mode: "acquire", repoRootDir: "/missing-repo", repoRelPath: "repo-a", task: task("fusion/fn-123"), settings: {}, execImpl: execFor([]),
    });
    expect(unresolved).toMatchObject({ branch: "main", source: "repo-integration", fallbackReason: "unresolvable-in-repo" });
    expect(sibling).toMatchObject({ branch: "main", source: "repo-integration", fallbackReason: "sibling-task-branch" });
  });

  it("keeps legacy and recorded entries independent of task.baseBranch", async () => {
    const legacy = await resolveWorkspaceRepoBaseBranch({
      mode: "recorded", recordedBaseBranch: undefined, repoRootDir: "/missing-repo", repoRelPath: "repo-a", task: task("release/new"), settings: {}, execImpl: execFor(["release/new"]),
    });
    const recorded = await resolveWorkspaceRepoBaseBranch({
      mode: "recorded", recordedBaseBranch: "release/old", repoRootDir: "/missing-repo", repoRelPath: "repo-a", task: task("release/new"), settings: {}, execImpl: execFor(["release/old"]),
    });
    expect(legacy).toEqual({ branch: "main", source: "legacy-entry" });
    expect(recorded).toMatchObject({ branch: "release/old", requested: "release/old", source: "recorded-base" });
  });

  it("emits no ref names to audit while retaining human-readable logs", async () => {
    const events: Array<{ target: string; metadata: Record<string, unknown> }> = [];
    const logs: string[] = [];
    await recordWorkspaceBaseBranchDecision({
      store: { logEntry: async (_id: string, message: string) => { logs.push(message); } } as Pick<TaskStore, "logEntry">,
      audit: { git: async (event: never) => { events.push(event as unknown as { target: string; metadata: Record<string, unknown> }); } },
      task: task("release/needle-9164"), repoRelPath: "repo-a", repoAbsPath: "/workspace/repo-a", stage: "acquire",
      resolution: { branch: "main", requested: "release/needle-9164", source: "repo-integration", fallbackReason: "unresolvable-in-repo" },
    });
    expect(logs[0]).toContain("release/needle-9164");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ target: "/workspace/repo-a", metadata: { taskId: "FN-9164", repoRelPath: "repo-a", stage: "acquire", source: "repo-integration", outcome: "fallback", fallbackReason: "unresolvable-in-repo" } });
    expect(Object.keys(events[0].metadata).sort()).toEqual(["fallbackReason", "outcome", "repoRelPath", "source", "stage", "taskId"]);
    expect(JSON.stringify(events[0].metadata)).not.toContain("release/needle-9164");
    expect(events[0].target).not.toContain("release/needle-9164");
  });
});
