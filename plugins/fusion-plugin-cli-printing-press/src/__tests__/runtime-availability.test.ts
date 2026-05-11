import { describe, expect, it } from "vitest";
import plugin from "../index.js";
import { buildExecutorRuntimeEnv } from "../runtime/executor-runtime-env.js";
import { makeFakeRegistry } from "./fixtures/registry.js";

describe("runtime availability", () => {
  it("exposes executor runtime env hook through plugin entry", () => {
    expect(typeof plugin.executorRuntimeEnv).toBe("function");
  });

  it("returns PATH/env entries for generated CLIs only", () => {
    const h = makeFakeRegistry();
    try {
      const result = buildExecutorRuntimeEnv(
        h.store,
        { taskId: "FN-3769", worktreePath: h.rootDir, rootDir: h.rootDir },
        {
          pluginId: "fusion-plugin-cli-printing-press",
          taskStore: {} as never,
          settings: {},
          logger: { info() {}, warn() {}, error() {}, debug() {} },
          emitEvent() {},
        },
      );

      expect(result.pathPrepend).toHaveLength(1);
      expect(result.pathPrepend[0]).toContain(`/artifacts/${h.services.acme.id}/${h.specs.acme.id}`);
      expect(result.env).toEqual({ ACME_TOKEN: "acme-secret" });
    } finally {
      h.cleanup();
    }
  });

  it("skips draft specs from PATH contributions", () => {
    const h = makeFakeRegistry();
    try {
      const betaArtifacts = h.store.listArtifacts(h.specs.beta.id);
      expect(betaArtifacts).toHaveLength(0);

      const result = buildExecutorRuntimeEnv(
        h.store,
        { taskId: "FN-3769", worktreePath: h.rootDir, rootDir: h.rootDir },
        {
          pluginId: "fusion-plugin-cli-printing-press",
          taskStore: {} as never,
          settings: {},
          logger: { info() {}, warn() {}, error() {}, debug() {} },
          emitEvent() {},
        },
      );

      expect(result.pathPrepend.some((entry) => entry.includes(`/artifacts/${h.services.beta.id}/`))).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it.skip("TODO(FN-3767): cover resolveGeneratedCliInvocation contract once exported", () => {
    // FN-3767 documented resolveGeneratedCliInvocation, but this branch has only buildExecutorRuntimeEnv.
  });
});
