import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { MicButton } from "../MicButton";

const props = { enabled: true, supported: true, state: "idle" as const, start: vi.fn(), stop: vi.fn() };

describe("MicButton", () => {
  it("renders no shell until voice is enabled and confirmed available", () => {
    const { rerender } = render(<MicButton {...props} enabled={false} />);
    expect(document.querySelector(".btn-icon")).toBeNull();
    expect(screen.queryByLabelText(/voice dictation/i)).toBeNull();
    rerender(<MicButton {...props} supported={false} />);
    expect(document.querySelector(".btn-icon")).toBeNull();
  });

  it("announces and toggles recording", async () => {
    const user = userEvent.setup();
    const start = vi.fn();
    const stop = vi.fn();
    const { rerender } = render(<MicButton {...props} start={start} stop={stop} />);
    await user.click(screen.getByRole("button", { name: "Start voice dictation" }));
    expect(start).toHaveBeenCalledOnce();
    rerender(<MicButton {...props} state="listening" start={start} stop={stop} />);
    await user.click(screen.getByRole("button", { name: "Stop voice dictation" }));
    expect(stop).toHaveBeenCalledOnce();
  });
});
