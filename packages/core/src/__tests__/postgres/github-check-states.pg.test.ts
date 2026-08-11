import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import {
  listGitHubCheckStatesAsync,
  pruneGitHubCheckStatesAsync,
  recordGitHubCheckStateAsync,
} from "../../task-store/async/async-ci-checks.js";

const pgTest = pgDescribe;
const timestamp = "2026-08-09T12:00:00.000Z";

pgTest("GitHub check-state persistence", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_github_check_states" });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  const input = (overrides = {}) => ({
    repo: "Owner/Repo",
    headSha: "ABC1234",
    checkName: "ci/build",
    state: "success",
    eventKind: "check_suite" as const,
    reportedAt: timestamp,
    ...overrides,
  });

  it("stores normalized state only in its explicit project partition", async () => {
    const layer = h.layer();
    await recordGitHubCheckStateAsync(layer, input(), "project-a");

    await expect(listGitHubCheckStatesAsync(layer, { repo: "owner/repo", headSha: "abc1234" }, "project-a"))
      .resolves.toMatchObject([{ repo: "owner/repo", headSha: "abc1234", checkName: "ci/build", state: "success" }]);
    await expect(listGitHubCheckStatesAsync(layer, { repo: "owner/repo", headSha: "abc1234" }, "project-b"))
      .resolves.toEqual([]);
  });

  it("does not let an older delivery regress a newer conclusion", async () => {
    const layer = h.layer();
    await recordGitHubCheckStateAsync(layer, input({ state: "failure", reportedAt: "2026-08-09T13:00:00.000Z" }), "project-a");
    await expect(recordGitHubCheckStateAsync(layer, input({ reportedAt: timestamp }), "project-a")).resolves.toBe(false);

    await expect(listGitHubCheckStatesAsync(layer, { repo: "owner/repo", headSha: "abc1234" }, "project-a"))
      .resolves.toMatchObject([{ state: "failure" }]);
  });

  it("rejects an absent project partition on every operation", async () => {
    const layer = h.layer();
    await expect(recordGitHubCheckStateAsync(layer, input(), " ")).rejects.toThrow("require asyncLayer.projectId");
    await expect(listGitHubCheckStatesAsync(layer, { repo: "owner/repo", headSha: "abc1234" }, "")).rejects.toThrow("require asyncLayer.projectId");
    await expect(pruneGitHubCheckStatesAsync(layer, " ")).rejects.toThrow("require asyncLayer.projectId");
  });

  it("prunes expired rows in only the requested project", async () => {
    const layer = h.layer();
    await recordGitHubCheckStateAsync(layer, input(), "project-a");
    await recordGitHubCheckStateAsync(layer, input({ checkName: "ci/test" }), "project-b");
    await layer.db.execute(sql`UPDATE project.github_check_states SET received_at = '2000-01-01T00:00:00.000Z'`);

    await expect(pruneGitHubCheckStatesAsync(layer, "project-a")).resolves.toBe(1);
    await expect(listGitHubCheckStatesAsync(layer, { repo: "owner/repo", headSha: "abc1234" }, "project-a")).resolves.toEqual([]);
    await expect(listGitHubCheckStatesAsync(layer, { repo: "owner/repo", headSha: "abc1234" }, "project-b")).resolves.toHaveLength(1);
  });
});
