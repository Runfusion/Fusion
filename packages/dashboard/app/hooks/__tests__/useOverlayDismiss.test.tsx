import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ModalDismissPreferenceProvider, useOverlayDismiss } from "../useOverlayDismiss";

function OverlayHarness({ onClose, enabled }: { onClose: () => void; enabled?: boolean }) {
  const props = useOverlayDismiss(onClose, enabled === undefined ? undefined : { enabled });
  return (
    <div data-testid="overlay" {...props}>
      <div data-testid="modal-content">content</div>
    </div>
  );
}

describe("useOverlayDismiss", () => {
  it("does not close on real overlay mouse down/up when the global setting is disabled by default", () => {
    const onClose = vi.fn();
    const { getByTestId } = render(<OverlayHarness onClose={onClose} />);
    const overlay = getByTestId("overlay");

    fireEvent.mouseDown(overlay);
    fireEvent.mouseUp(overlay);

    expect(onClose).toHaveBeenCalledTimes(0);
  });

  it("closes on real overlay mouse down/up when enabled", () => {
    const onClose = vi.fn();
    const { getByTestId } = render(<OverlayHarness onClose={onClose} enabled />);
    const overlay = getByTestId("overlay");

    fireEvent.mouseDown(overlay);
    fireEvent.mouseUp(overlay);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores compatibility mouse sequence immediately after touch", () => {
    const onClose = vi.fn();
    const { getByTestId } = render(<OverlayHarness onClose={onClose} enabled />);
    const overlay = getByTestId("overlay");

    fireEvent.touchStart(overlay);
    fireEvent.touchEnd(overlay);
    fireEvent.mouseDown(overlay);
    fireEvent.mouseUp(overlay);

    expect(onClose).toHaveBeenCalledTimes(0);
  });

  it("does not close when mouse starts inside modal and ends on overlay", () => {
    const onClose = vi.fn();
    const { getByTestId } = render(<OverlayHarness onClose={onClose} enabled />);
    const overlay = getByTestId("overlay");
    const modal = getByTestId("modal-content");

    fireEvent.mouseDown(modal);
    fireEvent.mouseUp(overlay);

    expect(onClose).toHaveBeenCalledTimes(0);
  });

  it("uses the modal dismiss preference provider when no per-call override is supplied", () => {
    const onClose = vi.fn();
    const { getByTestId } = render(
      <ModalDismissPreferenceProvider enabled>
        <OverlayHarness onClose={onClose} />
      </ModalDismissPreferenceProvider>,
    );
    const overlay = getByTestId("overlay");

    fireEvent.mouseDown(overlay);
    fireEvent.mouseUp(overlay);

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
