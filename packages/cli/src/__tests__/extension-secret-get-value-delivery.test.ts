import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { ApprovalRequestStore, registerFusionSessionIdentity, __clearFusionSessionIdentityRegistryForTests } from "@fusion/core";
import {
  createMockApi,
  createPgExtensionHarness,
  injectSecretsStore,
  pgDescribe,
  registerExtension,
  requireTool,
  type ToolResult,
} from "./pg-extension-harness.js";

const h = createPgExtensionHarness("fn-secret-delivery");

function resultText(result: ToolResult): string {
  return result.content.map((part) => part.text).join("\n");
}

function expectNoPlaintext(result: ToolResult, plaintext: string): void {
  expect(resultText(result)).not.toContain(plaintext);
  expect(JSON.stringify(result.details ?? {})).not.toContain(plaintext);
}

function freshSecretTool() {
  const api = createMockApi();
  registerExtension(api);
  return requireTool(api, "fn_secret_get");
}

pgDescribe("fn_secret_get value delivery", () => {
  beforeAll(h.beforeAll);
  beforeEach(async () => {
    await h.beforeEach();
    __clearFusionSessionIdentityRegistryForTests();
  });
  afterEach(async () => {
    __clearFusionSessionIdentityRegistryForTests();
    await h.afterEach();
  });
  afterAll(h.afterAll);

  it("delivers auto-policy values in model-visible content for agent and operator callers", async () => {
    const store = injectSecretsStore(h);
    const tool = freshSecretTool();
    const agentCtx = { cwd: h.rootDir(), agentId: "secret-agent", agentName: "Secret Agent", runId: "secret-run" };
    const values = ["normal-value", "line-one\nline-two", "quotes ' ` and $dollar"];
    for (const [index, plaintextValue] of values.entries()) {
      const key = `AUTO_${index}`;
      await store.createSecret({ scope: "project", key, plaintextValue, accessPolicy: "auto" });
      const result = await tool.execute(`auto-${index}`, { key }, undefined, undefined, agentCtx);
      expect(resultText(result)).toContain(plaintextValue);
      expect(result.details?.value).toBe(plaintextValue);
    }
    await store.createSecret({ scope: "global", key: "GLOBAL_ONLY", plaintextValue: "global-value", accessPolicy: "auto" });
    expect(resultText(await tool.execute("global", { key: "GLOBAL_ONLY" }, undefined, undefined, { cwd: h.rootDir() }))).toContain("global-value");
    await store.createSecret({ scope: "global", key: "PREFERRED", plaintextValue: "global-fallback", accessPolicy: "auto" });
    await store.createSecret({ scope: "project", key: "PREFERRED", plaintextValue: "project-wins", accessPolicy: "auto" });
    const preferred = await tool.execute("preferred", { key: "PREFERRED" }, undefined, undefined, agentCtx);
    expect(resultText(preferred)).toContain("project-wins");
    expect(resultText(preferred)).not.toContain("global-fallback");
    await store.createSecret({ scope: "project", key: "EMPTY", plaintextValue: "", accessPolicy: "auto" });
    expect(resultText(await tool.execute("empty", { key: "EMPTY", scope: "project" }, undefined, undefined, agentCtx))).toContain("stored secret value is empty");
    const audit = await h.store().getRunAuditEventsAsync({ runId: "secret-run", mutationType: "secret:read" });
    expect(JSON.stringify(audit.map((event) => event.metadata))).not.toContain("normal-value");
  });

  it("keeps plaintext out of non-delivery results", async () => {
    const store = injectSecretsStore(h);
    const tool = freshSecretTool();
    const cwd = h.rootDir();
    await store.createSecret({ scope: "project", key: "DENY", plaintextValue: "never-deliver", accessPolicy: "deny" });
    expectNoPlaintext(await tool.execute("deny", { key: "DENY" }, undefined, undefined, { cwd, agentId: "agent" }), "never-deliver");
    expectNoPlaintext(await tool.execute("missing", { key: "MISSING" }, undefined, undefined, { cwd, agentId: "agent" }), "never-deliver");
    const disposeA = registerFusionSessionIdentity(cwd, { agentId: "agent-a" });
    const disposeB = registerFusionSessionIdentity(cwd, { agentId: "agent-b" });
    try {
      const ambiguous = await tool.execute("ambiguous", { key: "DENY" }, undefined, undefined, { cwd });
      expect(ambiguous.details?.error).toBe("ambiguous-caller-identity");
      expectNoPlaintext(ambiguous, "never-deliver");
    } finally { disposeA(); disposeB(); }
  });

  it("keeps pending and denied prompt requests plaintext-free", async () => {
    const store = injectSecretsStore(h);
    const tool = freshSecretTool();
    const cwd = h.rootDir();
    await store.createSecret({ scope: "project", key: "PROMPT", plaintextValue: "prompt-plaintext", accessPolicy: "prompt" });
    const ctx = { cwd, agentId: "prompt-agent", runId: "prompt-run" };
    const minted = await tool.execute("mint", { key: "PROMPT" }, undefined, undefined, ctx);
    expectNoPlaintext(minted, "prompt-plaintext");
    const pending = await tool.execute("pending", { key: "PROMPT" }, undefined, undefined, ctx);
    expectNoPlaintext(pending, "prompt-plaintext");
    const layer = h.store().getAsyncLayer();
    if (!layer) throw new Error("harness store has no async layer");
    await new ApprovalRequestStore(null, { asyncLayer: layer }).decide(minted.details?.approvalRequestId as string, "denied", { actor: { actorId: "operator", actorType: "user", actorName: "Operator" } });
    const denied = await tool.execute("denied", { key: "PROMPT" }, undefined, undefined, ctx);
    expectNoPlaintext(denied, "prompt-plaintext");
    const audit = await h.store().getRunAuditEventsAsync({ runId: "prompt-run" });
    expect(JSON.stringify(audit.map((event) => event.metadata))).not.toContain("prompt-plaintext");
  });
});
