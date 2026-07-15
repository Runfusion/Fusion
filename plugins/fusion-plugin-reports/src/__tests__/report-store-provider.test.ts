import { describe, expect, it, vi } from "vitest";
import type { AsyncDataLayer, PluginContext } from "@fusion/core";
import { getReportStore } from "../store/report-store-provider.js";
import { ReportStore } from "../store/report-store.js";

function context(taskStore: object): PluginContext {
  return { taskStore } as PluginContext;
}

describe("getReportStore", () => {
  it("prefers an injected store", () => {
    const injected = {} as ReportStore;
    const getInjected = vi.fn(() => injected);
    const ctx = context({ getReportStore: getInjected });

    expect(getReportStore(ctx)).toBe(injected);
    expect(getInjected).toHaveBeenCalledOnce();
  });

  it("caches one PostgreSQL store per TaskStore", () => {
    const layerA = { projectId: "project-a" } as AsyncDataLayer;
    const layerB = { projectId: "project-b" } as AsyncDataLayer;
    const taskStoreA = { getAsyncLayer: () => layerA };
    const taskStoreB = { getAsyncLayer: () => layerB };

    const firstA = getReportStore(context(taskStoreA));
    expect(getReportStore(context(taskStoreA))).toBe(firstA);
    expect(getReportStore(context(taskStoreB))).not.toBe(firstA);
  });

  it("rejects a TaskStore without a PostgreSQL layer", () => {
    expect(() => getReportStore(context({ getAsyncLayer: () => null }))).toThrow(
      "Reports plugin requires the project PostgreSQL AsyncDataLayer",
    );
  });
});
