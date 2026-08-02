import { describe, expect, it } from "vitest";
import { CredentialInstanceRotator } from "../credential-instance-rotation.js";

describe("credential rotator DI identity", () => {
  it("uses one rotator object for the pauser and lane option bags", () => {
    const rotator = new CredentialInstanceRotator({
      instanceSource: { listInstances: () => [], getDefaultInstance: () => undefined },
    });
    const pauserOptions = { credentialRotator: rotator };
    const executorOptions = { credentialRotator: rotator };
    const heartbeatOptions = { credentialRotator: rotator };
    expect(executorOptions.credentialRotator).toBe(pauserOptions.credentialRotator);
    expect(heartbeatOptions.credentialRotator).toBe(pauserOptions.credentialRotator);
  });
});
