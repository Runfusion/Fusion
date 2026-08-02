import { describe, expect, it } from "vitest";
import { buildConsumerId } from "../task-store/task-lifecycle-consumer-identity.js";

describe("buildConsumerId", () => {
  it("builds role-only and persisted-instance identities", () => {
    expect(buildConsumerId("engine")).toBe("engine");
    expect(buildConsumerId("child-process-worker", "node-17")).toBe("child-process-worker:node-17");
  });

  it("accepts only roles and safe trimmed instance-key format", () => {
    expect(() => buildConsumerId("unknown" as "engine")).toThrow("Unknown");
    expect(() => buildConsumerId("remote-node", " node")).toThrow("trimmed");
    expect(() => buildConsumerId("remote-node", "node:1")).toThrow("safe");
    expect(() => buildConsumerId("remote-node", "")).toThrow("safe");
  });

  it("does not pretend to infer durability from a string", () => {
    // Durability is proven at the factory/runtime wiring site, not by pattern guessing here.
    expect(buildConsumerId("remote-node", "550e8400-e29b-41d4-a716-446655440000"))
      .toBe("remote-node:550e8400-e29b-41d4-a716-446655440000");
  });
});
