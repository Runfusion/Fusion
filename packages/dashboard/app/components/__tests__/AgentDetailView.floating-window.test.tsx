import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

import { mockFetchAgent, setupAgentDetailMocks } from "./AgentDetailView.test-helpers";
import { ModalDismissPreferenceProvider } from "../../hooks/useOverlayDismiss";
import { AgentDetailView } from "../AgentDetailView";
import {
  assertModalGeometryRecoveryAndSheetContracts,
  assertRenderedModalTouchGeometry,
  expectFloatingWindowStructure,
} from "./floatingWindowMigration.test-helpers";

const renderModal = (onClose = vi.fn()) => render(
  <AgentDetailView agentId="agent-001" onClose={onClose} addToast={vi.fn()} />,
);

/**
 * FNXC:ModalTouchGeometry 2026-07-27-12:40:
 * FN-8619 keeps Agent Detail's deliberately narrower mouse-pair dismissal while moving geometry
 * to FloatingWindow. Exercise the production portal, rather than a synthetic window, so touch
 * gestures cannot silently become an outside-dismiss path.
 */
describe("AgentDetailView FloatingWindow migration", () => {
  beforeEach(() => {
    localStorage.clear();
    setupAgentDetailMocks();
  });
  afterEach(cleanup);

  it("hosts modal geometry in FloatingWindow while inline remains embedded", async () => {
    const { baseElement, unmount } = renderModal();
    await waitFor(() => expect(baseElement.querySelector(".agent-detail-header")).not.toBeNull());
    expectFloatingWindowStructure("agent-detail");
    expect(baseElement.querySelector(".modal-resize-grip")).toBeNull();
    unmount();

    const inline = render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} inline />);
    await waitFor(() => expect(inline.baseElement.querySelector(".agent-detail-inline-shell")).not.toBeNull());
    expect(inline.baseElement.querySelector("[data-testid='floating-window-agent-detail']")).toBeNull();
    expect(inline.baseElement.querySelector(".floating-window__resize-handle")).toBeNull();
  });

  it("supports touch drag, eight-direction resize, corrupt recovery, clamping, and sheet suspension", async () => {
    let rendered = renderModal();
    await waitFor(() => expect(rendered.baseElement.querySelector(".agent-detail-header")).not.toBeNull());
    assertRenderedModalTouchGeometry("agent-detail", rendered.baseElement.querySelector(".agent-detail-header")!);
    rendered.unmount();

    assertModalGeometryRecoveryAndSheetContracts("agent-detail", () => renderModal());
  });

  it("preserves paired mouse-only backdrop dismissal without pointer-down dismissal", async () => {
    const onClose = vi.fn();
    const { baseElement } = renderModal(onClose);
    await waitFor(() => expect(baseElement.querySelector(".agent-detail-header")).not.toBeNull());
    const overlay = baseElement.querySelector("[data-testid='floating-window-overlay-agent-detail']")!;
    const panel = baseElement.querySelector("[data-testid='floating-window-agent-detail']")!;

    fireEvent.mouseDown(overlay); fireEvent.mouseUp(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
    onClose.mockClear();

    fireEvent.mouseDown(overlay); fireEvent.mouseUp(panel);
    fireEvent.mouseDown(panel); fireEvent.mouseUp(overlay);
    fireEvent.mouseDown(overlay);
    fireEvent.pointerDown(overlay, { pointerType: "touch" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps paired mouse dismissal unconditional when preference is %s", async (enabled) => {
    const onClose = vi.fn();
    const { baseElement } = render(
      <ModalDismissPreferenceProvider enabled={enabled}>
        <AgentDetailView agentId="agent-001" onClose={onClose} addToast={vi.fn()} />
      </ModalDismissPreferenceProvider>,
    );
    await waitFor(() => expect(baseElement.querySelector(".agent-detail-header")).not.toBeNull());
    const overlay = baseElement.querySelector("[data-testid='floating-window-overlay-agent-detail']")!;
    fireEvent.mouseDown(overlay);
    fireEvent.mouseUp(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the loading branch in FloatingWindow with the same mouse-only dismissal", () => {
    mockFetchAgent.mockImplementation(() => new Promise(() => {}));
    const onClose = vi.fn();
    const { baseElement } = renderModal(onClose);
    const overlay = baseElement.querySelector("[data-testid='floating-window-overlay-agent-detail']")!;
    const panel = baseElement.querySelector("[data-testid='floating-window-agent-detail']")!;
    expect(panel).toHaveTextContent("Loading agent...");

    fireEvent.mouseDown(overlay);
    fireEvent.mouseUp(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
    onClose.mockClear();
    fireEvent.mouseDown(overlay);
    fireEvent.mouseUp(panel);
    fireEvent.pointerDown(overlay, { pointerType: "touch" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
