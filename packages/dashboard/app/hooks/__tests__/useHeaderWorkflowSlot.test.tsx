import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HEADER_WORKFLOW_SLOT_ID, useHeaderWorkflowSlot } from "../useHeaderWorkflowSlot";

/*
FNXC:WorkflowControls 2026-09-15-01:44:
FN-405 regression coverage for the shared header workflow slot resolver. The defect this guards is a
slot that mounts AFTER the consuming view (or is replaced on a breakpoint swap): the old per-consumer
resolution resolved once and never retried, so Board/List permanently fell back to the inline toolbar
rendered under the header.
*/

let observed: HTMLElement | null = null;
let renderCount = 0;

function Consumer({ enabled }: { enabled: boolean }) {
  observed = useHeaderWorkflowSlot({ enabled });
  renderCount += 1;
  return null;
}

function mountSlot(className = "header-workflow-slot"): HTMLElement {
  const slot = document.createElement("div");
  slot.id = HEADER_WORKFLOW_SLOT_ID;
  slot.className = className;
  document.body.appendChild(slot);
  return slot;
}

/** Lets the MutationObserver microtask deliver its records inside React's act scope. */
async function flushObserver(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  observed = null;
  renderCount = 0;
  document.body.innerHTML = "";
});

afterEach(() => {
  // Unmount before clearing the body: otherwise the observer sees the teardown removal and publishes
  // a state update outside React's act scope.
  cleanup();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("useHeaderWorkflowSlot", () => {
  it("returns an already-mounted slot on the first render", () => {
    const slot = mountSlot();
    render(<Consumer enabled />);
    expect(observed).toBe(slot);
  });

  it("returns a slot inserted after mount without any forced consumer re-render", async () => {
    render(<Consumer enabled />);
    expect(observed).toBeNull();

    const slot = mountSlot();
    await flushObserver();

    expect(observed).toBe(slot);
  });

  it("re-resolves when the slot is replaced by another node with the same id", async () => {
    const mobileSlot = mountSlot("header-workflow-slot header-workflow-slot--mobile");
    render(<Consumer enabled />);
    expect(observed).toBe(mobileSlot);

    const desktopSlot = document.createElement("div");
    desktopSlot.id = HEADER_WORKFLOW_SLOT_ID;
    desktopSlot.className = "header-workflow-slot";
    mobileSlot.remove();
    document.body.appendChild(desktopSlot);
    await flushObserver();

    expect(observed).toBe(desktopSlot);
    expect(observed).not.toBe(mobileSlot);
    expect(observed?.isConnected).toBe(true);
  });

  it("drops a cached slot once it is removed from the document", async () => {
    const slot = mountSlot();
    render(<Consumer enabled />);
    expect(observed).toBe(slot);

    slot.remove();
    await flushObserver();

    expect(observed).toBeNull();
  });

  it("resolves nothing and schedules no timer when disabled", () => {
    vi.useFakeTimers();
    mountSlot();
    render(<Consumer enabled={false} />);

    expect(observed).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops retrying and stays null when the slot never appears", () => {
    vi.useFakeTimers();
    render(<Consumer enabled />);
    expect(observed).toBeNull();

    act(() => {
      vi.advanceTimersByTime(250 * 25);
    });

    expect(observed).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears its retry timer on unmount", () => {
    vi.useFakeTimers();
    const view = render(<Consumer enabled />);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    view.unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not re-render the consumer while the resolved node identity is unchanged", async () => {
    mountSlot();
    render(<Consumer enabled />);
    const rendersAfterResolve = renderCount;

    document.body.appendChild(document.createElement("span"));
    await flushObserver();

    expect(renderCount).toBe(rendersAfterResolve);
  });
});
