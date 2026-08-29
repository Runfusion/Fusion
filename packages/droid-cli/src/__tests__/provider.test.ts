import { describe, expect, it } from "vitest";
import { streamViaCli as shimStreamViaCli } from "../provider";
import { streamViaCli as pluginStreamViaCli } from "../../../../plugins/fusion-plugin-droid-runtime/src/provider.js";

describe("droid-cli provider shim", () => {
  it("re-exports streamViaCli from the droid runtime plugin", () => {
    expect(shimStreamViaCli).toBe(pluginStreamViaCli);
  });
});
