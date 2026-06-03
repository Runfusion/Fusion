import { describe, it, expect } from "vitest";
import * as acp from "@agentclientprotocol/sdk";

// U1 gating verification (KTD2): the integration is built on a day-old SDK.
// These assertions fail the build if a load-bearing export is missing or
// reshaped, surfacing a breaking change at U1 rather than deep in U2.
describe("@agentclientprotocol/sdk export surface", () => {
  it("exposes ClientSideConnection as a constructable", () => {
    expect(typeof acp.ClientSideConnection).toBe("function");
  });

  it("exposes ndJsonStream as a function", () => {
    expect(typeof acp.ndJsonStream).toBe("function");
  });

  it("exposes PROTOCOL_VERSION as the integer 1", () => {
    expect(typeof acp.PROTOCOL_VERSION).toBe("number");
    expect(acp.PROTOCOL_VERSION).toBe(1);
  });

  it("exposes the client/agent method maps used for routing", () => {
    expect(acp.CLIENT_METHODS).toBeDefined();
    expect(acp.AGENT_METHODS).toBeDefined();
  });
});
