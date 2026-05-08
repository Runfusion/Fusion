import { describe, expect, it } from "vitest";
import { evaluateAgentActionGate } from "../agent-action-gate.js";
import {
  ACTION_GATE_NETWORK_API_TOOLS,
  ACTION_GATE_TASK_AGENT_MANAGEMENT_TOOLS,
  COORDINATION_EXEMPT_TOOLS,
  FILE_WRITE_DELETE_FN_TOOLS,
  NETWORK_API_TOOLS,
  READONLY_FN_TOOLS,
  TASK_AGENT_MUTATION_TOOLS,
  classifyGitCommand,
  isGitWriteCommand,
} from "../gating-classifications.js";
import { classifyPermanentAgentToolCall, resolvePermanentAgentToolDecision } from "../permanent-agent-gating.js";
import type { AgentPermissionPolicy } from "@fusion/core";

const blockedPolicy: AgentPermissionPolicy = {
  presetId: "locked-down",
  rules: {
    git_write: "block",
    file_write_delete: "block",
    command_execution: "block",
    network_api: "block",
    task_agent_mutation: "block",
  },
};

const gitCases = [
  ["git status", false, "git status"],
  ["git diff", false, "git diff"],
  ["git log --oneline", false, "git log"],
  ["git show HEAD", false, "git show"],
  ["git add .", true, "git add"],
  ["git commit -m x", true, "git commit"],
  ["git branch", false, "git branch"],
  ["git branch --show-current", false, "git branch --show-current"],
  ["git branch feature", true, "git branch"],
  ["git branch -d feature", true, "git branch"],
  ["git switch main", false, "git switch"],
  ["git switch -c feature", true, "git switch -c"],
  ["git checkout main", false, "git checkout"],
  ["git checkout -b feature", true, "git checkout -b"],
  ["git pull", false, "git pull"],
  ["git pull --rebase", true, "git pull --rebase"],
  ["git restore file.ts", false, "git restore"],
  ["git restore --staged file.ts", true, "git restore --staged"],
  ["git remote -v", false, "git remote -v"],
  ["git remote add origin x", true, "git remote"],
  ["git remote set-url origin y", true, "git remote"],
  ["git worktree list", false, "git worktree"],
  ["git worktree add ../x", true, "git worktree add"],
  ["git worktree remove ../x", true, "git worktree remove"],
  ["echo hi && git status", false, "git status"],
  ["echo hi; git commit -m x", true, "git commit"],
  ["echo hi | git diff", false, "git diff"],
  ["echo hi\ngit checkout -b t", true, "git checkout -b"],
] as const;

describe("gating-classifications parity", () => {
  it("locks coordination exempt membership", () => {
    expect([...COORDINATION_EXEMPT_TOOLS].sort()).toMatchInlineSnapshot(`
      [
        "find",
        "fn_agent_org_chart",
        "fn_agent_show",
        "fn_delegate_task",
        "fn_heartbeat_done",
        "fn_list_agents",
        "fn_memory_append",
        "fn_memory_get",
        "fn_memory_search",
        "fn_read_evaluations",
        "fn_read_messages",
        "fn_reflect_on_performance",
        "fn_send_message",
        "fn_task_create",
        "fn_task_document_read",
        "fn_task_document_write",
        "fn_task_done",
        "fn_task_log",
        "fn_task_update",
        "fn_update_identity",
        "grep",
        "ls",
        "read",
      ]
    `);
  });

  it("ensures coordination exempt tools are recognized and allowed in permanent gating", () => {
    for (const toolName of COORDINATION_EXEMPT_TOOLS) {
      const classification = classifyPermanentAgentToolCall(toolName);
      const decision = resolvePermanentAgentToolDecision({
        toolName,
        gating: { permissionPolicy: blockedPolicy },
      });
      expect(classification.recognized).toBe(true);
      expect(decision.disposition).toBe("allow");
      expect(decision.category).toBe("none");
    }
  });

  it("keeps fn_* category equivalence mappings across gates", () => {
    const fnTools = new Set<string>();
    for (const source of [
      READONLY_FN_TOOLS,
      TASK_AGENT_MUTATION_TOOLS,
      ACTION_GATE_NETWORK_API_TOOLS,
      FILE_WRITE_DELETE_FN_TOOLS,
      NETWORK_API_TOOLS,
    ]) {
      for (const toolName of source) {
        if (toolName.startsWith("fn_")) fnTools.add(toolName);
      }
    }

    for (const toolName of fnTools) {
      const action = evaluateAgentActionGate({
        agentId: "a1",
        toolName,
        args: {},
        permissionPolicy: blockedPolicy,
      });
      const permanent = classifyPermanentAgentToolCall(toolName);

      const actionKind = action.category === "task_agent_mutation"
        ? "mutating"
        : action.category === "network_api"
          ? "network"
          : action.category === "file_write_delete"
            ? "file-write"
            : "readonly";

      const permanentKind = permanent.category === "task_agent_mutation"
        ? "mutating"
        : permanent.category === "network_api"
          ? "network"
          : permanent.category === "file_write_delete"
            ? "file-write"
            : "readonly";

      if (FILE_WRITE_DELETE_FN_TOOLS.has(toolName)) {
        expect({ toolName, actionKind, permanentKind }).toEqual({ toolName, actionKind: "readonly", permanentKind: "file-write" });
        continue;
      }
      if (NETWORK_API_TOOLS.has(toolName) && !ACTION_GATE_NETWORK_API_TOOLS.has(toolName)) {
        expect({ toolName, actionKind, permanentKind }).toEqual({ toolName, actionKind: "readonly", permanentKind: "network" });
        continue;
      }
      if (TASK_AGENT_MUTATION_TOOLS.has(toolName) && !ACTION_GATE_TASK_AGENT_MANAGEMENT_TOOLS.has(toolName)) {
        expect({ toolName, actionKind, permanentKind }).toEqual({ toolName, actionKind: "readonly", permanentKind: "mutating" });
        continue;
      }

      expect({ toolName, actionKind, permanentKind }).toEqual({ toolName, actionKind: permanentKind, permanentKind });
    }
  });

  it.each(gitCases)("classifyGitCommand handles %s", (command, write, operation) => {
    expect(classifyGitCommand(command)).toEqual({ write, operation });
  });

  it("classifyGitCommand returns null when no git command is present", () => {
    expect(classifyGitCommand("pnpm test")).toBeNull();
  });

  it.each(gitCases)("isGitWriteCommand agrees with classifyGitCommand for %s", (command) => {
    expect(isGitWriteCommand(command)).toBe(classifyGitCommand(command)?.write ?? false);
  });
});
