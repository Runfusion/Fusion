import { createHash } from "node:crypto";
import type { Agent } from "@fusion/core";
import { describe, expect, it } from "vitest";
import { buildIdentitySnapshot } from "../agent-heartbeat.js";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  const now = new Date().toISOString();
  return {
    id: "agent-1",
    name: "Snapshot Agent",
    role: "engineer",
    state: "idle",
    createdAt: now,
    updatedAt: now,
    metadata: {},
    ...overrides,
  };
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

describe("buildIdentitySnapshot", () => {
  it("renders loaded soul and instructions hashes", () => {
    const soul = "I deeply care about reliability.";
    const instructions = "Always run tests before done.";
    const snapshot = buildIdentitySnapshot({
      agent: makeAgent({ soul }),
      resolvedInstructions: { status: "loaded", value: instructions },
      workspaceMemory: { status: "unset" },
    });

    expect(snapshot).toContain(`- soul: loaded (${soul.length} chars, sha256:${shortHash(soul)})`);
    expect(snapshot).toContain(`- instructions: loaded (${instructions.length} chars, sha256:${shortHash(instructions)})`);
  });

  it("renders empty soul when configured as whitespace", () => {
    const snapshot = buildIdentitySnapshot({
      agent: makeAgent({ soul: "   " }),
      resolvedInstructions: { status: "unset" },
      workspaceMemory: { status: "unset" },
    });

    expect(snapshot).toContain("- soul: empty");
  });

  it("renders unset soul when undefined", () => {
    const snapshot = buildIdentitySnapshot({
      agent: makeAgent(),
      resolvedInstructions: { status: "unset" },
      workspaceMemory: { status: "unset" },
    });

    expect(snapshot).toContain("- soul: unset");
  });

  it("renders instructions load-error distinctly", () => {
    const snapshot = buildIdentitySnapshot({
      agent: makeAgent(),
      resolvedInstructions: { status: "load-error" },
      workspaceMemory: { status: "unset" },
    });

    expect(snapshot).toContain("- instructions: load-error");
    expect(snapshot).not.toContain("- instructions: unset");
  });

  it("prefers workspace memory with source label when inline memory is absent", () => {
    const workspaceMemory = "Persist durable architecture constraints.";
    const snapshot = buildIdentitySnapshot({
      agent: makeAgent({ memory: undefined }),
      resolvedInstructions: { status: "unset" },
      workspaceMemory: { status: "loaded", value: workspaceMemory },
    });

    expect(snapshot).toContain(`- memory: loaded (${workspaceMemory.length} chars, sha256:${shortHash(workspaceMemory)}, source: workspace)`);
  });
});
