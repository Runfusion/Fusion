/**
 * FNXC:PgTestTemplateDb 2026-07-17-12:00:
 * Vitest thread isolation gives each test file a private harness module registry
 * while retaining one process pid. These tests load fresh module instances with
 * resetModules so the PG template lifecycle is exercised exactly as dashboard
 * API worker threads exercise it, including missing, reused, half-built, and
 * concurrently-created template states.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PG_AVAILABLE,
  type PgTestHarness,
} from "../../__test-utils__/pg-test-harness.js";

type HarnessModule = typeof import("../../__test-utils__/pg-test-harness.js");

const testDescribe = PG_AVAILABLE ? describe : describe.skip;

async function loadFreshHarnessModule(): Promise<HarnessModule> {
  vi.resetModules();
  return import("../../__test-utils__/pg-test-harness.js");
}

async function assertTaskRoundTrip(harness: PgTestHarness, description: string): Promise<void> {
  const task = await harness.store.createTask({ description });
  await expect(harness.store.getTask(task.id)).resolves.toMatchObject({
    id: task.id,
    description,
  });
}

async function teardownAll(harnesses: readonly PgTestHarness[]): Promise<void> {
  await Promise.all(harnesses.map((harness) => harness.teardown()));
}

testDescribe("PG template database lifecycle across isolated harness modules", () => {
  const harnesses: PgTestHarness[] = [];

  afterEach(async () => {
    await teardownAll(harnesses.splice(0));
  });

  it("creates usable isolated stores concurrently from fresh same-pid module instances", async () => {
    const modules: HarnessModule[] = [];
    for (let index = 0; index < 3; index += 1) {
      modules.push(await loadFreshHarnessModule());
    }

    const created = await Promise.all(
      modules.map((harnessModule, moduleIndex) =>
        harnessModule.createTaskStoreForTest({ prefix: `template_concurrent_${moduleIndex}` }),
      ),
    );
    harnesses.push(...created);

    await Promise.all(
      created.map((harness, index) =>
        assertTaskRoundTrip(harness, `concurrent module store ${index}`),
      ),
    );
  });

  it("builds a missing template before copying its first store", async () => {
    const harnessModule = await loadFreshHarnessModule();
    await harnessModule.__pgTestTemplateTestHooks.dropTemplate();
    expect(await harnessModule.__pgTestTemplateTestHooks.templateExists()).toBe(false);

    const harness = await harnessModule.createTaskStoreForTest({ prefix: "template_missing" });
    harnesses.push(harness);

    expect(await harnessModule.__pgTestTemplateTestHooks.templateExists()).toBe(true);
    await assertTaskRoundTrip(harness, "missing template recovery");
  });

  it("reuses the valid template memo within one module instance", async () => {
    const harnessModule = await loadFreshHarnessModule();
    const templateName = harnessModule.__pgTestTemplateTestHooks.templateName();
    const first = await harnessModule.createTaskStoreForTest({ prefix: "template_reuse_first" });
    const second = await harnessModule.createTaskStoreForTest({ prefix: "template_reuse_second" });
    harnesses.push(first, second);

    expect(harnessModule.__pgTestTemplateTestHooks.templateName()).toBe(templateName);
    expect(await harnessModule.__pgTestTemplateTestHooks.templateExists()).toBe(true);
    await Promise.all([
      assertTaskRoundTrip(first, "first valid template copy"),
      assertTaskRoundTrip(second, "second valid template copy"),
    ]);
  });

  it("rebuilds a half-built template into a usable schema copy", async () => {
    const harnessModule = await loadFreshHarnessModule();
    await harnessModule.__pgTestTemplateTestHooks.createHalfBuiltTemplate();

    const harness = await harnessModule.createTaskStoreForTest({ prefix: "template_half_built" });
    harnesses.push(harness);

    expect(await harnessModule.__pgTestTemplateTestHooks.templateExists()).toBe(true);
    await assertTaskRoundTrip(harness, "half-built template recovery");
  });
});
