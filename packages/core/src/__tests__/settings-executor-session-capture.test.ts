/**
 * FNXC:StashSessionCapture 2026-08-19-04:37:
 * RUFU-122 Step 1: schema defaults for the task-terminal transcript upload
 * settings (operator-fixed key names): executorSessionCaptureEnabled (default
 * true — gates the transcript upload only; the RUFU-068 terminal anchor event
 * still fires), executorSessionCaptureMaxEvents (default 20000 — per-task cap,
 * most recent N kept), executorSessionCaptureIncludeStatus (default false —
 * schema-only, no UI row). All three must resolve to their defaults in
 * effective project settings and stay PROJECT-scoped so the settings save-split
 * routes them into the per-project patch (the feature is per-project because
 * the Stash backend selection is per-project).
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROJECT_SETTINGS,
  PROJECT_SETTINGS_KEYS,
  isProjectSettingsKey,
} from "../index.js";

describe("RUFU-122 executor session-capture settings schema defaults", () => {
  it("executorSessionCaptureEnabled defaults to true (transcript on; anchor unaffected)", () => {
    expect(DEFAULT_PROJECT_SETTINGS.executorSessionCaptureEnabled).toBe(true);
  });

  it("executorSessionCaptureMaxEvents defaults to 20000", () => {
    expect(DEFAULT_PROJECT_SETTINGS.executorSessionCaptureMaxEvents).toBe(20_000);
  });

  it("executorSessionCaptureIncludeStatus defaults to false (schema-only)", () => {
    expect(DEFAULT_PROJECT_SETTINGS.executorSessionCaptureIncludeStatus).toBe(false);
  });

  it("all three keys are project-scoped (save-split routes them to the project patch)", () => {
    for (const key of [
      "executorSessionCaptureEnabled",
      "executorSessionCaptureMaxEvents",
      "executorSessionCaptureIncludeStatus",
    ]) {
      expect(isProjectSettingsKey(key)).toBe(true);
      expect(PROJECT_SETTINGS_KEYS).toContain(key);
    }
  });
});
