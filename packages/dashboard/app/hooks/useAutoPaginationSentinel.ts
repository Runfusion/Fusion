import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export interface AutoPaginationOptions {
  rootRef: RefObject<HTMLElement | null>;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => Promise<unknown> | unknown;
  direction?: "start" | "end";
  rootMargin?: string;
  enabled?: boolean;
  /** Changes only after the owner accepts a page/continuation. Enables one post-commit edge recheck. */
  progressKey?: string | number;
  /** Stable list incarnation; changing it cancels deferred checks and resets progress baselines. */
  collectionKey?: string;
}

const DEFAULT_ROOT_MARGIN = "50% 0%";
const FALLBACK_EDGE_RATIO = 0.5;

/*
FNXC:AutomaticListPagination 2026-09-07-16:03:
Potentially unbounded dashboard lists request one page when their sentinel approaches the edge of their own scroll container. The request is single-flight, end-of-data and teardown are hard fences, and browsers without IntersectionObserver use the same edge policy through a scoped scroll listener rather than silently loading every page on mount.
*/
export function useAutoPaginationSentinel({
  rootRef,
  hasMore,
  loading,
  onLoadMore,
  direction = "end",
  rootMargin = DEFAULT_ROOT_MARGIN,
  enabled = true,
  progressKey,
  collectionKey = "default",
}: AutoPaginationOptions) {
  const [sentinel, setSentinel] = useState<HTMLElement | null>(null);
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const observerGenerationRef = useRef(0);
  const loadRef = useRef(onLoadMore);
  const eligibilityRef = useRef({ enabled, hasMore, loading });
  const intersectsRef = useRef(false);
  const progressRef = useRef<{ collectionKey: string; value: string | number | undefined }>({ collectionKey, value: progressKey });
  const deferredCheckGenerationRef = useRef(0);
  loadRef.current = onLoadMore;
  eligibilityRef.current = { enabled, hasMore, loading };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /*
  FNXC:AutomaticListPagination 2026-09-07-17:38:
  A normal page request changes loading false → true → false and may rebuild the observer, but it must not invalidate the request's single-flight release. Observer generations fence stale intersection callbacks only; component lifetime separately prevents work after unmount.
  */
  const requestNextPage = useCallback(async () => {
    const eligibility = eligibilityRef.current;
    if (!mountedRef.current || !eligibility.enabled || !eligibility.hasMore || eligibility.loading || inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      await loadRef.current();
    } catch {
      // The owning hook renders the page error; pagination remains eligible on a later crossing.
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  const setSentinelRef = useCallback((element: HTMLElement | null) => {
    setSentinel(element);
  }, []);

  useEffect(() => {
    observerGenerationRef.current += 1;
    const generation = observerGenerationRef.current;
    const root = rootRef.current;
    if (!enabled || !hasMore || !root || !sentinel) return;

    if (typeof IntersectionObserver !== "undefined") {
      const observer = new IntersectionObserver((entries) => {
        if (!mountedRef.current || generation !== observerGenerationRef.current) return;
        intersectsRef.current = entries.some((entry) => entry.isIntersecting);
        if (intersectsRef.current) void requestNextPage();
      }, { root, rootMargin });
      observer.observe(sentinel);
      return () => {
        observerGenerationRef.current += 1;
        intersectsRef.current = false;
        observer.disconnect();
      };
    }

    const handleScroll = () => {
      if (!mountedRef.current || generation !== observerGenerationRef.current) return;
      const threshold = root.clientHeight * FALLBACK_EDGE_RATIO;
      const nearEdge = direction === "start"
        ? root.scrollTop <= threshold
        : root.scrollHeight - root.scrollTop - root.clientHeight <= threshold;
      if (nearEdge) void requestNextPage();
    };
    root.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      observerGenerationRef.current += 1;
      root.removeEventListener("scroll", handleScroll);
    };
  }, [direction, enabled, hasMore, requestNextPage, rootMargin, rootRef, sentinel]);

  /*
  FNXC:AutomaticListPagination 2026-09-09-00:33:
  Task lists may accept a page while the same sentinel remains inside the preload zone. An optional owner progress key schedules exactly one post-commit edge check; unchanged keys, errors/disabled hosts, teardown, and stale collection incarnations cannot drain pages.
  */
  useEffect(() => {
    const previous = progressRef.current;
    deferredCheckGenerationRef.current += 1;
    const generation = deferredCheckGenerationRef.current;
    if (previous.collectionKey !== collectionKey) {
      progressRef.current = { collectionKey, value: progressKey };
      return;
    }
    if (progressKey === undefined || previous.value === progressKey) return;
    // A progress render may commit before the owner's loading=false release. Preserve the old
    // baseline so that release render performs the one allowed post-commit check.
    if (loading) return;
    progressRef.current = { collectionKey, value: progressKey };

    const root = rootRef.current;
    if (!root || !sentinel || !enabled || !hasMore) return;
    const check = () => {
      if (!mountedRef.current || generation !== deferredCheckGenerationRef.current) return;
      const threshold = root.clientHeight * FALLBACK_EDGE_RATIO;
      const geometricallyNear = direction === "start"
        ? root.scrollTop <= threshold
        : root.scrollHeight - root.scrollTop - root.clientHeight <= threshold;
      if (intersectsRef.current || geometricallyNear) void requestNextPage();
    };
    const usesAnimationFrame = typeof requestAnimationFrame === "function";
    const frame = usesAnimationFrame ? requestAnimationFrame(check) : window.setTimeout(check, 0);
    return () => {
      deferredCheckGenerationRef.current += 1;
      if (usesAnimationFrame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
      else window.clearTimeout(frame);
    };
  }, [collectionKey, direction, enabled, hasMore, loading, progressKey, requestNextPage, rootRef, sentinel]);

  return { sentinelRef: setSentinelRef, requestNextPage };
}
