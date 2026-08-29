import { describe, expect, it } from "vitest";
import {
  COMPUTER_ACTIONS, COMPUTER_ERROR_CODES, COMPUTER_SUBCOMMANDS, COMPUTER_TIMEOUTS, SNAPSHOT_STALE_REASONS,
  failureEnvelope, isActionResult, isAppStateResult, isPermissionsResult, isValidSnapshotId, secretValue, validateResult,
  successEnvelope, targetKeyForApp, targetKeySlug, windowKeyFor,
} from "../computer/contract.js";

const locator = { kind: "ax-path" as const, path: "window[0]/button[1]", role: "AXButton", subrole: null, identifier: null, title: "OK" };
describe("computer contract", () => {
  it("has frozen, runtime inventories and stable envelope", () => {
    expect(COMPUTER_SUBCOMMANDS).toEqual(["capabilities", "permissions", "list-apps", "list-windows", "get-app-state", "click", "set-value", "type-text", "press-key", "hotkey", "scroll", "drag"]);
    for (const item of [COMPUTER_ACTIONS, COMPUTER_ERROR_CODES, COMPUTER_SUBCOMMANDS, SNAPSHOT_STALE_REASONS]) {
      expect(Object.isFrozen(item)).toBe(true); expect(new Set(item).size).toBe(item.length);
    }
    expect(successEnvelope("computer.click", { x: 1 })).toMatchObject({ schemaVersion: 1, ok: true, command: "computer.click" });
    expect(failureEnvelope("computer", { code: "INVALID_ARGUMENTS", message: "Bad arguments" })).toMatchObject({ schemaVersion: 1, ok: false, command: "computer" });
    expect(COMPUTER_TIMEOUTS).toMatchObject({ permissionProbe: 5000, discovery: 10000, stateCapture: 20000, screenshotCapture: 15000, locatorReplay: 10000, action: 10000 });
  });
  it("validates ids, permissions, state and action index shapes", () => {
    expect(isValidSnapshotId("cs_AbCdEf1234")).toBe(true); expect(isValidSnapshotId("cs_../evil")).toBe(false);
    expect(SNAPSHOT_STALE_REASONS).toEqual(["not-found", "superseded", "expired", "pid-changed", "window-mismatch", "window-gone", "consumed-by-action"]);
    expect(isPermissionsResult({ allGranted: false, checks: [{ status: "granted", granted: true, probed: false }] })).toBe(false);
    const state = { snapshot: { elements: [{ index: 7, locator }] }, screenshot: { path: "x", width: null, height: null, verifiedPermission: true }, screenshotError: { code: "SCREENSHOT_FAILED", message: "no" } };
    expect(isAppStateResult(state)).toBe(false);
    expect(isActionResult({ action: "drag", performed: true, snapshotId: null, elementIndex: 1, fromElementIndex: 0, toElementIndex: 1 })).toBe(false);
    expect(isActionResult({ action: "hotkey", performed: true, snapshotId: "cs_AbCdEf1234", elementIndex: null, fromElementIndex: null, toElementIndex: null })).toBe(false);
    const actionWithoutConsumption = { action: "click", performed: true, snapshotId: "cs_AbCdEf1234", elementIndex: 7, fromElementIndex: null, toElementIndex: null };
    expect(isActionResult(actionWithoutConsumption)).toBe(false);
    expect(validateResult("click", actionWithoutConsumption)).toBe(false);
    expect(validateResult("click", { ...actionWithoutConsumption, snapshotConsumed: true })).toBe(true);
  });
  it("keeps app and window addressing separate", () => {
    const app = { bundleId: "com.apple.Safari", name: "Safari", pid: 2 };
    const key = targetKeyForApp(app); expect(key).toBe("bundle:com.apple.Safari");
    expect(windowKeyFor(key, "one")).not.toBe(windowKeyFor(key, "two"));
    expect(targetKeySlug("bundle:../../x")).not.toContain("/");
    expect(secretValue("very-secret")).toBeTruthy();
  });
});
