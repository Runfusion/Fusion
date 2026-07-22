import { describe, it, expect } from "vitest";
import {
  detectFnBinary,
  FN_INSTALL_CURL,
  FN_INSTALL_NPM,
  FN_NPM_PACKAGE,
  FN_NPX_INVOCATION,
} from "../cli/fn-binary.js";

describe("fn-binary constants", () => {
  it("uses runfusion.ai as the canonical npm package", () => {
    expect(FN_NPM_PACKAGE).toBe("runfusion.ai");
    expect(FN_INSTALL_NPM).toBe("npm install -g runfusion.ai");
    expect(FN_NPX_INVOCATION).toBe("npx -y runfusion.ai");
  });

  it("exposes the curl one-line installer", () => {
    expect(FN_INSTALL_CURL).toBe("curl -fsSL https://runfusion.ai/install.sh | sh");
  });
});

describe("detectFnBinary", () => {
  it("never throws and always returns a usable invocation", async () => {
    // We don't assert installed/missing — the host running CI may or may not
    // have `fn` on PATH. The contract is: result is well-formed and
    // `invocation` is a string the caller can prepend to a command.
    const result = await detectFnBinary();
    expect(typeof result.installed).toBe("boolean");
    expect(typeof result.invocation).toBe("string");
    expect(result.invocation.length).toBeGreaterThan(0);
    if (!result.installed) {
      expect(result.invocation).toBe(FN_NPX_INVOCATION);
    } else {
      expect(["fn", "fusion"]).toContain(result.binary);
    }
  });
});
