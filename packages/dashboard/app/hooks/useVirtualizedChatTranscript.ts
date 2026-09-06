import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefCallback, type RefObject } from "react";

export interface VirtualTranscriptRange {
  startIndex: number;
  endIndex: number;
  topSpacerHeight: number;
  bottomSpacerHeight: number;
  totalHeight: number;
}

interface VirtualTranscriptOptions {
  transcriptKey: string | null;
  keys: readonly string[];
  scrollRef: RefObject<HTMLElement | null>;
  estimateHeight?: number;
  overscanViewports?: number;
  maxRenderedRows?: number;
}

interface TranscriptAnchor {
  key: string;
  offset: number;
}

export interface VirtualizedChatTranscript extends VirtualTranscriptRange {
  visibleKeys: readonly string[];
  onScroll: () => void;
  measureRow: (key: string) => RefCallback<HTMLElement>;
  scrollToKey: (key: string, align?: "start" | "center" | "end") => void;
  scrollToBottom: () => void;
  captureAnchor: () => TranscriptAnchor | null;
  restoreAnchor: (anchor: TranscriptAnchor) => void;
}

const DEFAULT_ESTIMATE_HEIGHT = 112;
const DEFAULT_VIEWPORT_HEIGHT = 640;
const DEFAULT_OVERSCAN_VIEWPORTS = 1;
const DEFAULT_MAX_RENDERED_ROWS = 60;

function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((values[middle] ?? 0) < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function calculateVirtualTranscriptRange(args: {
  keys: readonly string[];
  measuredHeights?: ReadonlyMap<string, number>;
  estimateHeight?: number;
  viewportHeight?: number;
  scrollTop?: number;
  overscanViewports?: number;
  maxRenderedRows?: number;
}): VirtualTranscriptRange {
  const { keys } = args;
  if (keys.length === 0) return { startIndex: 0, endIndex: 0, topSpacerHeight: 0, bottomSpacerHeight: 0, totalHeight: 0 };
  const estimate = Math.max(1, args.estimateHeight ?? DEFAULT_ESTIMATE_HEIGHT);
  const viewportHeight = Math.max(1, args.viewportHeight || DEFAULT_VIEWPORT_HEIGHT);
  const offsets = new Array<number>(keys.length + 1);
  offsets[0] = 0;
  for (let index = 0; index < keys.length; index += 1) {
    offsets[index + 1] = (offsets[index] ?? 0) + Math.max(1, args.measuredHeights?.get(keys[index]!) ?? estimate);
  }
  const totalHeight = offsets[keys.length] ?? 0;
  const rawScrollTop = args.scrollTop ?? Number.POSITIVE_INFINITY;
  const scrollTop = Number.isFinite(rawScrollTop)
    ? Math.min(Math.max(0, rawScrollTop), Math.max(0, totalHeight - viewportHeight))
    : Math.max(0, totalHeight - viewportHeight);
  const overscan = viewportHeight * Math.max(0, args.overscanViewports ?? DEFAULT_OVERSCAN_VIEWPORTS);
  let startIndex = Math.max(0, lowerBound(offsets, Math.max(0, scrollTop - overscan)) - 1);
  let endIndex = Math.min(keys.length, lowerBound(offsets, scrollTop + viewportHeight + overscan));
  const maxRows = Math.max(1, args.maxRenderedRows ?? DEFAULT_MAX_RENDERED_ROWS);
  if (endIndex - startIndex > maxRows) {
    const visibleStart = Math.max(0, lowerBound(offsets, scrollTop) - 1);
    startIndex = Math.max(0, Math.min(visibleStart, keys.length - maxRows));
    endIndex = Math.min(keys.length, startIndex + maxRows);
  }
  if (endIndex <= startIndex) endIndex = Math.min(keys.length, startIndex + 1);
  return {
    startIndex,
    endIndex,
    topSpacerHeight: offsets[startIndex] ?? 0,
    bottomSpacerHeight: totalHeight - (offsets[endIndex] ?? totalHeight),
    totalHeight,
  };
}

/*
FNXC:ChatTranscriptVirtualization 2026-09-06-13:40:
Direct Chat and Planner Chat keep every loaded row in data but mount only the viewport window plus bounded overscan. Stable row keys retain variable-height measurements; transcript changes disconnect observers and discard measurements so late callbacks cannot contaminate another conversation, while deterministic estimates cover zero-size test viewports and browsers without ResizeObserver.
*/
export function useVirtualizedChatTranscript(options: VirtualTranscriptOptions): VirtualizedChatTranscript {
  const {
    transcriptKey,
    keys,
    scrollRef,
    estimateHeight = DEFAULT_ESTIMATE_HEIGHT,
    overscanViewports = DEFAULT_OVERSCAN_VIEWPORTS,
    maxRenderedRows = DEFAULT_MAX_RENDERED_ROWS,
  } = options;
  const measurementsRef = useRef(new Map<string, number>());
  const observerRef = useRef<ResizeObserver | null>(null);
  const elementKeysRef = useRef(new WeakMap<Element, string>());
  const elementsByKeyRef = useRef(new Map<string, Element>());
  const generationRef = useRef(0);
  const previousRef = useRef<{ transcriptKey: string | null; keys: readonly string[]; totalHeight: number }>({ transcriptKey, keys: [], totalHeight: 0 });
  const [geometry, setGeometry] = useState({ scrollTop: Number.POSITIVE_INFINITY, viewportHeight: DEFAULT_VIEWPORT_HEIGHT, revision: 0 });

  const range = useMemo(() => calculateVirtualTranscriptRange({
    keys,
    measuredHeights: measurementsRef.current,
    estimateHeight,
    viewportHeight: geometry.viewportHeight,
    scrollTop: geometry.scrollTop,
    overscanViewports,
    maxRenderedRows,
  }), [estimateHeight, geometry, keys, maxRenderedRows, overscanViewports]);

  const readGeometry = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    setGeometry((current) => ({
      ...current,
      scrollTop: container.scrollTop,
      viewportHeight: container.clientHeight || DEFAULT_VIEWPORT_HEIGHT,
    }));
  }, [scrollRef]);

  useLayoutEffect(() => {
    const previous = previousRef.current;
    const container = scrollRef.current;
    if (previous.transcriptKey !== transcriptKey) {
      generationRef.current += 1;
      observerRef.current?.disconnect();
      observerRef.current = null;
      measurementsRef.current.clear();
      previousRef.current = { transcriptKey, keys: [...keys], totalHeight: 0 };
      setGeometry({ scrollTop: Number.POSITIVE_INFINITY, viewportHeight: container?.clientHeight || DEFAULT_VIEWPORT_HEIGHT, revision: 0 });
      if (container) container.scrollTop = container.scrollHeight;
      return;
    }

    const prefixCount = keys.length - previous.keys.length;
    const isPrepend = prefixCount > 0 && previous.keys.every((key, index) => keys[index + prefixCount] === key);
    if (container && isPrepend && Number.isFinite(geometry.scrollTop)) {
      const addedHeight = keys.slice(0, prefixCount).reduce((sum, key) => sum + (measurementsRef.current.get(key) ?? estimateHeight), 0);
      container.scrollTop += addedHeight;
      setGeometry((current) => ({ ...current, scrollTop: current.scrollTop + addedHeight }));
    }
    previousRef.current = { transcriptKey, keys: [...keys], totalHeight: range.totalHeight };
  }, [estimateHeight, geometry.scrollTop, keys, range.totalHeight, scrollRef, transcriptKey]);

  useLayoutEffect(() => () => {
    generationRef.current += 1;
    observerRef.current?.disconnect();
    observerRef.current = null;
  }, []);

  const measureRow = useCallback((key: string): RefCallback<HTMLElement> => (element) => {
    if (!element) {
      const previous = elementsByKeyRef.current.get(key);
      if (previous) observerRef.current?.unobserve(previous);
      elementsByKeyRef.current.delete(key);
      return;
    }
    const generation = generationRef.current;
    elementsByKeyRef.current.set(key, element);
    elementKeysRef.current.set(element, key);
    const commitHeight = (height: number) => {
      if (generation !== generationRef.current || height <= 0 || measurementsRef.current.get(key) === height) return;
      measurementsRef.current.set(key, height);
      setGeometry((current) => ({ ...current, revision: current.revision + 1 }));
    };
    commitHeight(element.getBoundingClientRect().height);
    if (typeof ResizeObserver === "undefined") return;
    if (!observerRef.current) {
      observerRef.current = new ResizeObserver((entries) => {
        if (generation !== generationRef.current) return;
        for (const entry of entries) {
          const entryKey = elementKeysRef.current.get(entry.target);
          if (!entryKey) continue;
          const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
          if (height > 0 && measurementsRef.current.get(entryKey) !== height) {
            measurementsRef.current.set(entryKey, height);
            setGeometry((current) => ({ ...current, revision: current.revision + 1 }));
          }
        }
      });
    }
    observerRef.current.observe(element);
  }, []);

  const offsetForKey = useCallback((key: string) => {
    const index = keys.indexOf(key);
    if (index < 0) return null;
    let offset = 0;
    for (let cursor = 0; cursor < index; cursor += 1) offset += measurementsRef.current.get(keys[cursor]!) ?? estimateHeight;
    return { index, offset, height: measurementsRef.current.get(key) ?? estimateHeight };
  }, [estimateHeight, keys]);

  const scrollToKey = useCallback((key: string, align: "start" | "center" | "end" = "start") => {
    const container = scrollRef.current;
    const target = offsetForKey(key);
    if (!container || !target) return;
    const viewportHeight = container.clientHeight || DEFAULT_VIEWPORT_HEIGHT;
    const adjustment = align === "center" ? (viewportHeight - target.height) / 2 : align === "end" ? viewportHeight - target.height : 0;
    container.scrollTop = Math.max(0, target.offset - adjustment);
    readGeometry();
  }, [offsetForKey, readGeometry, scrollRef]);

  const scrollToBottom = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    container.scrollTop = Math.max(container.scrollHeight, range.totalHeight);
    readGeometry();
  }, [range.totalHeight, readGeometry, scrollRef]);

  const captureAnchor = useCallback((): TranscriptAnchor | null => {
    const first = keys[range.startIndex];
    return first ? { key: first, offset: geometry.scrollTop - range.topSpacerHeight } : null;
  }, [geometry.scrollTop, keys, range.startIndex, range.topSpacerHeight]);

  const restoreAnchor = useCallback((anchor: TranscriptAnchor) => {
    const target = offsetForKey(anchor.key);
    const container = scrollRef.current;
    if (!target || !container) return;
    container.scrollTop = Math.max(0, target.offset + anchor.offset);
    readGeometry();
  }, [offsetForKey, readGeometry, scrollRef]);

  return {
    ...range,
    visibleKeys: keys.slice(range.startIndex, range.endIndex),
    onScroll: readGeometry,
    measureRow,
    scrollToKey,
    scrollToBottom,
    captureAnchor,
    restoreAnchor,
  };
}
