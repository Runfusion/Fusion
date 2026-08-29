import type {
  ActionResult,
  AppRef,
  AppStateResult,
  AppTarget,
  CapabilitiesResult,
  ComputerAction,
  Element,
  ElementLocator,
  ListAppsResult,
  ListWindowsResult,
  PermissionsResult,
  WindowRef,
} from "./contract.js";

/** A serializable window reference paired with an adapter-private live handle. */
export interface ResolvedComputerWindow {
  readonly window: WindowRef;
  readonly handle: unknown;
}

/** A serializable element paired with an adapter-private live accessibility handle. */
export interface ResolvedComputerElement {
  readonly element: Element;
  readonly handle: unknown;
}

export interface ComputerStateCaptureOptions {
  windowId?: string;
  windowIndex?: number;
  screenshot: boolean;
  restoreWindow: boolean;
}

export interface ElementActionInput {
  app: AppRef;
  window: ResolvedComputerWindow;
  element: ResolvedComputerElement;
  snapshotId: string | null;
}

export interface UntargetedActionInput {
  app: AppRef;
}

export type ClickInput = ElementActionInput;
export interface SetValueInput extends ElementActionInput { value: string; }
export interface TypeTextInput extends Omit<Partial<ElementActionInput>, "app">, UntargetedActionInput { text: string; }
export interface PressKeyInput extends Omit<Partial<ElementActionInput>, "app">, UntargetedActionInput { key: string; }
export interface HotkeyInput extends UntargetedActionInput { keys: readonly string[]; }
export interface ScrollInput extends Omit<Partial<ElementActionInput>, "app">, UntargetedActionInput { direction: "up" | "down" | "left" | "right"; amount: number; }
export interface DragInput extends UntargetedActionInput {
  snapshotId: string | null;
  window?: ResolvedComputerWindow;
  from?: ResolvedComputerElement;
  to?: ResolvedComputerElement;
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
}

/**
 * FNXC:ComputerUse 2026-08-11-03:34:
 * Desktop automation must resolve unsupported platforms honestly: a clear failure is safer than a
 * silent no-op that makes callers believe an action happened. Element-taking methods receive the
 * command layer's resolved window and locator-backed element, never an index, because indexes are
 * sparse and snapshot-scoped across separate CLI processes.
 */
export interface ComputerAdapter {
  readonly platform: string;
  readonly id: string;
  readonly supported: boolean;

  capabilities(): Promise<CapabilitiesResult>;
  permissions(): Promise<PermissionsResult>;
  listApps(): Promise<ListAppsResult>;
  listWindows(target: AppTarget): Promise<ListWindowsResult>;
  captureState(target: AppTarget, options: ComputerStateCaptureOptions): Promise<AppStateResult>;
  resolveWindow(target: AppTarget, selector: { windowId?: string; windowIndex?: number }): Promise<ResolvedComputerWindow>;
  resolveLocator(window: ResolvedComputerWindow, locator: ElementLocator): Promise<ResolvedComputerElement>;

  click(input: ClickInput): Promise<ActionResult>;
  "set-value"(input: SetValueInput): Promise<ActionResult>;
  "type-text"(input: TypeTextInput): Promise<ActionResult>;
  "press-key"(input: PressKeyInput): Promise<ActionResult>;
  hotkey(input: HotkeyInput): Promise<ActionResult>;
  scroll(input: ScrollInput): Promise<ActionResult>;
  drag(input: DragInput): Promise<ActionResult>;
}

/** Ensures the adapter surface remains exhaustive when the runtime action inventory grows. */
export type ComputerAdapterActionMethods = {
  [Action in ComputerAction]: ComputerAdapter[Action];
};

export type ComputerAdapterAction = ComputerAction;
