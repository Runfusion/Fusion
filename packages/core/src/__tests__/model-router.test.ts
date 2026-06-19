import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Database } from "../db.js";
import { queryUsageEvents } from "../usage-events.js";
import {
  routeModel,
  routeModelAndEmit,
  isMechanicalRoutableContext,
  type RouteModelInput,
} from "../model-router.js";
import {
  resolveTaskExecutionModel,
  resolveTaskPlanningModel,
  resolveTaskValidatorModel,
  routeTaskExecutionModel,
  routeTaskPlanningModel,
  routeTaskValidatorModel,
} from "../model-resolution.js";
import type { Settings } from "../types.js";

const DEFAULT = { provider: "anthropic", modelId: "claude-opus-4-8" } as const;
const CHEAP = { provider: "anthropic", modelId: "claude-haiku-4-5" } as const;

const routerSettings: Partial<Settings> = {
  modelRouterEnabled: true,
  modelRouterCheapProvider: CHEAP.provider,
  modelRouterCheapModelId: CHEAP.modelId,
  // give the default-pair lanes a concrete value
  defaultProvider: DEFAULT.provider,
  defaultModelId: DEFAULT.modelId,
};

function baseInput(overrides: Partial<RouteModelInput> = {}): RouteModelInput {
  return {
    lane: "execution",
    defaultPair: { ...DEFAULT },
    settings: routerSettings,
    context: { traits: ["dependabot"] },
    ...overrides,
  };
}

describe("isMechanicalRoutableContext", () => {
  it("matches dependabot/renovate sources", () => {
    expect(isMechanicalRoutableContext({ source: "dependabot" })).toBe(true);
    expect(isMechanicalRoutableContext({ source: "renovate" })).toBe(true);
  });
  it("matches mechanical traits and labels", () => {
    expect(isMechanicalRoutableContext({ traits: ["lint-only"] })).toBe(true);
    expect(isMechanicalRoutableContext({ labels: ["dependencies"] })).toBe(true);
  });
  it("matches conservative title keywords", () => {
    expect(isMechanicalRoutableContext({ title: "Bump lodash from 4.17.20 to 4.17.21" })).toBe(true);
    expect(isMechanicalRoutableContext({ title: "chore(deps): update eslint" })).toBe(true);
    expect(isMechanicalRoutableContext({ title: "Lint-only fix for unused imports" })).toBe(true);
  });
  it("does NOT match normal work (conservative default)", () => {
    expect(isMechanicalRoutableContext({ title: "Implement OAuth login flow" })).toBe(false);
    expect(isMechanicalRoutableContext({ traits: ["needs-review"] })).toBe(false);
    expect(isMechanicalRoutableContext(undefined)).toBe(false);
    expect(isMechanicalRoutableContext({})).toBe(false);
  });
});

describe("routeModel — core selection layer", () => {
  it("allowlisted step → cheap tier with escalation seam to the default pair", () => {
    const d = routeModel(baseInput());
    expect(d.routed).toBe(true);
    expect(d.reason).toBe("cheap-tier");
    expect(d.selection).toEqual(CHEAP);
    expect(d.counterfactual).toEqual(DEFAULT);
    expect(d.escalation).toEqual(DEFAULT);
  });

  it("normal task → default pair (not routable)", () => {
    const d = routeModel(baseInput({ context: { title: "Build a feature" } }));
    expect(d.routed).toBe(false);
    expect(d.reason).toBe("not-routable");
    expect(d.selection).toEqual(DEFAULT);
    expect(d.counterfactual).toEqual(DEFAULT);
  });

  it("column-agent override wins — router defers even for an allowlisted step", () => {
    const override = { provider: "openai", modelId: "gpt-5" };
    const d = routeModel(baseInput({ overridePair: override }));
    expect(d.routed).toBe(false);
    expect(d.reason).toBe("override");
    expect(d.selection).toEqual(override);
    // counterfactual is still the default-pair, not the override
    expect(d.counterfactual).toEqual(DEFAULT);
  });

  it("a project-policy-restricted model is NEVER selected even if it is the best pick", () => {
    const isPermitted = (p: { provider?: string; modelId?: string }) =>
      !(p.provider === CHEAP.provider && p.modelId === CHEAP.modelId);
    const d = routeModel(baseInput({ isPermitted }));
    expect(d.routed).toBe(false);
    expect(d.reason).toBe("cheap-forbidden");
    expect(d.selection).toEqual(DEFAULT); // fallback path also respects governance
  });

  it("governance is absolute — a forbidden override is NOT honored, falls through", () => {
    const override = { provider: "openai", modelId: "gpt-5" };
    const isPermitted = (p: { provider?: string }) => p.provider !== "openai";
    // override forbidden + not routable → default
    const d = routeModel(baseInput({ overridePair: override, isPermitted, context: { title: "x" } }));
    expect(d.reason).toBe("not-routable");
    expect(d.selection).toEqual(DEFAULT);
  });

  it("router disabled → byte-identical to the default pair", () => {
    const d = routeModel(baseInput({ settings: { ...routerSettings, modelRouterEnabled: false } }));
    expect(d.routed).toBe(false);
    expect(d.reason).toBe("disabled");
    expect(d.selection).toEqual(DEFAULT);
    expect(d.escalation).toBeUndefined();
  });

  it("cheap tier unconfigured → default pair", () => {
    const d = routeModel(
      baseInput({ settings: { modelRouterEnabled: true } }),
    );
    expect(d.reason).toBe("cheap-unconfigured");
    expect(d.selection).toEqual(DEFAULT);
  });

  it("no usable default pair → reason no-default", () => {
    const d = routeModel(baseInput({ defaultPair: {}, context: { title: "x" } }));
    expect(d.reason).toBe("no-default");
    expect(d.selection).toEqual({});
  });
});

describe("governed lanes vs ungoverned lanes (model-resolution wrappers)", () => {
  const task = {};

  it("execution lane: disabled router === resolveTaskExecutionModel (no regression)", () => {
    const settings = { ...routerSettings, modelRouterEnabled: false };
    const direct = resolveTaskExecutionModel(task, settings);
    const routed = routeTaskExecutionModel(task, settings).selection;
    expect(routed).toEqual(direct);
  });

  it("planning lane: disabled router === resolveTaskPlanningModel", () => {
    const settings = { ...routerSettings, modelRouterEnabled: false };
    expect(routeTaskPlanningModel(task, settings).selection).toEqual(
      resolveTaskPlanningModel(task, settings),
    );
  });

  it("validation lane: disabled router === resolveTaskValidatorModel", () => {
    const settings = { ...routerSettings, modelRouterEnabled: false };
    expect(routeTaskValidatorModel(task, settings).selection).toEqual(
      resolveTaskValidatorModel(task, settings),
    );
  });

  it("each governed lane down-routes an allowlisted step and reports its lane", () => {
    const opts = { context: { traits: ["dependabot"] } };
    const exec = routeTaskExecutionModel(task, routerSettings, opts);
    const plan = routeTaskPlanningModel(task, routerSettings, opts);
    const val = routeTaskValidatorModel(task, routerSettings, opts);
    expect(exec.lane).toBe("execution");
    expect(plan.lane).toBe("planning");
    expect(val.lane).toBe("validation");
    for (const d of [exec, plan, val]) {
      expect(d.routed).toBe(true);
      expect(d.selection).toEqual(CHEAP);
    }
  });

  it("each governed lane never returns a forbidden pair", () => {
    const opts = {
      context: { traits: ["dependabot"] },
      isPermitted: (p: { modelId?: string }) => p.modelId !== CHEAP.modelId,
    };
    for (const fn of [routeTaskExecutionModel, routeTaskPlanningModel, routeTaskValidatorModel]) {
      const d = fn(task, routerSettings, opts);
      expect(d.selection.modelId).not.toBe(CHEAP.modelId);
    }
  });

  it("ungoverned lanes (settings-only / title summarizer / project default) are untouched — no router wrappers exist for them", async () => {
    const mod = await import("../model-resolution.js");
    // Only the three task lanes get router wrappers; ensure no extra ones leaked in.
    expect(typeof mod.routeTaskExecutionModel).toBe("function");
    expect(typeof mod.routeTaskPlanningModel).toBe("function");
    expect(typeof mod.routeTaskValidatorModel).toBe("function");
    expect((mod as Record<string, unknown>).routeProjectDefaultModel).toBeUndefined();
    expect((mod as Record<string, unknown>).routeExecutionSettingsModel).toBeUndefined();
    expect((mod as Record<string, unknown>).routeTitleSummarizerSettingsModel).toBeUndefined();
  });
});

describe("routeModelAndEmit — telemetry with counterfactual", () => {
  let tmpDir: string;
  let db: Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kb-model-router-test-"));
    db = new Database(join(tmpDir, ".fusion"));
    db.init();
  });

  afterEach(async () => {
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("emits a routing decision with the counterfactual model into usage_events", () => {
    const d = routeModelAndEmit(db, { ...baseInput(), taskId: "t1", nodeId: "n1" });
    expect(d.routed).toBe(true);

    const rows = queryUsageEvents(db, { kind: "session_start" });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.category).toBe("model-router");
    expect(row.provider).toBe(CHEAP.provider);
    expect(row.model).toBe(CHEAP.modelId);
    expect(row.taskId).toBe("t1");
    expect(row.nodeId).toBe("n1");
    // The counterfactual model that WOULD have run absent the router:
    expect(row.meta?.routed).toBe(true);
    expect(row.meta?.reason).toBe("cheap-tier");
    expect(row.meta?.counterfactualProvider).toBe(DEFAULT.provider);
    expect(row.meta?.counterfactualModelId).toBe(DEFAULT.modelId);
  });

  it("emits the counterfactual even when not routed (default pair selected)", () => {
    routeModelAndEmit(db, { ...baseInput({ context: { title: "real work" } }), taskId: "t2" });
    const rows = queryUsageEvents(db, { kind: "session_start" });
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe(DEFAULT.provider);
    expect(rows[0].meta?.routed).toBe(false);
    expect(rows[0].meta?.counterfactualModelId).toBe(DEFAULT.modelId);
  });

  it("emission is fail-soft and does not alter the decision when db is undefined", () => {
    const d = routeModelAndEmit(undefined, baseInput());
    expect(d.selection).toEqual(CHEAP);
  });
});
