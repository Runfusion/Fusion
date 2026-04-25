import { describe, it, expect } from "vitest";
import {
  HEARTBEAT_INTERVAL_PRESETS,
  MIN_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  formatHeartbeatInterval,
  resolveHeartbeatIntervalMs,
  getHeartbeatIntervalOptions,
} from "../heartbeatIntervals";

describe("HEARTBEAT_INTERVAL_PRESETS", () => {
  it("starts at 5 minutes (300000ms)", () => {
    expect(HEARTBEAT_INTERVAL_PRESETS[0].value).toBe(300000);
    expect(HEARTBEAT_INTERVAL_PRESETS[0].label).toBe("5m");
  });

  it("includes 48h preset", () => {
    const preset = HEARTBEAT_INTERVAL_PRESETS.find((p) => p.label === "48h");
    expect(preset).toBeDefined();
    expect(preset?.value).toBe(172800000);
  });

  it("includes 72h preset", () => {
    const preset = HEARTBEAT_INTERVAL_PRESETS.find((p) => p.label === "72h");
    expect(preset).toBeDefined();
    expect(preset?.value).toBe(259200000);
  });

  it("includes 1w preset", () => {
    const preset = HEARTBEAT_INTERVAL_PRESETS.find((p) => p.label === "1w");
    expect(preset).toBeDefined();
    expect(preset?.value).toBe(604800000);
  });

  it("does not include any presets below 5 minutes", () => {
    const allBelow5m = HEARTBEAT_INTERVAL_PRESETS.filter((p) => p.value < 300000);
    expect(allBelow5m).toHaveLength(0);
  });

  it("is sorted in ascending order by value", () => {
    for (let i = 1; i < HEARTBEAT_INTERVAL_PRESETS.length; i++) {
      expect(HEARTBEAT_INTERVAL_PRESETS[i].value).toBeGreaterThan(
        HEARTBEAT_INTERVAL_PRESETS[i - 1].value,
      );
    }
  });
});

describe("MIN_HEARTBEAT_INTERVAL_MS", () => {
  it("is 5 minutes (300000ms)", () => {
    expect(MIN_HEARTBEAT_INTERVAL_MS).toBe(300000);
  });
});

describe("formatHeartbeatInterval", () => {
  it("formats milliseconds below 1000", () => {
    expect(formatHeartbeatInterval(500)).toBe("500ms");
  });

  it("formats seconds", () => {
    expect(formatHeartbeatInterval(1000)).toBe("1s");
    expect(formatHeartbeatInterval(30000)).toBe("30s");
    expect(formatHeartbeatInterval(45000)).toBe("45s");
  });

  it("formats minutes", () => {
    expect(formatHeartbeatInterval(60000)).toBe("1m");
    expect(formatHeartbeatInterval(300000)).toBe("5m");
    expect(formatHeartbeatInterval(2700000)).toBe("45m");
  });

  it("formats hours", () => {
    expect(formatHeartbeatInterval(3600000)).toBe("1h");
    expect(formatHeartbeatInterval(7200000)).toBe("2h");
    expect(formatHeartbeatInterval(43200000)).toBe("12h");
  });

  it("formats days", () => {
    expect(formatHeartbeatInterval(86400000)).toBe("1d");
    expect(formatHeartbeatInterval(172800000)).toBe("2d");
    expect(formatHeartbeatInterval(432000000)).toBe("5d");
  });

  it("formats weeks", () => {
    expect(formatHeartbeatInterval(604800000)).toBe("1w");
    expect(formatHeartbeatInterval(1209600000)).toBe("2w");
  });
});

describe("resolveHeartbeatIntervalMs", () => {
  it("returns default for non-number input", () => {
    expect(resolveHeartbeatIntervalMs(undefined)).toBe(DEFAULT_HEARTBEAT_INTERVAL_MS);
    expect(resolveHeartbeatIntervalMs(null)).toBe(DEFAULT_HEARTBEAT_INTERVAL_MS);
    expect(resolveHeartbeatIntervalMs("300000")).toBe(DEFAULT_HEARTBEAT_INTERVAL_MS);
    expect(resolveHeartbeatIntervalMs({})).toBe(DEFAULT_HEARTBEAT_INTERVAL_MS);
    expect(resolveHeartbeatIntervalMs([])).toBe(DEFAULT_HEARTBEAT_INTERVAL_MS);
  });

  it("returns default for NaN or Infinity", () => {
    expect(resolveHeartbeatIntervalMs(NaN)).toBe(DEFAULT_HEARTBEAT_INTERVAL_MS);
    expect(resolveHeartbeatIntervalMs(Infinity)).toBe(DEFAULT_HEARTBEAT_INTERVAL_MS);
    expect(resolveHeartbeatIntervalMs(-Infinity)).toBe(DEFAULT_HEARTBEAT_INTERVAL_MS);
  });

  it("clamps values below 5 minutes to 5 minutes", () => {
    expect(resolveHeartbeatIntervalMs(0)).toBe(300000);
    expect(resolveHeartbeatIntervalMs(1000)).toBe(300000);
    expect(resolveHeartbeatIntervalMs(60000)).toBe(300000);
    expect(resolveHeartbeatIntervalMs(299999)).toBe(300000);
  });

  it("returns exact value for valid intervals >= 5 minutes", () => {
    expect(resolveHeartbeatIntervalMs(300000)).toBe(300000);
    expect(resolveHeartbeatIntervalMs(600000)).toBe(600000);
    expect(resolveHeartbeatIntervalMs(3600000)).toBe(3600000);
    expect(resolveHeartbeatIntervalMs(172800000)).toBe(172800000);
  });

  it("rounds floating point values", () => {
    expect(resolveHeartbeatIntervalMs(300001.7)).toBe(300002);
    expect(resolveHeartbeatIntervalMs(300001.3)).toBe(300001);
  });

  it("clamps negative values to minimum", () => {
    expect(resolveHeartbeatIntervalMs(-1)).toBe(300000);
    expect(resolveHeartbeatIntervalMs(-60000)).toBe(300000);
  });

  describe("legacy sub-5m values resolve to 5m", () => {
    it("1s legacy value resolves to 5m", () => {
      expect(resolveHeartbeatIntervalMs(1000)).toBe(300000);
    });

    it("5s legacy value resolves to 5m", () => {
      expect(resolveHeartbeatIntervalMs(5000)).toBe(300000);
    });

    it("10s legacy value resolves to 5m", () => {
      expect(resolveHeartbeatIntervalMs(10000)).toBe(300000);
    });

    it("30s legacy value resolves to 5m", () => {
      expect(resolveHeartbeatIntervalMs(30000)).toBe(300000);
    });

    it("1m legacy value resolves to 5m", () => {
      expect(resolveHeartbeatIntervalMs(60000)).toBe(300000);
    });
  });
});

describe("getHeartbeatIntervalOptions", () => {
  it("returns all presets when interval matches a preset", () => {
    const options = getHeartbeatIntervalOptions(300000);
    expect(options).toEqual([...HEARTBEAT_INTERVAL_PRESETS]);
  });

  it("adds custom option when interval does not match any preset", () => {
    const options = getHeartbeatIntervalOptions(650000);
    // Should have all presets plus a custom option
    expect(options.length).toBe(HEARTBEAT_INTERVAL_PRESETS.length + 1);
    // The custom option should be added and sorted in by value
    const customOption = options.find((o) => o.label.includes("(custom)"));
    expect(customOption?.value).toBe(650000);
    expect(customOption?.label).toBe("11m (custom)");
  });

  it("sorts custom option into correct position by value", () => {
    // 48h is a preset, so no custom option added
    const optionsWithPreset = getHeartbeatIntervalOptions(172800000);
    expect(optionsWithPreset.length).toBe(HEARTBEAT_INTERVAL_PRESETS.length);
    expect(optionsWithPreset).toEqual([...HEARTBEAT_INTERVAL_PRESETS]);
  });

  it("sorts custom option after 1w when custom value exceeds 1w", () => {
    // 500h is not a preset, should be added and sorted after 1w
    const options = getHeartbeatIntervalOptions(500 * 3600000);
    const customOption = options.find((o) => o.label.includes("(custom)"));
    expect(customOption).toBeDefined();
    // Custom option should be inserted at the end since 500h > 1w
    const customIndex = options.findIndex((o) => o.label.includes("(custom)"));
    expect(options[customIndex - 1].label).toBe("1w");
  });

  it("handles custom intervals below the minimum", () => {
    // Even if a legacy custom value is below 5m, getHeartbeatIntervalOptions
    // should include it in the options (the resolver clamps when consuming)
    const options = getHeartbeatIntervalOptions(30000); // 30s - no longer a preset
    const customOption = options.find((o) => o.value === 30000);
    expect(customOption).toBeDefined();
    expect(customOption?.label).toBe("30s (custom)");
  });
});
