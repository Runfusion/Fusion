import { afterEach, describe, expect, it, vi } from "vitest";

let output: typeof import("../output.js") | undefined;
let stdoutSpy: ReturnType<typeof vi.spyOn> | undefined;

async function loadOutput() {
  vi.resetModules();
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write);
  output = await import("../output.js");
  return output;
}

afterEach(() => {
  output?.resetQuietMode();
  output?.uninstallQuietGate();
  stdoutSpy?.mockRestore();
  output = undefined;
  stdoutSpy = undefined;
  vi.restoreAllMocks();
});

describe("CLI quiet output seam", () => {
  it("resolves presence-preserving flag and environment precedence", async () => {
    const seam = await loadOutput();
    expect(seam.resolveQuietMode({ flag: true })).toBe(true);
    expect(seam.resolveQuietMode({ flag: false, env: "true" })).toBe(false);
    expect(seam.resolveQuietMode({ env: "YES" })).toBe(true);
    expect(seam.resolveQuietMode({})).toBe(false);
  });

  it("suppresses gated chatter while preserving stderr, results, prompts, and write callbacks", async () => {
    const seam = await loadOutput();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as typeof process.stderr.write);
    const callback = vi.fn();
    seam.setQuietMode(true);
    seam.installQuietGate();
    console.log("chatter");
    console.info("chatter");
    expect(process.stdout.write("progress", callback)).toBe(true);
    console.error("error");
    process.stderr.write("stderr");
    seam.result("result");
    seam.promptOutputStream().write("question");
    expect(callback).toHaveBeenCalledOnce();
    expect(stdoutSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith("error");
    expect(stderrSpy).toHaveBeenCalledWith("stderr");
  });

  it("is idempotent and returns stdout to normal after disable", async () => {
    const seam = await loadOutput();
    seam.setQuietMode(true);
    seam.installQuietGate();
    const firstWrite = process.stdout.write;
    seam.installQuietGate();
    expect(process.stdout.write).toBe(firstWrite);
    seam.setQuietMode(false);
    console.log("visible");
    process.stdout.write("visible");
    expect(stdoutSpy).toHaveBeenCalledOnce();
  });
});
