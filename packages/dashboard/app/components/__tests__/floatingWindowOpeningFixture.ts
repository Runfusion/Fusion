import type { DashboardWindowBounds } from "../../context/DashboardWindowManagerContext";
import {
  resolveStandardSize,
  type FloatingWindowOpeningSizePolicy,
  type FloatingWindowSize,
} from "../floatingWindowGeometry";

/*
FNXC:FloatingWindowGeometry 2026-09-16-05:45:
FN-456 asked for the opening rule "en DRY". Before this fixture, eight suites each carried their OWN copy of
the opening formula (`Math.min(requested, Math.round(workArea * ratio))`), so one rule change meant editing
eight literal re-implementations — and any one of them could silently drift from the seam. Tests now derive
their expectations from the production `resolveStandardSize` through this single helper, so the invariant they
assert can never disagree with the code that computes it.

These header/footer heights are the landmark sizes every FloatingWindow DOM harness in this folder mocks; the
live work area is the band between them.
*/
export const OPENING_HARNESS_HEADER_HEIGHT = 64;
export const OPENING_HARNESS_FOOTER_HEIGHT = 36;

/** FloatingWindow's own minimum size, applied when a host declares no `minSize`. */
export const FLOATING_WINDOW_DEFAULT_MIN_SIZE: FloatingWindowSize = { width: 360, height: 280 };

/** Live work-area bounds of a jsdom harness whose header/footer landmarks are mocked at the sizes above. */
export function harnessWorkArea(
  header = OPENING_HARNESS_HEADER_HEIGHT,
  footer = OPENING_HARNESS_FOOTER_HEIGHT,
): DashboardWindowBounds {
  const width = window.innerWidth;
  const height = window.innerHeight - header - footer;
  return { left: 0, top: header, right: width, bottom: header + height, width, height };
}

/** Work-area height of that same harness. */
export function harnessWorkAreaHeight(
  header = OPENING_HARNESS_HEADER_HEIGHT,
  footer = OPENING_HARNESS_FOOTER_HEIGHT,
): number {
  return window.innerHeight - header - footer;
}

/**
 * The size a host asking for `requested` actually opens at, computed by the production seam.
 * Pass `policy: "full-view"` for the FN-456 exempted integral views.
 */
export function expectedOpeningSize(
  requested: FloatingWindowSize | undefined,
  options: {
    minSize?: FloatingWindowSize;
    bounds?: DashboardWindowBounds;
    policy?: FloatingWindowOpeningSizePolicy;
  } = {},
): FloatingWindowSize {
  return resolveStandardSize(
    requested,
    options.minSize ?? FLOATING_WINDOW_DEFAULT_MIN_SIZE,
    options.bounds ?? harnessWorkArea(),
    options.policy ?? "aspect-ratio",
  );
}

/** Convenience for suites that only assert the opening HEIGHT of a host default. */
export function expectedOpeningHeight(
  requested: FloatingWindowSize,
  options: Parameters<typeof expectedOpeningSize>[1] = {},
): number {
  return expectedOpeningSize(requested, options).height;
}
