// @vitest-environment node

import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { request as performRequest } from "../../test-request.js";
import { registerUpdateCheckRoutes } from "../register-update-check-routes.js";

const mockPerformUpdateCheck = vi.hoisted(() => vi.fn());
const mockPerformUpdateInstall = vi.hoisted(() => vi.fn());

vi.mock("../../update-check.js", () => ({
  clearUpdateCheckCache: vi.fn(),
  performUpdateCheck: (...args: unknown[]) => mockPerformUpdateCheck(...args),
  performUpdateInstall: (...args: unknown[]) => mockPerformUpdateInstall(...args),
}));

vi.mock("../../cli-package-version.js", () => ({ getCliPackageVersion: () => "1.2.3" }));

vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  return { ...actual, resolveGlobalDir: () => "/tmp/fusion-update-route-test" };
});

function createApp(sourceWorkspaceRoot?: string, updateCheckEnabled?: boolean) {
  const router = express.Router();
  registerUpdateCheckRoutes({
    router,
    store: { getGlobalSettingsStore: () => ({ getSettings: async () => ({ updateCheckEnabled }) }) } as never,
    options: sourceWorkspaceRoot ? { systemControl: { sourceWorkspaceRoot } } : undefined,
    rethrowAsApiError: (error: unknown) => { throw error; },
  } as never);
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error.message });
  });
  return app;
}

async function postInstall(app: ReturnType<typeof createApp>) {
  return performRequest(app, "POST", "/api/update-check/install", "{}", { "content-type": "application/json" });
}

const updateAvailable = { currentVersion: "1.2.3", latestVersion: "2.0.0", updateAvailable: true, lastChecked: 0 };

/*
FNXC:UpdateInstall 2026-08-14-19:44:
The production registrar is the symptom boundary: it must preserve failed re-checks
instead of returning the old indistinguishable `{ updated: false }` body.
*/
describe("registerUpdateCheckRoutes", () => {
  beforeEach(() => {
    mockPerformUpdateCheck.mockReset();
    mockPerformUpdateInstall.mockReset();
  });

  it("returns a visible no-update outcome without installing", async () => {
    mockPerformUpdateCheck.mockResolvedValue({ ...updateAvailable, updateAvailable: false, latestVersion: "1.2.3" });
    const response = await postInstall(createApp());
    expect(response.body).toMatchObject({ outcome: "no-update-available", updated: false });
    expect(response.body.message).toMatch(/already up to date/i);
    expect(response.body.error).toBeUndefined();
    expect(mockPerformUpdateInstall).not.toHaveBeenCalled();
  });

  it.each([
    ["registry failure", { currentVersion: "1.2.3", latestVersion: null, updateAvailable: false, error: "fetch failed" }, /fetch failed/i],
    ["unavailable version sentinel", { currentVersion: "0.0.0", latestVersion: null, updateAvailable: false, error: "Current Fusion version is unavailable" }, /Current Fusion version is unavailable/i],
    ["unresolved latest version", { currentVersion: "1.2.3", latestVersion: null, updateAvailable: false }, /could not determine/i],
  ])("reports %s as check-failed without installing", async (_name, result, message) => {
    mockPerformUpdateCheck.mockResolvedValue(result);
    const response = await postInstall(createApp());
    expect(response.body).toMatchObject({ outcome: "check-failed", updated: false });
    expect(response.body.message).toMatch(message);
    expect(response.body.error).toMatch(message);
    expect(response.body.message).not.toMatch(/already up to date/i);
    expect(mockPerformUpdateInstall).not.toHaveBeenCalled();
  });

  it("forwards the source checkout root and returns the helper outcome", async () => {
    mockPerformUpdateCheck.mockResolvedValue(updateAvailable);
    mockPerformUpdateInstall.mockResolvedValue({ ...updateAvailable, updated: false, outcome: "unsupported-install-method", message: "This Fusion is running from a source checkout" });
    const response = await postInstall(createApp("/repo/fusion"));
    expect(mockPerformUpdateInstall).toHaveBeenCalledWith("1.2.3", "2.0.0", expect.objectContaining({ installMethod: { sourceWorkspaceRoot: "/repo/fusion" } }));
    expect(response.body).toMatchObject({ outcome: "unsupported-install-method", updated: false });
  });

  it.each([
    ["installed", { ...updateAvailable, updated: true, outcome: "installed" }],
    ["failed", { ...updateAvailable, updated: false, outcome: "failed", error: "npm failed", message: "npm failed" }],
  ])("returns the %s install outcome", async (outcome, installResult) => {
    mockPerformUpdateCheck.mockResolvedValue(updateAvailable);
    mockPerformUpdateInstall.mockResolvedValue(installResult);
    const response = await postInstall(createApp());
    expect(response.body).toMatchObject({ outcome });
  });

  it("returns a retained pending install for later reads without another check or install", async () => {
    mockPerformUpdateCheck.mockResolvedValue(updateAvailable);
    mockPerformUpdateInstall.mockResolvedValue({ ...updateAvailable, updated: true, outcome: "installed" });
    const app = createApp();
    expect((await postInstall(app)).body).toMatchObject({ updated: true, latestVersion: "2.0.0" });
    const get = await performRequest(app, "GET", "/api/update-check");
    const refresh = await performRequest(app, "POST", "/api/update-check/refresh", "{}", { "content-type": "application/json" });
    const repeatInstall = await postInstall(app);
    for (const response of [get, refresh]) expect(response.body).toMatchObject({ pendingInstall: { updated: true, latestVersion: "2.0.0" } });
    expect(repeatInstall.body).toMatchObject({ updated: true, latestVersion: "2.0.0" });
    expect(mockPerformUpdateCheck).toHaveBeenCalledTimes(1);
    expect(mockPerformUpdateInstall).toHaveBeenCalledTimes(1);
  });

  it("keeps disabled update checks disabled", async () => {
    const response = await performRequest(createApp(undefined, false), "GET", "/api/update-check");
    expect(response.body).toMatchObject({ disabled: true, updateAvailable: false });
    expect(mockPerformUpdateCheck).not.toHaveBeenCalled();
  });
});
