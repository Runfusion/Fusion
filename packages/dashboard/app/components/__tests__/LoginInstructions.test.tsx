import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LoginInstructions } from "../LoginInstructions";

describe("LoginInstructions", () => {
  let writeTextMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText: writeTextMock },
      configurable: true,
    });
  });

  it("renders plain instructions without a device code", () => {
    render(<LoginInstructions instructions="Open in browser and continue." data-testid="instructions" />);

    const instructions = screen.getByTestId("instructions");
    expect(instructions).toHaveClass("auth-login-instructions");
    expect(instructions).toHaveTextContent("Open in browser and continue.");
    expect(screen.queryByRole("button", { name: /copy/i })).not.toBeInTheDocument();
    expect(instructions.querySelector("code")).toBeNull();
  });

  it("extracts and highlights device code with copy button", () => {
    render(<LoginInstructions instructions="Enter device code GH-2469 on github.com/login/device." />);

    expect(screen.getByText("GH-2469")).toBeInTheDocument();
    expect(screen.getByText("GH-2469").tagName.toLowerCase()).toBe("code");
    expect(screen.getByRole("button", { name: /copy device code/i })).toBeInTheDocument();
  });

  it("copy button copies the device code and updates button state", async () => {
    render(<LoginInstructions instructions="Enter device code GH-2469 on github.com/login/device." />);

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith("GH-2469");
    });
    writeTextMock.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /cop(y|ied)/i }));

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith("GH-2469");
      expect(screen.getByRole("button", { name: "Copied to clipboard" })).toBeInTheDocument();
    });
  });

  it("auto-copies the device code on appearance", async () => {
    render(<LoginInstructions instructions="To authenticate, visit https://github.com/login/device and enter code: ABCD-1234" />);

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith("ABCD-1234");
    });
  });

  it("does not auto-copy when no device code exists", async () => {
    render(<LoginInstructions instructions="Open in browser" />);

    await waitFor(() => {
      expect(writeTextMock).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["Enter device code ABCD-EFGH at github.com/login/device", "ABCD-EFGH"],
    ["Your code: XXXX-1234", "XXXX-1234"],
    ["Code: ABC123-XY at https://github.com/login/device", "ABC123-XY"],
    ["Open in browser", null],
  ])("matches expected device code format for '%s'", async (instructions, expectedCode) => {
    render(<LoginInstructions instructions={instructions} />);

    if (expectedCode) {
      expect(screen.getByText(expectedCode)).toBeInTheDocument();
      await waitFor(() => {
        expect(writeTextMock).toHaveBeenCalledWith(expectedCode);
      });
      return;
    }

    expect(screen.queryByRole("button", { name: /copy/i })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(writeTextMock).not.toHaveBeenCalled();
    });
  });
});
