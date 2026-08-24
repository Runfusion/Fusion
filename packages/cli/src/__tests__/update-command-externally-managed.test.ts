import { afterEach, describe, expect, it, vi } from "vitest";
import { EXTERNALLY_MANAGED_UPDATE_MESSAGE } from "@fusion/core";
import { runUpdate } from "../commands/update.js";

const managedUpdatesEnv = "FUSION_UPDATES_EXTERNALLY_MANAGED";
const initialManagedUpdatesEnv = process.env[managedUpdatesEnv];

afterEach(() => {
  if (initialManagedUpdatesEnv === undefined) delete process.env[managedUpdatesEnv];
  else process.env[managedUpdatesEnv] = initialManagedUpdatesEnv;
  vi.unstubAllGlobals();
});

describe("fn update externally managed installs", () => {
  it("refuses before npm install when the deployment owns updates", async () => {
    process.env[managedUpdatesEnv] = "1";
    const installVersion = vi.fn();
    const writeError = vi.fn();
    const exit = vi.fn();

    await runUpdate({}, { installVersion, writeError, exit });

    expect(installVersion).not.toHaveBeenCalled();
    expect(writeError).toHaveBeenCalledWith(EXTERNALLY_MANAGED_UPDATE_MESSAGE);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("uses the normal install path when the deployment flag is unset", async () => {
    delete process.env[managedUpdatesEnv];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: async () => ({ "dist-tags": { latest: "9999.0.0" } }),
    }));
    const installVersion = vi.fn().mockResolvedValue(undefined);

    await runUpdate({}, { installVersion, writeError: vi.fn(), exit: vi.fn() });

    expect(installVersion).toHaveBeenCalledWith(true, "9999.0.0");
  });
});
