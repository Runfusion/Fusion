import { describe, it, expect, vi } from "vitest";
import {
  mapParsedToVerdict,
  oneShotResultToVerdict,
  normalizeVerdictToken,
  inferVerdictFromProse,
  runCliAgentValidation,
} from "../cli-runtime/cli-agent-validator.js";
import type { OneShotResult } from "../cli-agent/one-shot-session.js";
import type { AgentRuntime, AgentRuntimeOptions, AgentSessionResult } from "../agents/agent-runtime.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

function success(parsed: Record<string, unknown>, text = ""): OneShotResult {
  return { ok: true, sessionId: "s1", parsed, text, rawOutput: JSON.stringify(parsed) };
}

describe("verdict token normalization", () => {
  it("maps synonyms to the contract set", () => {
    expect(normalizeVerdictToken("APPROVE")).toBe("pass");
    expect(normalizeVerdictToken("passed")).toBe("pass");
    expect(normalizeVerdictToken("REVISE")).toBe("fail");
    expect(normalizeVerdictToken("blocked")).toBe("blocked");
    expect(normalizeVerdictToken("nonsense")).toBeNull();
  });
});

describe("mapParsedToVerdict — per-adapter shapes → verdicts", () => {
  it("structured pass verdict is authoritative", () => {
    const v = mapParsedToVerdict({ verdict: "pass" }, "");
    expect(v.status).toBe("pass");
  });

  it("undecidable parsed object maps to error", () => {
    const v = mapParsedToVerdict({ result: "crashed" }, "");
    expect(v.status).toBe("error");
  });

  it("boolean passed:false → fail", () => {
    const v = mapParsedToVerdict({ passed: false, summary: "missing X" }, "");
    expect(v.status).toBe("fail");
    expect(v.summary).toBe("missing X");
  });

  it("explicit blocked flag → blocked with reason", () => {
    const v = mapParsedToVerdict({ blocked: true, reason: "needs creds" }, "");
    expect(v.status).toBe("blocked");
    expect(v.blockedReason).toBe("needs creds");
  });

  it("status token + assertions array", () => {
    const v = mapParsedToVerdict(
      {
        status: "fail",
        assertions: [
          { assertionId: "a1", passed: true },
          { id: "a2", passed: false, message: "nope" },
        ],
      },
      "",
    );
    expect(v.status).toBe("fail");
    expect(v.assertions).toHaveLength(2);
    expect(v.assertions[1]).toEqual({ assertionId: "a2", passed: false, message: "nope" });
  });

  it("prose-only pass wording is not authoritative", () => {
    expect(inferVerdictFromProse("All assertions pass.")).toBeNull();
    const v = mapParsedToVerdict({}, "All assertions pass.");
    expect(v.status).toBe("error");
  });

  it("MALFORMED / undecidable → error, NEVER pass", () => {
    const v = mapParsedToVerdict({ irrelevant: 1 }, "the agent rambled without a verdict");
    expect(v.status).toBe("error");
  });
});

describe("oneShotResultToVerdict — failures map to error", () => {
  it("nonzero exit → error with stderr in summary", () => {
    const v = oneShotResultToVerdict({
      ok: false,
      reason: "nonzero-exit",
      sessionId: "s1",
      exitCode: 1,
      stderr: "segfault",
      message: "exited with code 1",
    });
    expect(v.status).toBe("error");
    expect(v.summary).toContain("segfault");
  });

  it("unparseable → error (never silent pass)", () => {
    const v = oneShotResultToVerdict({
      ok: false,
      reason: "unparseable",
      sessionId: "s1",
      exitCode: 0,
      stderr: "garbage",
      message: "no decodable result",
    });
    expect(v.status).toBe("error");
  });

  it("success with pass verdict → pass", () => {
    expect(oneShotResultToVerdict(success({ verdict: "pass" })).status).toBe("pass");
  });
});

function validatorRuntime(
  text: string,
  options: { stopReason?: string; promptError?: Error; createError?: Error } = {},
) {
  const createOptions: AgentRuntimeOptions[] = [];
  const session = { dispose: vi.fn() } as unknown as AgentSession;
  const runtime: AgentRuntime = {
    id: "acp",
    name: "ACP Runtime",
    async createSession(opts: AgentRuntimeOptions): Promise<AgentSessionResult> {
      createOptions.push(opts);
      if (options.createError) throw options.createError;
      return { session };
    },
    async promptWithFallback(): Promise<{ stopReason?: string } | void> {
      if (options.promptError) throw options.promptError;
      createOptions[0]?.onText?.(text);
      return options.stopReason ? { stopReason: options.stopReason } : { stopReason: "end_turn" };
    },
    describeModel() {
      return "acp/test";
    },
  };
  return { runtime, createOptions };
}

describe("runCliAgentValidation — ACP seam preserves no-silent-pass", () => {
  it("parsed pass verdict from clean end_turn returns pass with assertions", async () => {
    const { runtime, createOptions } = validatorRuntime(
      'done {"verdict":"pass","summary":"looks good","assertions":[{"assertionId":"a1","passed":true}]}',
    );
    const verdict = await runCliAgentValidation(runtime, {
      prompt: "validate",
      cwd: "/tmp",
      settings: { model: "claude-sonnet-4" },
    });
    expect(verdict.status).toBe("pass");
    expect(verdict.assertions).toEqual([{ assertionId: "a1", passed: true, message: undefined }]);
    expect(createOptions[0]).toMatchObject({ tools: "readonly", defaultModelId: "claude-sonnet-4" });
  });

  it.each([
    ['{"verdict":"fail","summary":"missing tests"}', "fail"],
    ['{"passed":false,"summary":"missing tests"}', "fail"],
    ['{"blocked":true,"reason":"needs creds"}', "blocked"],
  ])("maps structured %s", async (json, status) => {
    const { runtime } = validatorRuntime(json);
    const verdict = await runCliAgentValidation(runtime, { prompt: "validate", cwd: "/tmp" });
    expect(verdict.status).toBe(status);
  });

  it("truncated max_tokens stop with trailing pass JSON maps to error, not pass", async () => {
    const { runtime } = validatorRuntime('partial answer {"verdict":"pass"}', { stopReason: "max_tokens" });
    const verdict = await runCliAgentValidation(runtime, { prompt: "validate", cwd: "/tmp" });
    expect(verdict.status).toBe("error");
    expect(verdict.summary).toContain("stopReason=max_tokens");
  });

  it("prose all-pass with no JSON maps to error", async () => {
    const { runtime } = validatorRuntime("All assertions pass.");
    const verdict = await runCliAgentValidation(runtime, { prompt: "validate", cwd: "/tmp" });
    expect(verdict.status).toBe("error");
  });

  it("empty or undecidable prose maps to error", async () => {
    const { runtime } = validatorRuntime("");
    const verdict = await runCliAgentValidation(runtime, { prompt: "validate", cwd: "/tmp" });
    expect(verdict.status).toBe("error");
  });

  it.each([
    ["This fails because the build is red.", "fail"],
    ["Validation blocked by missing credentials.", "blocked"],
  ])("uses constrained prose backstop for %s", async (text, status) => {
    const { runtime } = validatorRuntime(text);
    const verdict = await runCliAgentValidation(runtime, { prompt: "validate", cwd: "/tmp" });
    expect(verdict.status).toBe(status);
  });

  it("runner failure surfaces as error verdict", async () => {
    const { runtime } = validatorRuntime("", { promptError: new Error("ENOENT claude") });
    const verdict = await runCliAgentValidation(runtime, { prompt: "validate", cwd: "/tmp" });
    expect(verdict.status).toBe("error");
    expect(verdict.summary).toContain("ENOENT claude");
  });
});
