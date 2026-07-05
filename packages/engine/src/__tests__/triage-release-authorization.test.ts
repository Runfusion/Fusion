import { describe, expect, it } from "vitest";
import {
  classifyReleaseTask,
  evaluateReleaseAuthorizationGate,
  isUserAuthoredSource,
  parseReleaseAuthorizationMarker,
  stripNegatedReleaseClauses,
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

  /*
   * FN-7560 regression: release disclaimers must not self-incriminate.
   * Symptom: FN-7525/FN-7554/FN-7556 (revert/undo/UI tasks) were parked in
   * awaiting-release-authorization solely because their AI-authored specs said
   * they perform NO release while naming `scripts/release.mjs` as the owner.
   * Surface enumeration below covers every documented signal in both its negated
   * (disclaimer → not release-class) and actionable (intent → still release-class)
   * form so the invariant holds across all known signal surfaces, not just the repro.
   */
  describe("negated release disclaimers are not classified as release-class (FN-7560)", () => {
    const disclaimerRepros = [
      // FN-7525
      "This task does not perform any package release or publish (releases are owned by `scripts/release.mjs`).",
      // FN-7554
      "This task's delivery is the changeset FILE only — it performs no release/publish (`scripts/release.mjs` owns releases).",
      // FN-7556
      "Delivery is the changeset FILE only; this task performs no package release or publish (releases are owned by `scripts/release.mjs`).",
    ];

    for (const promptText of disclaimerRepros) {
      it(`does not flag disclaimer: ${promptText.slice(0, 48)}…`, () => {
        const classification = classifyReleaseTask({ promptText });
        expect(classification.isReleaseClass, promptText).toBe(false);
        expect(classification.signals, promptText).toEqual([]);
      });
    }

    it("clears the awaiting-release-authorization hold for the real FN-7525 shape", () => {
      const decision = evaluateReleaseAuthorizationGate({
        sourceType: "agent_heartbeat",
        title: "Add Revert/Undo affordance to Done and Archived task cards",
        promptText:
          "## Scope\nThis task does not perform any package release or publish (releases are owned by `scripts/release.mjs`).\n\n## Git Commit Convention\nCommits at step boundaries.",
      });
      expect(decision.action).toBe("allow");
      expect(decision.isReleaseClass).toBe(false);
    });
  });

  it("still flags genuine release intent even alongside a disclaimer clause", () => {
    // A real release instruction lives in its own non-negated clause and must survive stripping.
    const classification = classifyReleaseTask({
      promptText:
        "Run pnpm release --yes to publish @runfusion/fusion. This other task performs no release.",
    });
    expect(classification.isReleaseClass).toBe(true);
    expect(classification.signals).toContain("pnpm release");
  });

  it("still flags every documented signal when phrased as an actionable instruction", () => {
    const actionable = [
      "Run pnpm release --yes now.",
      "Execute node scripts/release.mjs to cut the build.",
      "Run pnpm changeset publish to ship.",
      "Then npm publish the @runfusion/fusion tarball.",
      "Run pnpm publish @runfusion/fusion.",
      "Publish the package to npm as the final step.",
      "Create git tag v1.2.3 for the release.",
      "Author a version bump release commit for v1.2.3.",
    ];
    for (const promptText of actionable) {
      expect(classifyReleaseTask({ promptText }).isReleaseClass, promptText).toBe(true);
    }
  });

  it("stripNegatedReleaseClauses drops disclaimer clauses but keeps actionable ones", () => {
    const stripped = stripNegatedReleaseClauses(
      "Run pnpm release to publish. This task performs no other release; releases are owned by scripts/release.mjs.",
    );
    expect(stripped).toMatch(/pnpm release/);
    expect(stripped).not.toMatch(/scripts\/release\.mjs/);
    expect(stripped).not.toMatch(/performs no/);
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
