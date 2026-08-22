import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_DASHBOARD_PORT,
  getLocalDashboardPort,
  setLocalDashboardPort,
  resetLocalDashboardPortForTests,
} from "../local-dashboard-port.js";

/*
FNXC:RemoteAccess 2026-08-19-04:00:
Remote tunnels targeted a hardcoded http://localhost:4040, so a dashboard on any other port —
`--port`, a PORT override, or the EADDRINUSE rebind to an ephemeral port — published whatever ELSE
owned 4040 under a URL the operator believed was theirs. The identical mistake in `pnpm dev
--tunnel` published a container's own Fusion instead of the dev server.
*/
describe("local dashboard port", () => {
  beforeEach(() => {
    resetLocalDashboardPortForTests();
  });

  it("falls back to the historical default before anything reports", () => {
    expect(getLocalDashboardPort()).toBe(DEFAULT_DASHBOARD_PORT);
    expect(DEFAULT_DASHBOARD_PORT).toBe(4040);
  });

  it("returns the port the dashboard actually bound", () => {
    setLocalDashboardPort(51234);
    expect(getLocalDashboardPort()).toBe(51234);
  });

  it("ignores values that cannot be a bound port", () => {
    setLocalDashboardPort(4041);
    for (const bogus of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      setLocalDashboardPort(bogus);
      // A bad report must never erase a good one, or the tunnel silently reverts to 4040.
      expect(getLocalDashboardPort()).toBe(4041);
    }
  });

  it("takes the latest report, so a restart onto a new port is followed", () => {
    setLocalDashboardPort(4041);
    setLocalDashboardPort(51234);
    expect(getLocalDashboardPort()).toBe(51234);
  });
});
