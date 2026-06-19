import { describe, expect, it } from "vitest";
import {
  classifyReleaseTask,
  evaluateReleaseAuthorizationGate,
  isUserAuthoredSource,
  parseReleaseAuthorizationMarker,
} from "../triage-release-authorization.js";

const releasePrompt = `# Task: FN-6469 - Release @runfusion/fusion patch

## Mission
Publish @runfusion/fusion to npm using the release process.

## Steps
- Run pnpm release --yes
- Verify scripts/release.mjs completed
`;

const marker = "**Release Authorized By User:** yes";

describe("triage release authorization gate", () => {
  it("blocks the FN-6469 incident shape before auto-dispatch", () => {
    const decision = evaluateReleaseAuthorizationGate({
      sourceType: "agent_heartbeat",
      title: "Release @runfusion/fusion patch",
      description: "Release the package",
      promptText: releasePrompt,
    });

    expect(decision.action).toBe("block");
    expect(decision.isReleaseClass).toBe(true);
    expect(decision.signals).toContain("pnpm release");
  });

  it("blocks agent-authored release tasks even when PROMPT.md contains the marker", () => {
    const decision = evaluateReleaseAuthorizationGate({
      sourceType: "agent_heartbeat",
      title: "Release @runfusion/fusion patch",
      promptText: `${releasePrompt}\n${marker}\n`,
    });

    expect(decision.action).toBe("block");
    expect(decision.reason).toMatch(/non-user-authored source/);
  });

  it("allows user-authored dashboard release tasks with the marker", () => {
    expect(evaluateReleaseAuthorizationGate({
      sourceType: "dashboard_ui",
      title: "Release @runfusion/fusion patch",
      promptText: `${releasePrompt}\n${marker}\n`,
    }).action).toBe("allow");
  });

  it("allows user-authored CLI release tasks with the marker", () => {
    expect(evaluateReleaseAuthorizationGate({
      sourceType: "cli",
      title: "Release @runfusion/fusion patch",
      promptText: `${releasePrompt}\n  **Release Authorized By User:** YES  \n`,
    }).action).toBe("allow");
  });

  it("blocks user-authored release tasks without the marker", () => {
    const decision = evaluateReleaseAuthorizationGate({
      sourceType: "quick_chat",
      title: "Release @runfusion/fusion patch",
      promptText: releasePrompt,
    });

    expect(decision.action).toBe("block");
    expect(decision.reason).toMatch(/missing/);
  });

  it("blocks api-sourced release tasks even when the marker is present", () => {
    const decision = evaluateReleaseAuthorizationGate({
      sourceType: "api",
      title: "Release @runfusion/fusion patch",
      promptText: `${releasePrompt}\n${marker}\n`,
    });

    expect(decision.action).toBe("block");
    expect(decision.reason).toMatch(/non-user-authored source 'api'/);
  });

  it("blocks derived/internal release tasks even when the marker is present", () => {
    for (const sourceType of ["task_refine", "github_import"] as const) {
      expect(evaluateReleaseAuthorizationGate({
        sourceType,
        title: "Release @runfusion/fusion patch",
        promptText: `${releasePrompt}\n${marker}\n`,
      }).action).toBe("block");
    }
  });

  it("allows non-release tasks without changing dispatch behavior", () => {
    const decision = evaluateReleaseAuthorizationGate({
      sourceType: "agent_heartbeat",
      title: "Fix dashboard layout bug",
      description: "Adjust CSS for the task card footer.",
      promptText: "## Mission\nFix a dashboard layout bug without publishing anything.",
    });

    expect(decision.action).toBe("allow");
    expect(decision.isReleaseClass).toBe(false);
    expect(decision.signals).toEqual([]);
  });

  it("classifies all documented release signal surfaces", () => {
    const cases = [
      ["pnpm release --yes", "pnpm release"],
      ["node scripts/release.mjs --yes", "scripts/release.mjs"],
      ["pnpm changeset publish", "changeset publish"],
      ["npm publish ./dist for @runfusion/fusion", "npm publish @runfusion/fusion"],
      ["pnpm publish @runfusion/fusion", "pnpm publish @runfusion/fusion"],
      ["publish the package to npm", "publish to npm"],
      ["git tag v1.2.3", "git tag v<semver>"],
      ["create a version bump release commit for v1.2.3", "version-bump release commit"],
    ] as const;

    for (const [promptText, expectedSignal] of cases) {
      const classification = classifyReleaseTask({ promptText });
      expect(classification.isReleaseClass, promptText).toBe(true);
      expect(classification.signals, promptText).toContain(expectedSignal);
    }
  });

  it("handles empty and undefined inputs without throwing or flagging", () => {
    expect(classifyReleaseTask({})).toEqual({ isReleaseClass: false, signals: [] });
    expect(evaluateReleaseAuthorizationGate({ sourceType: undefined }).action).toBe("allow");
    expect(parseReleaseAuthorizationMarker("")).toBe(false);
  });

  it("only treats the four explicit user-authored source types as user authored", () => {
    const userAuthored = ["dashboard_ui", "quick_chat", "chat_session", "cli"];
    const nonUserAuthored = [
      "agent_heartbeat",
      "automation",
      "cron",
      "workflow_step",
      "recovery",
      "research",
      "unknown",
      "github_import",
      "task_refine",
      "task_duplicate",
      "api",
      undefined,
      null,
      "future_source",
    ];

    for (const sourceType of userAuthored) {
      expect(isUserAuthoredSource(sourceType), sourceType).toBe(true);
    }
    for (const sourceType of nonUserAuthored) {
      expect(isUserAuthoredSource(sourceType), String(sourceType)).toBe(false);
    }
  });
});
