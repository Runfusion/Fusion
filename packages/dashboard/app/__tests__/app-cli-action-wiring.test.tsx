import { describe, expect, it, vi } from "vitest";
import type { AiSessionSummary } from "../api";
import {
  executeCliSessionBannerAction,
  getCliActionDisabledReasonForBanner,
  isSessionNeedingInputForBanner,
} from "../App";
import type { CliActionId } from "../components/SessionNotificationBanner";

function cliSession(overrides: Partial<AiSessionSummary> = {}): AiSessionSummary {
  return {
    id: overrides.id ?? "FN-6458",
    type: "cli-agent",
    status: overrides.status ?? "needs_attention",
    title: overrides.title ?? "CLI session needs attention",
    projectId: overrides.projectId ?? "proj-1",
    updatedAt: overrides.updatedAt ?? "2026-06-14T19:32:00.000Z",
    cliVariant: overrides.cliVariant ?? "userExited",
    cliSessionId: Object.prototype.hasOwnProperty.call(overrides, "cliSessionId")
      ? overrides.cliSessionId
      : "cli-session-1",
  };
}

describe("App CLI session banner wiring", () => {
  it("surfaces cli-agent needs_attention and waiting_on_input sessions through the App banner filter", () => {
    expect(isSessionNeedingInputForBanner(cliSession({ status: "needs_attention" }))).toBe(true);
    expect(isSessionNeedingInputForBanner(cliSession({ status: "waiting_on_input" }))).toBe(true);
    expect(isSessionNeedingInputForBanner(cliSession({ status: "awaiting_input" }))).toBe(true);
    expect(isSessionNeedingInputForBanner(cliSession({ status: "error" }))).toBe(true);
    expect(isSessionNeedingInputForBanner(cliSession({ status: "generating" }))).toBe(false);
    expect(isSessionNeedingInputForBanner(cliSession({ status: "complete" }))).toBe(false);
  });

  it.each([
    ["advance", "api"],
    ["retry", "retryTask"],
    ["cancel", "moveTask"],
    ["reauthenticate", "openSettings"],
    ["relaunch", "relaunchCliSession"],
  ] as const)("maps %s to an observable existing route or flow", async (action, expected) => {
    const apiClient = vi.fn().mockResolvedValue({ ok: true });
    const retryTask = vi.fn().mockResolvedValue({ id: "FN-6458" });
    const moveTask = vi.fn().mockResolvedValue({ id: "FN-6458" });
    const openAuthenticationSettings = vi.fn();
    const addToast = vi.fn();
    const relaunchCliSessionClient = vi.fn().mockResolvedValue({ ok: true, taskId: "FN-6458" });

    await executeCliSessionBannerAction(cliSession(), action, {
      currentProjectId: "proj-1",
      retryTask,
      moveTask,
      openAuthenticationSettings,
      addToast,
      apiClient,
      relaunchCliSessionClient,
    });

    if (expected === "api") {
      expect(apiClient).toHaveBeenCalledWith(
        "/cli-sessions/cli-session-1/confirm-advance",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ decision: "advance", projectId: "proj-1" }),
        }),
      );
    } else if (expected === "retryTask") {
      expect(retryTask).toHaveBeenCalledWith("FN-6458");
    } else if (expected === "moveTask") {
      expect(moveTask).toHaveBeenCalledWith("FN-6458", "todo");
    } else if (expected === "relaunchCliSession") {
      expect(relaunchCliSessionClient).toHaveBeenCalledWith("cli-session-1", "proj-1");
      expect(addToast).toHaveBeenCalledWith("CLI session relaunch requested", "success");
    } else {
      expect(openAuthenticationSettings).toHaveBeenCalledTimes(1);
    }
    if (expected !== "relaunchCliSession") {
      expect(addToast).not.toHaveBeenCalled();
    }
  });

  it("marks missing-id actions disabled so visible buttons are not silent no-ops", () => {
    const actions: CliActionId[] = ["advance", "retry", "cancel", "reauthenticate", "relaunch"];
    const missingId = cliSession({ cliSessionId: undefined });
    const withId = cliSession();

    const disabled = new Map(actions.map((action) => [action, getCliActionDisabledReasonForBanner(withId, action)]));
    expect(disabled.get("relaunch")).toBeNull();
    expect(disabled.get("advance")).toBeNull();
    expect(getCliActionDisabledReasonForBanner(missingId, "advance")).toMatch(/missing/i);
    expect(getCliActionDisabledReasonForBanner(missingId, "relaunch")).toMatch(/missing/i);
  });

  it("does not fire a relaunch API call when the CLI session id is missing", async () => {
    const relaunchCliSessionClient = vi.fn();
    const addToast = vi.fn();

    await executeCliSessionBannerAction(cliSession({ cliSessionId: undefined }), "relaunch", {
      retryTask: vi.fn(),
      moveTask: vi.fn(),
      openAuthenticationSettings: vi.fn(),
      addToast,
      relaunchCliSessionClient,
    });

    expect(relaunchCliSessionClient).not.toHaveBeenCalled();
    expect(addToast).not.toHaveBeenCalled();
  });

  it("toasts instead of silently failing if an enabled CLI action route rejects", async () => {
    const addToast = vi.fn();
    await executeCliSessionBannerAction(cliSession(), "retry", {
      retryTask: vi.fn().mockRejectedValue(new Error("retry failed")),
      moveTask: vi.fn(),
      openAuthenticationSettings: vi.fn(),
      addToast,
      apiClient: vi.fn(),
    });

    expect(addToast).toHaveBeenCalledWith("retry failed", "error");
  });
});
