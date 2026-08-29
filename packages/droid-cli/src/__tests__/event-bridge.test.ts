import { describe, expect, it } from "vitest";
import { createEventBridge as shimCreateEventBridge } from "../event-bridge";
import { createEventBridge as pluginCreateEventBridge } from "../../../../plugins/fusion-plugin-droid-runtime/src/event-bridge.js";

describe("droid-cli event-bridge shim", () => {
  it("re-exports createEventBridge from the droid runtime plugin", () => {
    expect(shimCreateEventBridge).toBe(pluginCreateEventBridge);
  });
});
