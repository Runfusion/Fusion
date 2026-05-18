// FN-5031: Focused core-side contract coverage for SecretsEnvSettings.
// The materialization implementation (writeSecretsEnvFile / cleanupSecretsEnvFile,
// fingerprint sidecar, gitignore guard, overwrite policies) lives in
// packages/engine/src/secrets-env-writer.ts and is covered by:
//   - packages/engine/src/__tests__/secrets-env-writer.test.ts
//   - packages/engine/src/__tests__/worktree-acquisition-secrets-env.test.ts
//   - packages/engine/src/__tests__/worktree-pool-secrets-env-cleanup.test.ts
//   - packages/engine/src/__tests__/reliability-interactions/secrets-env-materialization.test.ts
// Do not duplicate writer/materialization assertions here.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_SETTINGS } from "../settings-schema.js";
import type { ProjectSettings, SecretsEnvConfig, SecretsEnvSettings } from "../types.js";
import { createSharedTaskStoreTestHarness } from "./store-test-helpers.js";

describe("SecretsEnvSettings contract", () => {
  it("keeps the deprecated SecretsEnvConfig alias assignable to SecretsEnvSettings", () => {
    const _alias: SecretsEnvSettings = {} as SecretsEnvConfig;
    expect(_alias).toBeDefined();
  });

  it("accepts a fully populated structural object with documented overwrite policies", () => {
    const merged: SecretsEnvSettings = {
      enabled: true,
      filename: ".env.fusion",
      overwritePolicy: "merge",
      keyPrefix: "FUSION_",
      requireGitignored: true,
    };

    const skipped: SecretsEnvSettings = { overwritePolicy: "skip" };
    const replaced: SecretsEnvSettings = { overwritePolicy: "replace" };

    expect(merged.overwritePolicy).toBe("merge");
    expect(skipped.overwritePolicy).toBe("skip");
    expect(replaced.overwritePolicy).toBe("replace");
  });

  it("defaults secretsEnv to undefined in project settings schema", () => {
    // Undefined default means env materialization is disabled unless a project opts in,
    // consistent with SecretsEnvSettings.enabled defaulting to false.
    expect(DEFAULT_PROJECT_SETTINGS.secretsEnv).toBeUndefined();
  });

  it("allows ProjectSettings.secretsEnv to be either populated or undefined", () => {
    const populated: Pick<ProjectSettings, "secretsEnv">["secretsEnv"] = {
      enabled: true,
      filename: ".env.fusion",
      overwritePolicy: "replace",
      keyPrefix: "APP_",
      requireGitignored: false,
    };
    const unset: Pick<ProjectSettings, "secretsEnv">["secretsEnv"] = undefined;

    expect(populated?.filename).toBe(".env.fusion");
    expect(unset).toBeUndefined();
  });

  describe("project round-trip via public store API", () => {
    const harness = createSharedTaskStoreTestHarness();

    beforeAll(harness.beforeAll);
    beforeEach(harness.beforeEach);
    afterEach(harness.afterEach);

    it("round-trips secretsEnv with all fields", async () => {
      const expected: SecretsEnvSettings = {
        enabled: true,
        filename: ".env.fusion",
        overwritePolicy: "replace",
        keyPrefix: "APP_",
        requireGitignored: false,
      };

      await harness.store().updateSettings({ secretsEnv: expected });
      const settings = await harness.store().getSettings();
      expect(settings.secretsEnv).toEqual(expected);
    });
  });
});
