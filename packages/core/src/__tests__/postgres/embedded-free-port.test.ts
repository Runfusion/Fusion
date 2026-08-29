import { describe, expect, it } from "vitest";
import type { Server } from "node:net";
import { findFreePort } from "../../postgres/embedded-lifecycle.js";

describe("findFreePort", () => {
  it("resolves to a positive ephemeral TCP port", async () => {
    await expect(findFreePort()).resolves.toSatisfy(
      (port: unknown) => typeof port === "number" && Number.isInteger(port) && port > 0,
    );
  });

  it("keeps the listener ref'd until the listen/close promise settles", async () => {
    let unrefCalls = 0;
    let closeCalls = 0;
    const fakeServer = {
      on: () => fakeServer,
      listen: (_port: number, _host: string, onListening: () => void) => {
        onListening();
        return fakeServer;
      },
      address: () => ({ address: "127.0.0.1", family: "IPv4", port: 43123 }),
      close: (callback?: () => void) => {
        closeCalls += 1;
        callback?.();
        return fakeServer;
      },
      unref: () => {
        unrefCalls += 1;
        return fakeServer;
      },
    };

    await expect(findFreePort(() => fakeServer as unknown as Server)).resolves.toBe(43123);
    expect(closeCalls).toBe(1);
    expect(unrefCalls).toBe(0);
  });
});
