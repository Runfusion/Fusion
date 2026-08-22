import { describe, expect, it } from "vitest";
import { createPgTimeoutBoundaryObserver } from "../__test-utils__/pg-timeout-boundary-observer.js";

/*
FNXC:PgTimeoutBoundaryObserver 2026-08-19-13:51:
The harness must remain byte-for-byte inert unless the explicit observer switch
is set. This cluster-free guard exercises the factory contract used by harness
setup, paired body hooks, teardown wrapping, and its drain.
*/
describe("PG harness timeout-boundary observer inertness", () => {
  it("does not create observable work without its opt-in environment switch", async () => {
    let timers = 0;
    let probes = 0;
    let appends = 0;
    const observer = createPgTimeoutBoundaryObserver({
      env: {},
      setTimer: ((callback, timeout) => { timers += 1; return setTimeout(callback, timeout); }) as typeof setTimeout,
      probe: async () => { probes += 1; return { cluster: {}, template: {} }; },
      append: () => { appends += 1; },
    });
    const handle = observer.openBoundary("body", "shared.body", "inert");
    observer.closeBoundary(handle);
    await expect(observer.observeBoundary("setup", "store.init", async () => "transparent")).resolves.toBe("transparent");
    await observer.flush();
    await observer.dispose();
    expect(observer.enabled).toBe(false);
    expect(timers).toBe(0);
    expect(probes).toBe(0);
    expect(appends).toBe(0);
  });
});
