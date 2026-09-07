import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoPaginationSentinel } from "../useAutoPaginationSentinel";

let intersection: IntersectionObserverCallback | undefined;
const disconnect = vi.fn();
class Observer {
  constructor(callback: IntersectionObserverCallback, readonly options?: IntersectionObserverInit) { intersection = callback; }
  observe() {}
  unobserve() {}
  disconnect = disconnect;
}

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  intersection = undefined;
  disconnect.mockReset();
});

describe("useAutoPaginationSentinel", () => {
  it("uses the actual scroller and serializes intersections", async () => {
    vi.stubGlobal("IntersectionObserver", Observer);
    const root = document.createElement("div");
    const sentinel = document.createElement("div");
    const page = deferred();
    const load = vi.fn(() => page.promise);
    const { result } = renderHook(() => useAutoPaginationSentinel({ rootRef: { current: root }, hasMore: true, loading: false, onLoadMore: load }));
    act(() => result.current.sentinelRef(sentinel));
    act(() => intersection?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    act(() => intersection?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => page.resolve());
  });

  it("releases single-flight across the real loading lifecycle and loads a second page", async () => {
    vi.stubGlobal("IntersectionObserver", Observer);
    const root = document.createElement("div");
    const sentinel = document.createElement("div");
    const firstPage = deferred();
    const secondPage = deferred();
    const load = vi.fn()
      .mockImplementationOnce(() => firstPage.promise)
      .mockImplementationOnce(() => secondPage.promise);
    const { result, rerender } = renderHook(
      ({ loading }) => useAutoPaginationSentinel({ rootRef: { current: root }, hasMore: true, loading, onLoadMore: load }),
      { initialProps: { loading: false } },
    );
    act(() => result.current.sentinelRef(sentinel));

    act(() => intersection?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    rerender({ loading: true });
    rerender({ loading: false });
    await act(async () => firstPage.resolve());

    act(() => intersection?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(load).toHaveBeenCalledTimes(2);
    await act(async () => secondPage.resolve());
  });

  it("allows retry on a later crossing after an error and disconnects on unmount", async () => {
    vi.stubGlobal("IntersectionObserver", Observer);
    const root = document.createElement("div");
    const sentinel = document.createElement("div");
    const load = vi.fn().mockRejectedValueOnce(new Error("page failed")).mockResolvedValue(undefined);
    const { result, unmount } = renderHook(() => useAutoPaginationSentinel({ rootRef: { current: root }, hasMore: true, loading: false, onLoadMore: load }));
    act(() => result.current.sentinelRef(sentinel));
    await act(async () => { intersection?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver); await Promise.resolve(); });
    await act(async () => { intersection?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver); await Promise.resolve(); });
    expect(load).toHaveBeenCalledTimes(2);
    unmount();
    expect(disconnect).toHaveBeenCalled();
  });

  it("falls back to a scoped scroll listener without IntersectionObserver", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const root = document.createElement("div");
    Object.defineProperties(root, { clientHeight: { value: 100 }, scrollHeight: { value: 1_000 }, scrollTop: { writable: true, value: 860 } });
    const load = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useAutoPaginationSentinel({ rootRef: { current: root }, hasMore: true, loading: false, onLoadMore: load }));
    act(() => result.current.sentinelRef(document.createElement("div")));
    await act(async () => { root.dispatchEvent(new Event("scroll")); await Promise.resolve(); });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not load after end-of-data or after teardown", async () => {
    vi.stubGlobal("IntersectionObserver", Observer);
    const load = vi.fn();
    const root = document.createElement("div");
    const { result, unmount } = renderHook(() => useAutoPaginationSentinel({ rootRef: { current: root }, hasMore: false, loading: false, onLoadMore: load }));
    act(() => result.current.sentinelRef(document.createElement("div")));
    unmount();
    act(() => intersection?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(load).not.toHaveBeenCalled();
  });
});
