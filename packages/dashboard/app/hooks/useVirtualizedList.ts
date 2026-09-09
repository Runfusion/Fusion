import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefCallback, type RefObject } from "react";

export interface VirtualListRange {
  startIndex: number;
  endIndex: number;
  topSpacerHeight: number;
  bottomSpacerHeight: number;
  totalHeight: number;
}

interface VirtualListOptions {
  collectionKey: string | null;
  keys: readonly string[];
  scrollRef: RefObject<HTMLElement | null>;
  estimateHeight?: number;
  overscanViewports?: number;
  maxRenderedRows?: number;
  initialAlign?: "start" | "end";
  preservePrependAnchor?: boolean;
}

interface VirtualListAnchor {
  key: string;
  offset: number;
}

export interface VirtualizedList extends VirtualListRange {
  visibleKeys: readonly string[];
  onScroll: () => void;
  measureRow: (key: string) => RefCallback<HTMLElement>;
  scrollToKey: (key: string, align?: "start" | "center" | "end") => void;
  scrollToBottom: () => void;
  cancelPendingScrollToBottom: () => void;
  captureAnchor: () => VirtualListAnchor | null;
  restoreAnchor: (anchor: VirtualListAnchor) => void;
}

const DEFAULT_LIST_ESTIMATE_HEIGHT = 112;
const DEFAULT_LIST_VIEWPORT_HEIGHT = 640;
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

export function calculateVirtualListRange(args: {
  keys: readonly string[];
  measuredHeights?: ReadonlyMap<string, number>;
  estimateHeight?: number;
  viewportHeight?: number;
  scrollTop?: number;
  overscanViewports?: number;
  maxRenderedRows?: number;
}): VirtualListRange {
  const { keys } = args;
  if (keys.length === 0) return { startIndex: 0, endIndex: 0, topSpacerHeight: 0, bottomSpacerHeight: 0, totalHeight: 0 };
  const estimate = Math.max(1, args.estimateHeight ?? DEFAULT_LIST_ESTIMATE_HEIGHT);
  const viewportHeight = Math.max(1, args.viewportHeight || DEFAULT_LIST_VIEWPORT_HEIGHT);
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
FNXC:ListVirtualization 2026-09-06-13:40:
Dynamic dashboard lists keep every loaded row in data but mount only the viewport window plus bounded overscan. Stable row keys retain variable-height measurements; collection changes disconnect observers and discard measurements so late callbacks cannot contaminate another collection, while deterministic estimates cover zero-size test viewports and browsers without ResizeObserver.
*/
export function useVirtualizedList(options: VirtualListOptions): VirtualizedList {
  const {
    collectionKey,
    keys,
    scrollRef,
    estimateHeight = DEFAULT_LIST_ESTIMATE_HEIGHT,
    overscanViewports = DEFAULT_OVERSCAN_VIEWPORTS,
    maxRenderedRows = DEFAULT_MAX_RENDERED_ROWS,
    initialAlign = "end",
    preservePrependAnchor = true,
  } = options;
  const measurementsRef = useRef(new Map<string, number>());
  const observerRef = useRef<ResizeObserver | null>(null);
  const observerGenerationRef = useRef(-1);
  const elementKeysRef = useRef(new WeakMap<Element, { key: string; generation: number }>());
  const elementsByKeyRef = useRef(new Map<string, Element>());
  const rowCallbacksRef = useRef(new Map<string, RefCallback<HTMLElement>>());
  const pendingMeasurementsRef = useRef(new Map<string, number>());
  const measurementFlushRef = useRef<{ queued: boolean; token: number }>({ queued: false, token: 0 });
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const totalHeightRef = useRef(0);
  const collectionKeyRef = useRef(collectionKey);
  const pendingBottomAlignmentRef = useRef<string | null | undefined>(undefined);
  const previousRef = useRef<{ collectionKey: string | null; keys: readonly string[]; totalHeight: number }>({ collectionKey, keys: [], totalHeight: 0 });
  const [geometry, setGeometry] = useState({ scrollTop: initialAlign === "start" ? 0 : Number.POSITIVE_INFINITY, viewportHeight: DEFAULT_LIST_VIEWPORT_HEIGHT, revision: 0 });

  /*
  FNXC:ListVirtualization 2026-09-08-20:54:
  Row callback refs stay stable for a collection so React does not detach and reattach every visible row after each geometry render. Measurements publish through one generation-fenced microtask batch; unchanged heights are no-ops, and a collection switch or unmount invalidates queued work before it can update another list.

  FNXC:ListVirtualization 2026-09-08-21:16:
  React StrictMode replays layout effects without remounting row elements. Effect setup must therefore restore the live observer and remeasure registered elements, while cleanup cancels queued publication and observer-instance checks reject callbacks from the disconnected replay instance.
  */
  if (collectionKeyRef.current !== collectionKey) {
    collectionKeyRef.current = collectionKey;
    generationRef.current += 1;
    measurementsRef.current.clear();
    elementsByKeyRef.current.clear();
    elementKeysRef.current = new WeakMap();
    rowCallbacksRef.current.clear();
    pendingMeasurementsRef.current.clear();
    measurementFlushRef.current = { queued: false, token: measurementFlushRef.current.token + 1 };
  }

  const range = useMemo(() => calculateVirtualListRange({
    keys,
    measuredHeights: measurementsRef.current,
    estimateHeight,
    viewportHeight: geometry.viewportHeight,
    scrollTop: geometry.scrollTop,
    overscanViewports,
    maxRenderedRows,
  }), [estimateHeight, geometry, keys, maxRenderedRows, overscanViewports]);
  totalHeightRef.current = range.totalHeight;

  const readGeometry = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const scrollTop = container.scrollTop;
    const viewportHeight = container.clientHeight || DEFAULT_LIST_VIEWPORT_HEIGHT;
    setGeometry((current) => current.scrollTop === scrollTop && current.viewportHeight === viewportHeight
      ? current
      : { ...current, scrollTop, viewportHeight });
  }, [scrollRef]);

  useLayoutEffect(() => {
    const previous = previousRef.current;
    const container = scrollRef.current;
    if (previous.collectionKey !== collectionKey) {
      if (observerGenerationRef.current !== generationRef.current) {
        observerRef.current?.disconnect();
        observerRef.current = null;
        observerGenerationRef.current = -1;
      }
      if (pendingBottomAlignmentRef.current !== collectionKey) pendingBottomAlignmentRef.current = undefined;
      previousRef.current = { collectionKey, keys: [...keys], totalHeight: 0 };
      const scrollTop = initialAlign === "start" ? 0 : Number.POSITIVE_INFINITY;
      setGeometry({ scrollTop, viewportHeight: container?.clientHeight || DEFAULT_LIST_VIEWPORT_HEIGHT, revision: 0 });
      if (container) container.scrollTop = initialAlign === "start" ? 0 : container.scrollHeight;
      return;
    }

    const prefixCount = keys.length - previous.keys.length;
    const isPrepend = prefixCount > 0 && previous.keys.every((key, index) => keys[index + prefixCount] === key);
    if (container && preservePrependAnchor && isPrepend && Number.isFinite(geometry.scrollTop)) {
      const addedHeight = keys.slice(0, prefixCount).reduce((sum, key) => sum + (measurementsRef.current.get(key) ?? estimateHeight), 0);
      container.scrollTop += addedHeight;
      setGeometry((current) => ({ ...current, scrollTop: current.scrollTop + addedHeight }));
    }
    previousRef.current = { collectionKey, keys: [...keys], totalHeight: range.totalHeight };
  }, [estimateHeight, geometry.scrollTop, initialAlign, keys, preservePrependAnchor, range.totalHeight, scrollRef, collectionKey]);

  const publishMeasurement = useCallback((key: string, height: number, generation: number) => {
    if (generation !== generationRef.current || height <= 0 || measurementsRef.current.get(key) === height) return;
    pendingMeasurementsRef.current.set(key, height);
    if (measurementFlushRef.current.queued) return;
    const token = measurementFlushRef.current.token;
    measurementFlushRef.current.queued = true;
    queueMicrotask(() => {
      if (!mountedRef.current || generation !== generationRef.current || token !== measurementFlushRef.current.token) return;
      measurementFlushRef.current.queued = false;
      let changed = false;
      for (const [pendingKey, pendingHeight] of pendingMeasurementsRef.current) {
        if (measurementsRef.current.get(pendingKey) === pendingHeight) continue;
        measurementsRef.current.set(pendingKey, pendingHeight);
        changed = true;
      }
      pendingMeasurementsRef.current.clear();
      if (changed) setGeometry((current) => ({ ...current, revision: current.revision + 1 }));
    });
  }, []);

  const ensureObserver = useCallback((generation: number): ResizeObserver | null => {
    if (!mountedRef.current || typeof ResizeObserver === "undefined") return null;
    if (observerRef.current && observerGenerationRef.current === generation) return observerRef.current;
    observerRef.current?.disconnect();
    const observer = new ResizeObserver((entries) => {
      if (!mountedRef.current || observerRef.current !== observer) return;
      for (const entry of entries) {
        const registration = elementKeysRef.current.get(entry.target);
        if (!registration || registration.generation !== generationRef.current) continue;
        const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
        publishMeasurement(registration.key, height, registration.generation);
      }
    });
    observerRef.current = observer;
    observerGenerationRef.current = generation;
    return observer;
  }, [publishMeasurement]);

  const measureRow = useCallback((key: string): RefCallback<HTMLElement> => {
    const existingCallback = rowCallbacksRef.current.get(key);
    if (existingCallback) return existingCallback;
    const registrationGeneration = generationRef.current;
    const callback: RefCallback<HTMLElement> = (element) => {
      if (!mountedRef.current || registrationGeneration !== generationRef.current) return;
      const previous = elementsByKeyRef.current.get(key);
      if (!element) {
        if (previous) observerRef.current?.unobserve(previous);
        elementsByKeyRef.current.delete(key);
        return;
      }
      if (previous === element) return;
      if (previous) observerRef.current?.unobserve(previous);
      elementsByKeyRef.current.set(key, element);
      elementKeysRef.current.set(element, { key, generation: registrationGeneration });
      publishMeasurement(key, element.getBoundingClientRect().height, registrationGeneration);
      ensureObserver(registrationGeneration)?.observe(element);
    };
    rowCallbacksRef.current.set(key, callback);
    return callback;
  }, [ensureObserver, publishMeasurement]);

  /*
  FNXC:ListVirtualization 2026-09-08-21:16:
  React StrictMode replays layout effects without replaying mounted row refs. Each setup therefore restores the live fence, remeasures registered elements, and creates a fresh observer; cleanup cancels queued writes and disconnects the prior observer without discarding the registrations needed by the replay.
  */
  useLayoutEffect(() => {
    mountedRef.current = true;
    const generation = generationRef.current;
    const observer = ensureObserver(generation);
    for (const [key, element] of elementsByKeyRef.current) {
      elementKeysRef.current.set(element, { key, generation });
      publishMeasurement(key, element.getBoundingClientRect().height, generation);
      observer?.observe(element);
    }
    return () => {
      mountedRef.current = false;
      pendingMeasurementsRef.current.clear();
      measurementFlushRef.current = { queued: false, token: measurementFlushRef.current.token + 1 };
      observerRef.current?.disconnect();
      observerRef.current = null;
      observerGenerationRef.current = -1;
    };
  }, [ensureObserver, publishMeasurement]);

  const offsetForKey = useCallback((key: string) => {
    const index = keys.indexOf(key);
    if (index < 0) return null;
    let offset = 0;
    for (let cursor = 0; cursor < index; cursor += 1) offset += measurementsRef.current.get(keys[cursor]!) ?? estimateHeight;
    return { index, offset, height: measurementsRef.current.get(key) ?? estimateHeight };
  }, [estimateHeight, keys]);

  /*
  FNXC:ListVirtualization 2026-09-07-23:53:
  Une navigation explicite vers une ligne remplace immédiatement l’alignement terminal d’ouverture, avant même de résoudre la cible. Une recherche ou une action de remontée reste ainsi autoritaire pendant les mesures tardives au lieu d’être ramenée en fin de liste par une ancienne commande.
  */
  const scrollToKey = useCallback((key: string, align: "start" | "center" | "end" = "start") => {
    pendingBottomAlignmentRef.current = undefined;
    const container = scrollRef.current;
    const target = offsetForKey(key);
    if (!container || !target) return;
    const viewportHeight = container.clientHeight || DEFAULT_LIST_VIEWPORT_HEIGHT;
    const adjustment = align === "center" ? (viewportHeight - target.height) / 2 : align === "end" ? viewportHeight - target.height : 0;
    container.scrollTop = Math.max(0, target.offset - adjustment);
    readGeometry();
  }, [offsetForKey, readGeometry, scrollRef]);

  /*
  FNXC:ListVirtualization 2026-09-07-23:44:
  Une commande d’alignement en fin publie d’abord la géométrie terminale du virtualiseur, puis reste propriétaire de cet alignement pendant les révisions de mesure. Lire immédiatement scrollTop après l’écriture est incorrect pendant le montage, et libérer la commande après le premier layout laisse une ligne mesurée tardivement agrandir la liste sous le viewport; l’annulateur, une navigation explicite ou un changement de collection clôt cette propriété.
  */
  const scrollToBottom = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const target = Math.max(container.scrollHeight, totalHeightRef.current);
    pendingBottomAlignmentRef.current = collectionKeyRef.current;
    setGeometry((current) => ({
      ...current,
      scrollTop: Number.POSITIVE_INFINITY,
      viewportHeight: container.clientHeight || DEFAULT_LIST_VIEWPORT_HEIGHT,
    }));
    container.scrollTop = target;
  }, [scrollRef]);

  const cancelPendingScrollToBottom = useCallback(() => {
    pendingBottomAlignmentRef.current = undefined;
  }, []);

  useLayoutEffect(() => {
    const requestedCollectionKey = pendingBottomAlignmentRef.current;
    if (requestedCollectionKey === undefined || requestedCollectionKey !== collectionKey) return;
    const container = scrollRef.current;
    if (!container) return;
    container.scrollTop = Math.max(container.scrollHeight, range.totalHeight);
  }, [collectionKey, geometry.scrollTop, range.totalHeight, scrollRef]);

  const captureAnchor = useCallback((): VirtualListAnchor | null => {
    const first = keys[range.startIndex];
    return first ? { key: first, offset: geometry.scrollTop - range.topSpacerHeight } : null;
  }, [geometry.scrollTop, keys, range.startIndex, range.topSpacerHeight]);

  const restoreAnchor = useCallback((anchor: VirtualListAnchor) => {
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
    cancelPendingScrollToBottom,
    captureAnchor,
    restoreAnchor,
  };
}
