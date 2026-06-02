import { describe, expect, it } from "vitest";
import { AlertCircle, Loader2, Pause, Play } from "lucide-react";
import {
  STATUS_CONFIG,
  formatStatusLabel,
  getProjectStatusConfig,
  isInitializingStatus,
} from "../projectStatusConfig";

describe("projectStatusConfig", () => {
  it("maps each known status to the expected config", () => {
    expect(STATUS_CONFIG.active.label).toBe("Active");
    expect(STATUS_CONFIG.active.color).toBe("var(--color-success)");
    expect(STATUS_CONFIG.active.icon).toBe(Play);

    expect(STATUS_CONFIG.paused.label).toBe("Paused");
    expect(STATUS_CONFIG.paused.color).toBe("var(--color-warning)");
    expect(STATUS_CONFIG.paused.icon).toBe(Pause);

    expect(STATUS_CONFIG.errored.label).toBe("Error");
    expect(STATUS_CONFIG.errored.color).toBe("var(--color-error)");
    expect(STATUS_CONFIG.errored.icon).toBe(AlertCircle);

    expect(STATUS_CONFIG.initializing.label).toBe("Initializing");
    expect(STATUS_CONFIG.initializing.color).toBe("var(--color-info)");
    expect(STATUS_CONFIG.initializing.icon).toBe(Loader2);
  });

  it("formats unknown statuses into readable labels", () => {
    expect(formatStatusLabel("removing_now")).toBe("Removing Now");
    expect(getProjectStatusConfig("removing")).toMatchObject({
      label: "Removing",
      color: "var(--color-error)",
    });
    expect(getProjectStatusConfig("removing").icon).toBe(AlertCircle);
  });

  it("returns Unknown fallback labels for undefined, null, or empty statuses", () => {
    for (const status of [undefined, null, ""]) {
      const config = getProjectStatusConfig(status);
      expect(config.label).toBe("Unknown");
      expect(config.color).toBe("var(--color-error)");
      expect(config.icon).toBe(AlertCircle);
      expect(config.icon).toBeDefined();
    }
  });

  it("only treats literal initializing as the spinner state", () => {
    expect(isInitializingStatus("initializing")).toBe(true);
    expect(isInitializingStatus("INITIALIZING")).toBe(false);
    expect(isInitializingStatus(undefined)).toBe(false);
  });
});
