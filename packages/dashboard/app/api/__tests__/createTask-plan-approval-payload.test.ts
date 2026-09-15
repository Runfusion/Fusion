import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const proxyApiMock = vi.hoisted(() => vi.fn());

vi.mock("../client/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client/client.js")>();
  return {
    ...actual,
    proxyApi: proxyApiMock,
  };
});

import { createTask } from "../tasks/tasks.js";

function postedBody(): Record<string, unknown> {
  const options = proxyApiMock.mock.calls.at(-1)?.[1] as RequestInit | undefined;
  return JSON.parse(String(options?.body)) as Record<string, unknown>;
}

describe("createTask plan approval payload", () => {
  beforeEach(() => {
    proxyApiMock.mockReset();
    proxyApiMock.mockResolvedValue({ id: "FN-234" });
  });

  it("omits the retired task override from ordinary and legacy-shaped inputs", async () => {
    await createTask({ description: "Use project policy" });
    expect(postedBody()).not.toHaveProperty("requirePlanApproval");

    await createTask({ description: "Ignore legacy override", requirePlanApproval: true } as never);
    expect(postedBody()).not.toHaveProperty("requirePlanApproval");
  });

  it("keeps supported create-time overrides in the explicit API whitelist", () => {
    const source = readFileSync(resolve(__dirname, "../tasks/tasks.ts"), "utf8");
    const start = source.indexOf("export async function createTask(");
    /*
    The former end marker ("/** Update explicit workspace repository intent") no longer exists in
    tasks.ts, which silently made this whitelist guard slice to -1 and fail. Anchor on the next
    exported declaration after createTask instead, which is structural rather than prose.
    */
    const end = source.indexOf("export interface TaskOverlapBlockerReport", start);
    const createTaskSource = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    for (const override of [
      "executionMode",
      "plannerOversightLevel",
      "sessionAdvisorEnabled",
      "enabledWorkflowSteps",
      // FNXC:HumanPlanApproval 2026-09-15-06:24: FN-408's per-card arming flag joins the explicit whitelist.
      "humanPlanApproval",
    ]) {
      expect(createTaskSource).toContain(override);
    }
    expect(createTaskSource).not.toContain("requirePlanApproval");
  });
});
