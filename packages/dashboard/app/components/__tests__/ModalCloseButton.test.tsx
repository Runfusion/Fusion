import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModalCloseButton } from "../ModalCloseButton";
import { FloatingWindow } from "../FloatingWindow";

/*
FNXC:ModalChromeTests 2026-09-11-23:35:
The canonical close control is proven through its native contract and the real FloatingWindow host so modal migrations cannot duplicate chrome or lose accessibility and guard semantics.
*/
describe("ModalCloseButton", () => {
  it("forwards native close-button behavior and renders a decorative icon", () => {
    const onClick = vi.fn();
    const ref = createRef<HTMLButtonElement>();
    render(<ModalCloseButton ref={ref} aria-label="Close notes" title="Close notes" className="host-close" data-testid="close" onClick={onClick} />);

    const button = screen.getByTestId("close");
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveClass("modal-close", "btn", "btn-icon", "host-close");
    expect(button).toHaveAccessibleName("Close notes");
    expect(button).toHaveAttribute("title", "Close notes");
    expect(button.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    ref.current?.focus();
    expect(button).toHaveFocus();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("preserves disabled semantics", () => {
    const onClick = vi.fn();
    render(<ModalCloseButton aria-label="Close" disabled onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("renders exactly one close control in the native FloatingWindow header", () => {
    render(<FloatingWindow title="Utility" onClose={vi.fn()} windowKey="utility"><p>Body</p></FloatingWindow>);
    expect(screen.getAllByTestId("floating-window-close-utility")).toHaveLength(1);
    expect(screen.getByTestId("floating-window-close-utility")).toHaveClass("modal-close");
  });
});
