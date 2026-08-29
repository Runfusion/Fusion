import { afterEach, describe, expect, it, vi } from "vitest";

import { copyTextToClipboard } from "../copyToClipboard";

describe("copyTextToClipboard", () => {
  const originalClipboard = navigator.clipboard;

  function mockExecCommand(result: boolean) {
    const execCommand = vi.fn().mockReturnValue(result);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
    return execCommand;
  }

  afterEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: originalClipboard,
    });
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("uses Clipboard API when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    await expect(copyTextToClipboard("abc123")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("abc123");
  });

  it("falls back to execCommand when Clipboard API is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    const execSpy = mockExecCommand(true);

    await expect(copyTextToClipboard("fallback")).resolves.toBe(true);
    expect(execSpy).toHaveBeenCalledWith("copy");
  });

  it("falls back to execCommand when Clipboard API rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const execSpy = mockExecCommand(false);

    await expect(copyTextToClipboard("reject-path")).resolves.toBe(false);
    expect(writeText).toHaveBeenCalledWith("reject-path");
    expect(execSpy).toHaveBeenCalledWith("copy");
  });

  it("returns false when both clipboard and fallback fail", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    mockExecCommand(false);

    await expect(copyTextToClipboard("nope")).resolves.toBe(false);
  });

  it("removes temporary textarea after fallback attempts", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });

    const execSpy = mockExecCommand(true);
    await copyTextToClipboard("cleanup-success");
    expect(execSpy).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();

    execSpy.mockReturnValueOnce(false);
    await copyTextToClipboard("cleanup-failure");
    expect(document.querySelector("textarea")).toBeNull();
  });
});
