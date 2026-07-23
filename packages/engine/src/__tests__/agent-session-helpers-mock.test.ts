import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createResolvedAgentSession,
  resolveExecutorSessionModel,
  resolvePlanningSessionModel,
} from "../agents/agent-session-helpers.js";
import { MOCK_PROVIDER_ID } from "../providers/mock-provider.js";

const { resolveRuntimeMock } = vi.hoisted(() => ({
  resolveRuntimeMock: vi.fn(),
}));

vi.mock("../execution/runtime-resolution.js", async () => {
  const actual = await vi.importActual<typeof import("../execution/runtime-resolution.js")>("../execution/runtime-resolution.js");
  return {
    ...actual,
    resolveRuntime: resolveRuntimeMock,
  };
});

describe("createResolvedAgentSession with mock provider", () => {
  beforeEach(() => {
    resolveRuntimeMock.mockReset().mockResolvedValue({
      runtime: {
        id: "pi",
        name: "pi",
        createSession: vi.fn(),
        promptWithFallback: vi.fn(),
        describeModel: vi.fn(),
      },
      runtimeId: "pi",
      wasConfigured: false,
    });
  });

  it.each(["executor", "triage", "reviewer", "merger", "heartbeat", "validation"] as const)(
    "selects mock runtime for %s sessions and bypasses runtime resolution",
    async (sessionPurpose) => {
      const beforeSpawnSession = vi.fn();
      const result = await createResolvedAgentSession({
        sessionPurpose,
        cwd: "/tmp/project/.worktrees/fn-5203",
        systemPrompt: "system",
        defaultProvider: `  ${MOCK_PROVIDER_ID.toUpperCase()}  `,
        defaultModelId: "scripted",
        beforeSpawnSession,
      });

      expect(result.runtimeId).toBe(MOCK_PROVIDER_ID);
      expect(result.wasConfigured).toBe(true);
      expect(resolveRuntimeMock).not.toHaveBeenCalled();
      expect(beforeSpawnSession).toHaveBeenCalledTimes(1);
      expect((result.session as any).__mock.sessionPurpose).toBe(sessionPurpose);

      const shim = (result.session as any).promptWithFallback;
      expect(typeof shim).toBe("function");
      await expect(shim("hello from mock helper")).resolves.toBeUndefined();
    },
  );

  it("leaves executor and planning model resolution unchanged for task-level mock provider", () => {
    expect(resolveExecutorSessionModel(MOCK_PROVIDER_ID, "scripted", undefined)).toEqual({
      provider: MOCK_PROVIDER_ID,
      modelId: "scripted",
    });
    expect(resolvePlanningSessionModel(MOCK_PROVIDER_ID, "scripted", undefined)).toEqual({
      provider: MOCK_PROVIDER_ID,
      modelId: "scripted",
    });
  });
});
