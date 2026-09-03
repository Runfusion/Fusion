import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_MODEL_MIN_CLAUDE_CODE_VERSION,
  buildAnthropicClaudeCodeIdentityHeaders,
  CLAUDE_CODE_IMPERSONATED_VERSION,
  compareClaudeCodeVersions,
} from "@fusion/core";
import type { AuthResult } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  attachAnthropicClaudeCodeIdentityHeaders,
  attachSessionRoutingHeaders,
} from "../pi.js";

function makeRuntime(resolve: (model: unknown) => Promise<AuthResult | undefined>): ModelRuntime {
  return { getAuth: resolve } as unknown as ModelRuntime;
}

const anthropicModel = { provider: "anthropic", id: "claude-fable-5-1" } as never;

function readBundledClaudeCodeVersion(): { source: string; version: string } {
  let moduleUrl: string;
  try {
    // FNXC:ProviderAuth 2026-09-03-05:30: Vitest's module runner lacks import.meta.resolve, so this invokes Node's ESM resolver from the engine dependency context rather than using the unsupported CJS resolver.
    moduleUrl = execFileSync(process.execPath, [
      "--input-type=module",
      "--eval",
      'console.log(import.meta.resolve("@earendil-works/pi-ai/api/anthropic-messages"))',
    ], { cwd: process.cwd(), encoding: "utf8" }).trim();
  } catch (error) {
    throw new Error(`Unable to resolve bundled pi-ai Anthropic messages module; upstream package layout drifted: ${String(error)}`);
  }
  const source = readFileSync(fileURLToPath(moduleUrl), "utf8");
  const version = /const claudeCodeVersion = "([^"]+)"/.exec(source)?.[1];
  if (!version) {
    throw new Error("Bundled pi-ai no longer exposes its claudeCodeVersion constant; update the Fusion identity drift guard.");
  }
  return { source, version };
}

describe("attachAnthropicClaudeCodeIdentityHeaders", () => {
  it("adds the lowercase OAuth identity header and composes with routing headers in either order", async () => {
    for (const attach of [
      (runtime: ModelRuntime) => {
        attachSessionRoutingHeaders(runtime, "session-1");
        attachAnthropicClaudeCodeIdentityHeaders(runtime);
      },
      (runtime: ModelRuntime) => {
        attachAnthropicClaudeCodeIdentityHeaders(runtime);
        attachSessionRoutingHeaders(runtime, "session-1");
      },
    ]) {
      const runtime = makeRuntime(async () => ({
        auth: { apiKey: "sk-ant-oat-test", headers: { "Existing-Header": "preserved" } },
      }));
      attach(runtime);

      await expect(runtime.getAuth(anthropicModel)).resolves.toEqual({
        auth: {
          apiKey: "sk-ant-oat-test",
          headers: {
            "Existing-Header": "preserved",
            "X-Session-Id": "session-1",
            "X-Session-Affinity": "session-1",
            "user-agent": "claude-cli/2.1.251",
          },
        },
      });
    }
  });

  it("leaves API-key and non-Anthropic providers untouched", async () => {
    for (const [model, apiKey] of [
      [anthropicModel, "sk-ant-api-test"],
      [{ provider: "openrouter", id: "model" } as never, "sk-ant-oat-test"],
    ] as const) {
      const runtime = makeRuntime(async () => ({ auth: { apiKey, headers: { Existing: "header" } } }));
      attachAnthropicClaudeCodeIdentityHeaders(runtime);
      await expect(runtime.getAuth(model)).resolves.toEqual({ auth: { apiKey, headers: { Existing: "header" } } });
    }
  });

  it("passes through undefined auth and supports provider-id string calls", async () => {
    const undefinedRuntime = makeRuntime(async () => undefined);
    attachAnthropicClaudeCodeIdentityHeaders(undefinedRuntime);
    await expect(undefinedRuntime.getAuth(anthropicModel)).resolves.toBeUndefined();

    const runtime = makeRuntime(async () => ({ auth: { apiKey: "sk-ant-oat-test" } }));
    attachAnthropicClaudeCodeIdentityHeaders(runtime);
    await expect(runtime.getAuth("anthropic" as never)).resolves.toEqual({
      auth: { apiKey: "sk-ant-oat-test", headers: { "user-agent": "claude-cli/2.1.251" } },
    });
  });

  it("does not throw when a future runtime lacks getAuth", () => {
    expect(() => attachAnthropicClaudeCodeIdentityHeaders({} as ModelRuntime)).not.toThrow();
  });

  it("overrides pi-ai's stale OAuth identity and meets every declared model minimum", async () => {
    const { source, version: bundledVersion } = readBundledClaudeCodeVersion();
    expect(compareClaudeCodeVersions(CLAUDE_CODE_IMPERSONATED_VERSION, bundledVersion)).toBeGreaterThan(0);
    expect(compareClaudeCodeVersions(bundledVersion, "2.1.251")).toBeLessThan(0);
    expect(source).toContain('"user-agent": `claude-cli/${claudeCodeVersion}`');
    expect(Object.keys(buildAnthropicClaudeCodeIdentityHeaders({
      providerId: "anthropic",
      apiKey: "sk-ant-oat-test",
    }))).toEqual(["user-agent"]);

    const runtime = makeRuntime(async () => ({ auth: { apiKey: "sk-ant-oat-test", headers: {} } }));
    attachAnthropicClaudeCodeIdentityHeaders(runtime);
    const decorated = await runtime.getAuth(anthropicModel);
    const effectiveHeaders = Object.assign(
      { "User-Agent": "pi/x" },
      { "user-agent": `claude-cli/${bundledVersion}` },
      {},
      decorated?.auth.headers,
    );
    const effectiveVersion = effectiveHeaders["user-agent"]?.replace("claude-cli/", "");
    expect(effectiveVersion).toBeDefined();
    for (const minimum of Object.values(ANTHROPIC_MODEL_MIN_CLAUDE_CODE_VERSION)) {
      expect(compareClaudeCodeVersions(effectiveVersion!, minimum)).toBeGreaterThanOrEqual(0);
    }
    expect(compareClaudeCodeVersions(effectiveVersion!, "2.1.251")).toBeGreaterThanOrEqual(0);
  });
});
