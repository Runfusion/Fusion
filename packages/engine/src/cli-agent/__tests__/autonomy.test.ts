/**
 * Autonomy elevation detection + approval gate (U15).
 *
 * Central invariant under test: the posture chip / gate derive from the FULLY
 * RESOLVED argv + env, so elevation smuggled through ANY channel (autonomy
 * field, extra args, env additions, command override) trips the gate — not just
 * the autonomy field.
 */
import { describe, expect, it } from "vitest";
import {
  resolveEffectivePosture,
  assertAutonomyApproved,
  CliAutonomyNotApprovedError,
  type CliAgentResolveSettings,
} from "../autonomy.js";
import { claudeCodeAdapter } from "../adapters/claude-code.js";
import { codexAdapter } from "../adapters/codex.js";
import { genericCliAdapter } from "../adapters/generic.js";

describe("resolveEffectivePosture", () => {
  it("returns default (no elevation) for a baseline launch", () => {
    const posture = resolveEffectivePosture({ adapter: claudeCodeAdapter });
    expect(posture.elevated).toBe(false);
    expect(posture.mode).toBe("default");
    expect(posture.flags).toEqual([]);
    expect(posture.adapterId).toBe("claude-code");
  });

  it("detects elevation from the autonomy field (autoApprove)", () => {
    const posture = resolveEffectivePosture({
      adapter: claudeCodeAdapter,
      nodeConfig: { cliAutonomy: { autoApprove: true } },
    });
    expect(posture.elevated).toBe(true);
    // Claude's buildLaunch emits --dangerously-skip-permissions for autoApprove,
    // so it surfaces as an argv-channel marker (not merely the autonomy field).
    expect(posture.flags.some((f) => f.channel === "args")).toBe(true);
    expect(
      posture.flags.some((f) => f.marker === "--dangerously-skip-permissions"),
    ).toBe(true);
  });

  it("BYPASS CLOSURE: --dangerously-skip-permissions via extraArgs (not the field) trips elevation", () => {
    const settings: CliAgentResolveSettings = {
      extraArgs: ["--dangerously-skip-permissions"],
    };
    const posture = resolveEffectivePosture({ adapter: claudeCodeAdapter, settings });
    expect(posture.elevated).toBe(true);
    expect(
      posture.flags.some(
        (f) => f.channel === "args" && f.marker === "--dangerously-skip-permissions",
      ),
    ).toBe(true);
  });

  it("detects codex -c approval_policy override smuggled via extraArgs", () => {
    const posture = resolveEffectivePosture({
      adapter: codexAdapter,
      settings: { extraArgs: ["-c", "approval_policy=never"] },
    });
    expect(posture.elevated).toBe(true);
    expect(posture.flags.some((f) => f.marker.includes("approval_policy"))).toBe(true);
  });

  it("detects autonomy-toggling env var via envAdditions", () => {
    const posture = resolveEffectivePosture({
      adapter: claudeCodeAdapter,
      settings: { envAdditions: ["SOME_TOOL_SKIP_PERMISSIONS"] },
    });
    expect(posture.elevated).toBe(true);
    expect(
      posture.flags.some(
        (f) => f.channel === "env" && f.marker === "SOME_TOOL_SKIP_PERMISSIONS",
      ),
    ).toBe(true);
  });

  it("does NOT flag a benign env addition", () => {
    const posture = resolveEffectivePosture({
      adapter: claudeCodeAdapter,
      settings: { envAdditions: ["HTTP_PROXY", "NO_COLOR"] },
    });
    expect(posture.elevated).toBe(false);
  });

  it("treats a non-default command override as privileged", () => {
    const posture = resolveEffectivePosture({
      adapter: claudeCodeAdapter,
      settings: { commandOverride: "/tmp/evil-claude" },
    });
    expect(posture.elevated).toBe(true);
    expect(
      posture.flags.some((f) => f.channel === "command" && f.marker === "/tmp/evil-claude"),
    ).toBe(true);
  });

  it("does NOT flag a command override equal to the adapter default", () => {
    const posture = resolveEffectivePosture({
      adapter: claudeCodeAdapter,
      settings: { commandOverride: claudeCodeAdapter.defaultCommand },
    });
    expect(posture.elevated).toBe(false);
  });

  it("maps autonomyMode:elevated onto the posture even with no field", () => {
    const posture = resolveEffectivePosture({
      adapter: claudeCodeAdapter,
      settings: { autonomyMode: "elevated" },
    });
    expect(posture.elevated).toBe(true);
  });

  it("flags generic-tier bypass args (heuristic patterns)", () => {
    const posture = resolveEffectivePosture({
      adapter: genericCliAdapter,
      settings: { commandOverride: "mytool", extraArgs: ["--auto-approve-everything"] },
    });
    expect(posture.elevated).toBe(true);
  });
});

describe("assertAutonomyApproved (gate)", () => {
  const elevated: CliAgentResolveSettings = {
    extraArgs: ["--dangerously-skip-permissions"],
  };

  it("permits a non-elevated launch without consulting approval", async () => {
    let consulted = false;
    const posture = await assertAutonomyApproved({
      adapter: claudeCodeAdapter,
      projectId: "p1",
      isApproved: () => {
        consulted = true;
        return false;
      },
    });
    expect(posture.elevated).toBe(false);
    expect(consulted).toBe(false);
  });

  it("throws a typed error when elevated and unapproved", async () => {
    await expect(
      assertAutonomyApproved({
        adapter: claudeCodeAdapter,
        settings: elevated,
        projectId: "p1",
        isApproved: () => false,
      }),
    ).rejects.toBeInstanceOf(CliAutonomyNotApprovedError);
  });

  it("includes the offending flags + scope on the error", async () => {
    let err: unknown;
    try {
      await assertAutonomyApproved({
        adapter: claudeCodeAdapter,
        settings: elevated,
        projectId: "proj-x",
        isApproved: () => false,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliAutonomyNotApprovedError);
    const typed = err as CliAutonomyNotApprovedError;
    expect(typed.code).toBe("CLI_AUTONOMY_NOT_APPROVED");
    expect(typed.projectId).toBe("proj-x");
    expect(typed.adapterId).toBe("claude-code");
    expect(typed.flags.length).toBeGreaterThan(0);
  });

  it("permits an elevated launch once the project has approved", async () => {
    const posture = await assertAutonomyApproved({
      adapter: claudeCodeAdapter,
      settings: elevated,
      projectId: "p1",
      isApproved: async ({ projectId, adapterId }) =>
        projectId === "p1" && adapterId === "claude-code",
    });
    expect(posture.elevated).toBe(true);
  });
});
