import { act, renderHook, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSelectionComment } from "../useSelectionComment";

function mockRangeRect() {
  const rect = new DOMRect(10, 20, 80, 12);
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: vi.fn(() => rect),
  });
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: vi.fn(() => ({ 0: rect, length: 1, item: () => rect, [Symbol.iterator]: function* () { yield rect; } }) as DOMRectList),
  });
}

function selectText(node: Node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

describe("useSelectionComment", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    mockRangeRect();
  });

  it("reports selected text and anchor rect inside the container", async () => {
    const container = document.createElement("div");
    const text = document.createTextNode("selected snippet");
    container.append(text);
    document.body.append(container);
    const ref = createRef<HTMLElement>();
    ref.current = container;

    const { result } = renderHook(() => useSelectionComment(ref));

    act(() => selectText(text));

    await waitFor(() => expect(result.current?.selectedText).toBe("selected snippet"));
    expect(result.current?.anchorRect.left).toBe(10);
  });

  it("clears selection state when the selection is outside the container", async () => {
    const container = document.createElement("div");
    container.textContent = "inside";
    const outside = document.createElement("div");
    outside.textContent = "outside";
    document.body.append(container, outside);
    const ref = createRef<HTMLElement>();
    ref.current = container;

    const { result } = renderHook(() => useSelectionComment(ref));

    act(() => selectText(outside.firstChild as Node));

    await waitFor(() => expect(result.current).toBeNull());
  });

  it("clears selection state when the selection is collapsed", async () => {
    const container = document.createElement("div");
    const text = document.createTextNode("selected snippet");
    container.append(text);
    document.body.append(container);
    const ref = createRef<HTMLElement>();
    ref.current = container;

    const { result } = renderHook(() => useSelectionComment(ref));
    act(() => selectText(text));
    await waitFor(() => expect(result.current?.selectedText).toBe("selected snippet"));

    act(() => {
      const selection = document.getSelection();
      selection?.collapse(text, 0);
      document.dispatchEvent(new Event("selectionchange"));
    });

    await waitFor(() => expect(result.current).toBeNull());
  });

  it("keeps the existing selection state while locked", async () => {
    const container = document.createElement("div");
    const text = document.createTextNode("selected snippet");
    container.append(text);
    document.body.append(container);
    const ref = createRef<HTMLElement>();
    ref.current = container;

    let locked = false;
    const { result, rerender } = renderHook(() => useSelectionComment(ref, { locked }));
    act(() => selectText(text));
    await waitFor(() => expect(result.current?.selectedText).toBe("selected snippet"));

    locked = true;
    rerender();
    act(() => {
      const selection = document.getSelection();
      selection?.collapse(text, 0);
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(result.current?.selectedText).toBe("selected snippet");
  });

  it("propagates a line range from the optional mapper", async () => {
    const container = document.createElement("div");
    const text = document.createTextNode("selected snippet");
    container.append(text);
    document.body.append(container);
    const ref = createRef<HTMLElement>();
    ref.current = container;

    const { result } = renderHook(() => useSelectionComment(ref, { getLineRange: () => ({ start: 2, end: 5 }) }));

    act(() => selectText(text));

    await waitFor(() => expect(result.current?.lineRange).toEqual({ start: 2, end: 5 }));
  });

  it("ignores whitespace-only selections", async () => {
    const container = document.createElement("div");
    const text = document.createTextNode("   ");
    container.append(text);
    document.body.append(container);
    const ref = createRef<HTMLElement>();
    ref.current = container;

    const { result } = renderHook(() => useSelectionComment(ref));

    act(() => selectText(text));

    await waitFor(() => expect(result.current).toBeNull());
  });
});
