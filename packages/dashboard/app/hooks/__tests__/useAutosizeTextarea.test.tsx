import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { clampTextareaHeight, useAutosizeTextarea } from "../useAutosizeTextarea";

describe("clampTextareaHeight", () => {
  it("returns min when scrollHeight is smaller", () => {
    expect(clampTextareaHeight(20, { min: 40, max: 320 })).toBe(40);
  });

  it("returns scrollHeight when within range", () => {
    expect(clampTextareaHeight(160, { min: 40, max: 320 })).toBe(160);
  });

  it("returns max when scrollHeight exceeds cap", () => {
    expect(clampTextareaHeight(640, { min: 40, max: 320 })).toBe(320);
  });
});

function AutosizeHarness() {
  const [value, setValue] = useState("");
  const { ref } = useAutosizeTextarea({ value, minHeight: 40, maxHeight: 120 });

  return (
    <>
      <textarea data-testid="autosize-textarea" ref={ref} value={value} onChange={(event) => setValue(event.target.value)} />
      <button type="button" onClick={() => setValue("line 1\nline 2\nline 3")}>grow</button>
    </>
  );
}

describe("useAutosizeTextarea", () => {
  it("sets style.height when value changes", async () => {
    render(<AutosizeHarness />);

    const textarea = screen.getByTestId("autosize-textarea") as HTMLTextAreaElement;
    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      get: () => (textarea.value.includes("\n") ? 160 : 24),
    });

    await userEvent.click(screen.getByRole("button", { name: "grow" }));
    await waitFor(() => {
      expect(textarea.style.height).toBe("120px");
    });
  });

  it("tolerates ref unmount", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { unmount } = render(<AutosizeHarness />);
    expect(() => unmount()).not.toThrow();
    spy.mockRestore();
  });
});
