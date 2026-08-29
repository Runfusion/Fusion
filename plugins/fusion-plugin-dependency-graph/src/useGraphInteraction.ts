import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { LayoutOptions } from "./layout.js";
import type { GraphPosition } from "./types.js";

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 3;
const FIT_PADDING = 40;
const TRANSITION_TIMEOUT_MS = 200;

interface PointerPoint {
  x: number;
  y: number;
}

interface PinchState {
  distance: number;
  zoom: number;
  pan: PointerPoint;
  midpoint: PointerPoint;
}

interface GraphBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return target.isContentEditable || tagName === "input" || tagName === "textarea" || tagName === "select";
}

export function useGraphInteraction() {
  const [pan, setPan] = useState<PointerPoint>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [transitioning, setTransitioning] = useState(false);

  const panRef = useRef(pan);
  const zoomRef = useRef(zoom);
  const transitionTimerRef = useRef<number | null>(null);
  const dragStateRef = useRef<{ start: PointerPoint; panStart: PointerPoint } | null>(null);
  const pointersRef = useRef<Map<number, PointerPoint>>(new Map());
  const pinchRef = useRef<PinchState | null>(null);
  const graphBoundsRef = useRef<GraphBounds>({ minX: 0, minY: 0, maxX: 0, maxY: 0 });

  useEffect(() => {
    panRef.current = pan;
  }, [pan]);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => () => {
    if (transitionTimerRef.current !== null) {
      window.clearTimeout(transitionTimerRef.current);
    }
  }, []);

  const transform = useMemo(() => `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, [pan.x, pan.y, zoom]);
  const zoomPercent = useMemo(() => Math.round(zoom * 100), [zoom]);

  const setAnimate = useCallback((enabled: boolean) => {
    if (!enabled) {
      if (transitionTimerRef.current !== null) {
        window.clearTimeout(transitionTimerRef.current);
        transitionTimerRef.current = null;
      }
      setTransitioning(false);
      return;
    }

    setTransitioning(true);
    if (transitionTimerRef.current !== null) {
      window.clearTimeout(transitionTimerRef.current);
    }
    transitionTimerRef.current = window.setTimeout(() => {
      setTransitioning(false);
      transitionTimerRef.current = null;
    }, TRANSITION_TIMEOUT_MS);
  }, []);

  const clampPan = useCallback((nextPan: PointerPoint, viewportWidth: number, viewportHeight: number, nextZoom = zoomRef.current) => {
    const bounds = graphBoundsRef.current;

    if (bounds.maxX <= bounds.minX || bounds.maxY <= bounds.minY) {
      return {
        x: clamp(nextPan.x, -viewportWidth, viewportWidth),
        y: clamp(nextPan.y, -viewportHeight, viewportHeight),
      };
    }

    const minPanX = viewportWidth - bounds.maxX * nextZoom;
    const maxPanX = -bounds.minX * nextZoom;
    const minPanY = viewportHeight - bounds.maxY * nextZoom;
    const maxPanY = -bounds.minY * nextZoom;

    const clampedX = minPanX > maxPanX ? (minPanX + maxPanX) / 2 : clamp(nextPan.x, minPanX, maxPanX);
    const clampedY = minPanY > maxPanY ? (minPanY + maxPanY) / 2 : clamp(nextPan.y, minPanY, maxPanY);

    return { x: clampedX, y: clampedY };
  }, []);

  const zoomAtPoint = useCallback((
    nextZoomRaw: number,
    anchor: PointerPoint,
    viewportWidth: number,
    viewportHeight: number,
  ) => {
    const currentZoom = zoomRef.current;
    const currentPan = panRef.current;
    const nextZoom = clamp(nextZoomRaw, MIN_ZOOM, MAX_ZOOM);
    const scaleRatio = nextZoom / currentZoom;

    const nextPan = clampPan({
      x: anchor.x - (anchor.x - currentPan.x) * scaleRatio,
      y: anchor.y - (anchor.y - currentPan.y) * scaleRatio,
    }, viewportWidth, viewportHeight, nextZoom);

    setZoom(nextZoom);
    setPan(nextPan);
  }, [clampPan]);

  const zoomByFactor = useCallback((factor: number, viewportWidth: number, viewportHeight: number, anchor?: PointerPoint) => {
    setAnimate(false);
    const point = anchor ?? { x: viewportWidth / 2, y: viewportHeight / 2 };
    zoomAtPoint(zoomRef.current * factor, point, viewportWidth, viewportHeight);
  }, [setAnimate, zoomAtPoint]);

  const zoomIn = useCallback((viewportWidth?: number, viewportHeight?: number) => {
    if (viewportWidth && viewportHeight) {
      zoomByFactor(1.2, viewportWidth, viewportHeight);
      return;
    }
    setZoom((current) => clamp(current + 0.1, MIN_ZOOM, MAX_ZOOM));
  }, [zoomByFactor]);

  const zoomOut = useCallback((viewportWidth?: number, viewportHeight?: number) => {
    if (viewportWidth && viewportHeight) {
      zoomByFactor(1 / 1.2, viewportWidth, viewportHeight);
      return;
    }
    setZoom((current) => clamp(current - 0.1, MIN_ZOOM, MAX_ZOOM));
  }, [zoomByFactor]);

  const resetView = useCallback(() => {
    setAnimate(true);
    setPan({ x: 0, y: 0 });
    setZoom(1);
  }, [setAnimate]);

  const fitToGraph = useCallback((
    positions: Map<string, GraphPosition>,
    viewportWidth: number,
    viewportHeight: number,
    layoutOptions?: LayoutOptions,
  ) => {
    setAnimate(true);
    if (positions.size === 0) {
      setPan({ x: 0, y: 0 });
      setZoom(1);
      return;
    }

    const nodeWidth = layoutOptions?.nodeWidth ?? 280;
    const nodeHeight = layoutOptions?.nodeHeight ?? 100;

    const entries = Array.from(positions.entries());
    const minX = Math.min(...entries.map(([, p]) => p.x));
    const minY = Math.min(...entries.map(([, p]) => p.y));
    const maxX = Math.max(...entries.map(([, p]) => p.x + nodeWidth));
    const maxY = Math.max(
      ...entries.map(([taskId, p]) => p.y + (layoutOptions?.measuredHeights?.get(taskId) ?? nodeHeight)),
    );

    const graphWidth = Math.max(1, maxX - minX);
    const graphHeight = Math.max(1, maxY - minY);
    const availableWidth = Math.max(1, viewportWidth - FIT_PADDING * 2);
    const availableHeight = Math.max(1, viewportHeight - FIT_PADDING * 2);
    const nextZoom = clamp(Math.min(availableWidth / graphWidth, availableHeight / graphHeight), MIN_ZOOM, MAX_ZOOM);

    const panX = (viewportWidth - graphWidth * nextZoom) / 2 - minX * nextZoom;
    const panY = (viewportHeight - graphHeight * nextZoom) / 2 - minY * nextZoom;

    setZoom(nextZoom);
    setPan(clampPan({ x: panX, y: panY }, viewportWidth, viewportHeight, nextZoom));
  }, [clampPan, setAnimate]);

  const onPointerDown = useCallback((pointerId: number, point: PointerPoint) => {
    pointersRef.current.set(pointerId, point);
    if (pointersRef.current.size === 2) {
      const [a, b] = Array.from(pointersRef.current.values());
      pinchRef.current = {
        distance: Math.hypot(a.x - b.x, a.y - b.y),
        zoom: zoomRef.current,
        pan: panRef.current,
        midpoint: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      };
      dragStateRef.current = null;
      return;
    }
    dragStateRef.current = { start: point, panStart: panRef.current };
  }, []);

  const onPointerMove = useCallback((pointerId: number, point: PointerPoint, viewportWidth: number, viewportHeight: number) => {
    if (pointersRef.current.has(pointerId)) pointersRef.current.set(pointerId, point);

    if (pointersRef.current.size === 2 && pinchRef.current) {
      setAnimate(false);
      const [a, b] = Array.from(pointersRef.current.values());
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const factor = distance / Math.max(1, pinchRef.current.distance);
      const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const nextZoom = clamp(pinchRef.current.zoom * factor, MIN_ZOOM, MAX_ZOOM);
      const ratio = nextZoom / pinchRef.current.zoom;
      const nextPan = clampPan({
        x: midpoint.x - (pinchRef.current.midpoint.x - pinchRef.current.pan.x) * ratio,
        y: midpoint.y - (pinchRef.current.midpoint.y - pinchRef.current.pan.y) * ratio,
      }, viewportWidth, viewportHeight);
      setZoom(nextZoom);
      setPan(nextPan);
      return;
    }

    const dragState = dragStateRef.current;
    if (!dragState) return;
    setAnimate(false);
    const nextPan = {
      x: dragState.panStart.x + (point.x - dragState.start.x),
      y: dragState.panStart.y + (point.y - dragState.start.y),
    };
    setPan(clampPan(nextPan, viewportWidth, viewportHeight));
  }, [clampPan, setAnimate]);

  const onPointerUp = useCallback((pointerId: number) => {
    pointersRef.current.delete(pointerId);
    if (pointersRef.current.size < 2) {
      pinchRef.current = null;
    }

    if (pointersRef.current.size === 1) {
      const [remainingPoint] = Array.from(pointersRef.current.values());
      dragStateRef.current = { start: remainingPoint, panStart: panRef.current };
      return;
    }

    if (pointersRef.current.size === 0) {
      dragStateRef.current = null;
    }
  }, []);

  const onWheelPan = useCallback((deltaX: number, deltaY: number, viewportWidth: number, viewportHeight: number) => {
    setAnimate(false);
    const nextPan = {
      x: panRef.current.x - deltaX,
      y: panRef.current.y - deltaY,
    };
    setPan(clampPan(nextPan, viewportWidth, viewportHeight));
  }, [clampPan, setAnimate]);

  const onWheelZoom = useCallback((
    deltaY: number,
    point: PointerPoint,
    viewportWidth: number,
    viewportHeight: number,
  ) => {
    const factor = deltaY < 0 ? 1.1 : 0.9;
    setAnimate(false);
    zoomAtPoint(zoomRef.current * factor, point, viewportWidth, viewportHeight);
  }, [setAnimate, zoomAtPoint]);

  const setGraphBounds = useCallback((bounds: GraphBounds) => {
    graphBoundsRef.current = bounds;
  }, []);

  const handleKeyDown = useCallback((
    event: ReactKeyboardEvent,
    viewportWidth: number,
    viewportHeight: number,
    positions: Map<string, GraphPosition>,
    layoutOptions?: LayoutOptions,
  ) => {
    if (isEditableTarget(event.target)) return;

    const modifier = event.metaKey || event.ctrlKey;
    if (event.key === "Escape") {
      event.preventDefault();
      resetView();
      return;
    }

    if (!modifier) return;

    if (event.key === "=" || event.key === "+") {
      event.preventDefault();
      zoomByFactor(1.2, viewportWidth, viewportHeight);
      return;
    }

    if (event.key === "-") {
      event.preventDefault();
      zoomByFactor(1 / 1.2, viewportWidth, viewportHeight);
      return;
    }

    if (event.key === "0") {
      event.preventDefault();
      resetView();
      return;
    }

    if ((event.key === "f" || event.key === "F") && event.shiftKey) {
      event.preventDefault();
      fitToGraph(positions, viewportWidth, viewportHeight, layoutOptions);
    }
  }, [fitToGraph, resetView, zoomByFactor]);

  return {
    pan,
    zoom,
    zoomPercent,
    transform,
    transitioning,
    zoomIn,
    zoomOut,
    resetView,
    fitToGraph,
    setAnimate,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onWheelPan,
    onWheelZoom,
    handleKeyDown,
    setGraphBounds,
  };
}
