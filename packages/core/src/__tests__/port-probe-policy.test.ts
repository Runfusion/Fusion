import { describe, it, expect } from "vitest";
import {
  parsePortList,
  resolveReservedPortsFromEnv,
  shouldRunPortProbe,
} from "../__test-utils__/port-probe-policy.js";

// U3 / R10: the discovery probe is conditioned by env, but the reserved-port
// guard SET must never lose 4040 or any explicitly-declared port. These tests
// pin that asymmetry without spinning up a real vitest worker or live server.

describe("shouldRunPortProbe", () => {
  it("skips the probe in CI when no reserved ports are declared (zero fetches)", () => {
    expect(shouldRunPortProbe({ CI: "true" })).toBe(false);
  });

  it("runs the probe locally (no CI flag)", () => {
    expect(shouldRunPortProbe({})).toBe(true);
  });

  it("still runs the probe in CI when FUSION_RESERVED_PORTS is explicitly set", () => {
    expect(shouldRunPortProbe({ CI: "true", FUSION_RESERVED_PORTS: "4040,5000" })).toBe(true);
  });

  it("honors the FUSION_TEST_SKIP_PORT_PROBE=1 escape hatch everywhere", () => {
    expect(shouldRunPortProbe({ FUSION_TEST_SKIP_PORT_PROBE: "1" })).toBe(false);
    expect(
      shouldRunPortProbe({ FUSION_TEST_SKIP_PORT_PROBE: "1", FUSION_RESERVED_PORTS: "5000" }),
    ).toBe(false);
  });
});

describe("resolveReservedPortsFromEnv", () => {
  it("always includes 4040 even with an empty env (guard never drops the default)", () => {
    expect(resolveReservedPortsFromEnv({}).has(4040)).toBe(true);
  });

  it("includes explicitly-declared reserved ports in CI (guard set asymmetry)", () => {
    const reserved = resolveReservedPortsFromEnv({ CI: "true", FUSION_RESERVED_PORTS: "5000,6000" });
    expect(reserved.has(4040)).toBe(true);
    expect(reserved.has(5000)).toBe(true);
    expect(reserved.has(6000)).toBe(true);
  });

  it("folds in PORT and FUSION_SERVER_PORT", () => {
    const reserved = resolveReservedPortsFromEnv({ PORT: "8080", FUSION_SERVER_PORT: "9090" });
    expect(reserved.has(8080)).toBe(true);
    expect(reserved.has(9090)).toBe(true);
  });
});

describe("parsePortList", () => {
  it("ignores invalid and out-of-range entries", () => {
    expect(parsePortList("4040, abc, 70000, -1, 5000")).toEqual([4040, 5000]);
  });

  it("returns an empty list for undefined", () => {
    expect(parsePortList(undefined)).toEqual([]);
  });
});
