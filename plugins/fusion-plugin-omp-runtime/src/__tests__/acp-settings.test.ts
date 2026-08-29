import { describe, expect, it } from "vitest";
import {
  buildOmpAcpArgs,
  buildOmpAcpRuntimeSettings,
  OMP_ACP_ENV_ALLOWLIST,
  modelForCli,
  normalizeOmpCliModel,
  resolveOmpAcpAuthPreferMethods,
} from "../acp-settings.js";

describe("acp-settings", () => {
  it("builds omp acp args without --model when model is absent", () => {
    expect(buildOmpAcpArgs()).toEqual(["acp"]);
    expect(buildOmpAcpArgs({})).toEqual(["acp"]);
  });

  it("places --model before the acp mode", () => {
    expect(buildOmpAcpArgs({ model: "claude-sonnet-4" })).toEqual([
      "--model",
      "claude-sonnet-4",
      "acp",
    ]);
  });

  it("prefers agent auth over terminal", () => {
    expect(resolveOmpAcpAuthPreferMethods()).toEqual(["agent", "terminal"]);
  });

  it("normalizes provider-qualified model ids", () => {
    expect(normalizeOmpCliModel("omp-cli/claude-sonnet-4")).toBe("claude-sonnet-4");
    expect(normalizeOmpCliModel("omp/claude-sonnet-4")).toBe("claude-sonnet-4");
    expect(normalizeOmpCliModel("claude-sonnet-4")).toBe("claude-sonnet-4");
    expect(normalizeOmpCliModel(undefined)).toBeUndefined();
  });

  it("omits --model for the omp/default fallback", () => {
    expect(modelForCli("omp/default")).toBeUndefined();
    expect(modelForCli("default")).toBeUndefined();
    expect(modelForCli("omp-cli/claude-sonnet-4")).toBe("claude-sonnet-4");
  });

  it("builds AcpRuntimeAdapter settings for OMP ACP", () => {
    const settings = buildOmpAcpRuntimeSettings({
      binary: "/usr/local/bin/omp",
      model: "omp-cli/claude-sonnet-4",
    });
    expect(settings.acpBinaryPath).toBe("/usr/local/bin/omp");
    expect(settings.acpArgs).toEqual(["--model", "claude-sonnet-4", "acp"]);
    expect(settings.acpEnvAllowList).toEqual([...OMP_ACP_ENV_ALLOWLIST]);
    expect(settings.acpFsRead).toBe(false);
    expect(settings.acpFsWrite).toBe(false);
    expect(settings.acpAllowUnrestricted).toBe(true);
    expect(settings.acpEnvAllowList).toEqual(expect.arrayContaining(["HOME", "PATH"]));
    expect(settings.acpAuthenticate).toEqual(
      expect.objectContaining({
        preferMethods: ["agent", "terminal"],
        meta: { headless: true },
        require: false,
      }),
    );
  });
});
