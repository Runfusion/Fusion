import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACTION_CATEGORY_PERMISSIONS,
  __resetIdentityEnabledForTests,
  __resetPermissionInvocationClassifierForTests,
  can,
  classifyGitCommandForPermissions,
  grantSetFromAgentPermissionPolicy,
  normalizeAgentPermissionPolicyFromPreset,
  setIdentityEnabled,
} from "@fusion/core";
import type { AgentPermissionPolicyPresetId, ResolvedGrantSet } from "@fusion/core";
import { COORDINATION_EXEMPT_TOOLS, classifyGitCommand } from "../execution/gating-classifications.js";
import { evaluateAgentActionGate } from "../agents/agent-action-gate.js";

/*
FNXC:IdentityPermissions 2026-08-09-03:04:
READ-ONLY SHADOW EVALUATION for U4. The unified catalog is asserted against the live gate here and
NEVER returned as the gate decision — `agent-action-gate.ts` keeps its own call path until U19b,
because the new model short-circuits while `identity.enabled` is false and retargeting now would
switch agent gating off for every intermediate commit.

Two properties are guarded:

1. PARITY OF THE GIT CLASSIFIER. `classifyGitCommandForPermissions` is a core-side port of this
   package's `classifyGitCommand`, needed because core must answer the argument-aware git-write
   question with no engine present (the CLI inlines core alone). Duplicating a security classifier is
   the two-path drift `gating-classifications.ts` exists to prevent, so the copy is pinned here
   rather than trusted. If this fails, the PORT is wrong — do not relax the assertion.

2. DISPOSITION PARITY OVER CLASSIFIED INVOCATIONS. For a corpus of real `(toolName, args)` pairs and
   every shipped preset, the catalog's decision matches the gate's. The comparison feeds the gate's
   OWN classification into `can()`, so it tests the (permission, disposition) mapping — not a second
   classifier agreeing with itself.
*/

const GIT_COMMAND_CORPUS = [
  "git status",
  "git diff --staged",
  "git log --oneline -20",
  "git show HEAD",
  "git rev-parse --show-current",
  "git rev-parse HEAD",
  "git branch",
  "git branch --show-current",
  "git branch -d feature/x",
  "git branch feature/x",
  "git switch main",
  "git switch -c feature/x",
  "git checkout main",
  "git checkout -b feature/x",
  "git pull",
  "git pull --rebase",
  "git restore src/a.ts",
  "git restore --staged src/a.ts",
  "git remote -v",
  "git remote add origin git@example.com:x.git",
  "git worktree list",
  "git worktree add ../wt main",
  "git worktree remove ../wt",
  "git commit -m 'wip'",
  "git push origin main",
  "git push --force-with-lease",
  "git merge main",
  "git rebase -i main",
  "git cherry-pick abc123",
  "git reset --hard origin/main",
  "git stash pop",
  "git clean -fd",
  "git",
  "ls -la",
  "pnpm test",
  "echo hi && git commit -m x",
  "cat file.txt | grep git",
  "",
];

const INVOCATION_CORPUS: { toolName: string; args: Record<string, unknown> }[] = [
  ...GIT_COMMAND_CORPUS.map((command) => ({ toolName: "bash", args: { command } })),
  { toolName: "write", args: { path: "src/a.ts" } },
  { toolName: "edit", args: { path: "src/b.ts" } },
  { toolName: "read", args: { path: "src/a.ts" } },
  { toolName: "grep", args: { pattern: "x" } },
  { toolName: "fn_task_create", args: { title: "t" } },
  { toolName: "fn_task_update", args: { id: "FN-2" } },
  { toolName: "fn_task_delete", args: { id: "FN-3" } },
  { toolName: "fn_task_bypass_review", args: { id: "FN-4", reason: "r" } },
  { toolName: "fn_task_file_scope_add", args: { id: "FN-5", path: "src/c.ts" } },
  { toolName: "fn_run_verification", args: {} },
  { toolName: "fn_web_fetch", args: { url: "https://example.com" } },
  { toolName: "mcp__acme__do_thing", args: {} },
  { toolName: "fn_task_attach", args: { id: "FN-6" } },
  { toolName: "fn_agent_create", args: { name: "a" } },
  { toolName: "fn_task_done", args: {} },
  { toolName: "fn_task_log", args: { message: "m" } },
  { toolName: "fn_task_document_write", args: { key: "k" } },
  { toolName: "totally_unknown_tool", args: {} },
];

const PRESETS: AgentPermissionPolicyPresetId[] = ["unrestricted", "approval-required", "locked-down", "custom"];

beforeEach(() => {
  setIdentityEnabled(true);
  /*
  Register the gate's OWN classification as core's classifier. This is the shadow seam: the tool
  registries live in this package, so core reaches them through the DI hook rather than by copying
  the registries (which would be the same drift hazard the git-classifier parity check guards).
  */
  __resetPermissionInvocationClassifierForTests();
});

afterEach(() => {
  __resetIdentityEnabledForTests();
  __resetPermissionInvocationClassifierForTests();
});

describe("core git classifier parity", () => {
  it("agrees with classifyGitCommand across the command corpus", () => {
    for (const command of GIT_COMMAND_CORPUS) {
      expect({ command, ...(classifyGitCommandForPermissions(command) ?? { null: true }) }).toEqual({
        command,
        ...(classifyGitCommand(command) ?? { null: true }),
      });
    }
  });
});

describe("catalog vs live gate disposition parity", () => {
  it("produces the same disposition for every classified invocation under every preset", () => {
    for (const presetId of PRESETS) {
      const policy = normalizeAgentPermissionPolicyFromPreset(presetId);
      const grants: ResolvedGrantSet = grantSetFromAgentPermissionPolicy(policy);

      for (const invocation of INVOCATION_CORPUS) {
        const gate = evaluateAgentActionGate({
          agentId: "agent-1",
          taskId: "FN-1",
          toolName: invocation.toolName,
          args: invocation.args,
          permissionPolicy: policy,
        });

        const shadow = can({
          context: { actor: { id: "agent-1", kind: "agent" } },
          resolveGrants: () => grants,
          invocation: {
            toolName: invocation.toolName,
            args: invocation.args,
            classification: {
              category: gate.category,
              operation: gate.operation,
              resourceType: gate.resourceType,
              ...(gate.resourceId ? { resourceId: gate.resourceId } : {}),
            },
          },
          taskId: "FN-1",
        });

        expect({ presetId, tool: invocation.toolName, args: invocation.args, disposition: shadow.disposition }).toEqual({
          presetId,
          tool: invocation.toolName,
          args: invocation.args,
          disposition: gate.disposition,
        });
        expect(shadow.approvalDedupeKey).toBe(gate.approvalDedupeKey);
      }
    }
  });

  it("fails when a deliberately wrong category mapping is injected (proven-failing control)", () => {
    const policy = normalizeAgentPermissionPolicyFromPreset("unrestricted");
    const correct = grantSetFromAgentPermissionPolicy(policy);
    // Wrong mapping: git_write authority read off the command_execution grant.
    const wrong: ResolvedGrantSet = {
      permissions: { ...correct.permissions, [ACTION_CATEGORY_PERMISSIONS.review_gate_bypass]: "allow" },
    };

    const gate = evaluateAgentActionGate({
      agentId: "agent-1",
      taskId: "FN-1",
      toolName: "fn_task_bypass_review",
      args: { id: "FN-1", reason: "r" },
      permissionPolicy: policy,
    });
    expect(gate.disposition).toBe("require-approval");

    const shadow = can({
      context: { actor: { id: "agent-1", kind: "agent" } },
      resolveGrants: () => wrong,
      invocation: {
        toolName: "fn_task_bypass_review",
        args: { id: "FN-1", reason: "r" },
        classification: {
          category: gate.category,
          operation: gate.operation,
          resourceType: gate.resourceType,
          ...(gate.resourceId ? { resourceId: gate.resourceId } : {}),
        },
      },
      taskId: "FN-1",
    });
    expect(shadow.disposition).not.toBe(gate.disposition);
  });
});

describe("the exempt floor under the real coordination registry", () => {
  it("allows every COORDINATION_EXEMPT_TOOLS entry for a grantless actor", () => {
    const grantless: ResolvedGrantSet = { permissions: {} };
    for (const toolName of COORDINATION_EXEMPT_TOOLS) {
      const gate = evaluateAgentActionGate({
        agentId: "agent-1",
        taskId: "FN-1",
        toolName,
        args: {},
        permissionPolicy: normalizeAgentPermissionPolicyFromPreset("locked-down"),
      });
      if (gate.category !== "exempt") continue;

      const shadow = can({
        context: { actor: { id: "agent-1", kind: "agent" } },
        resolveGrants: () => grantless,
        invocation: {
          toolName,
          args: {},
          classification: { category: gate.category, operation: gate.operation, resourceType: gate.resourceType },
        },
        taskId: "FN-1",
      });
      expect({ toolName, disposition: shadow.disposition, source: shadow.source }).toEqual({
        toolName,
        disposition: "allow",
        source: "exempt-floor",
      });
    }
  });
});
