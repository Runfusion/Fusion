import { describe, it, expect, vi, afterEach } from "vitest";

// Force the bundled-bridge resolver to "not_resolved" so we can assert onLoad's
// fail-closed branch: when the bridge isn't installed, nothing is published and
// Route A stays unavailable (the kill-switch falls back to `-p`).
vi.mock("../cli-spawn.js", async (importActual) => {
  const actual = await importActual<typeof import("../cli-spawn.js")>();
  return {
    ...actual,
    resolveBundledClaudeBridgeBinary: () => ({
      kind: "not_resolved",
      requested: "claude-code-cli-acp",
      path: "/missing/claude-code-cli-acp",
      reason: "bundled bridge not installed (test)",
    }),
  };
});

import plugin from "../index.js";

const fakeCtx = () => ({ settings: {}, logger: { info: () => undefined, warn: () => undefined } });

describe("KTD10 fail-closed — bundled bridge not resolved", () => {
  const saved = process.env.FUSION_CLAUDE_ACP_BRIDGE;
  afterEach(() => {
    if (saved === undefined) delete process.env.FUSION_CLAUDE_ACP_BRIDGE;
    else process.env.FUSION_CLAUDE_ACP_BRIDGE = saved;
  });

  it("does NOT publish FUSION_CLAUDE_ACP_BRIDGE when the bridge is not resolved", () => {
    delete process.env.FUSION_CLAUDE_ACP_BRIDGE;
    plugin.hooks?.onLoad?.(fakeCtx() as never);
    expect(process.env.FUSION_CLAUDE_ACP_BRIDGE).toBeUndefined();
  });
});
