import { COMPUTER_ACTIONS, ComputerUseError, type CapabilitiesResult, type PermissionsResult } from "./contract.js";
import type {
  ClickInput, ComputerAdapter, ComputerStateCaptureOptions, DragInput, HotkeyInput, PressKeyInput,
  ResolvedComputerElement, ResolvedComputerWindow, ScrollInput, SetValueInput, TypeTextInput,
} from "./adapter.js";
import type { ActionResult, AppTarget, AppStateResult, ElementLocator, ListAppsResult, ListWindowsResult } from "./contract.js";

const remediation = "Computer use is supported on macOS only. Run this command on macOS with Accessibility permission.";

export class UnsupportedComputerAdapter implements ComputerAdapter {
  readonly id = "unsupported";
  readonly supported = false;

  constructor(readonly platform: string) {}

  async capabilities(): Promise<CapabilitiesResult> {
    return {
      platform: this.platform, adapterId: this.id, supported: false,
      actions: [], unsupportedActions: [...COMPUTER_ACTIONS],
      features: { screenshot: false, restoreWindow: false, stdinSecrets: false, crossInvocationSnapshots: false },
    };
  }

  async permissions(): Promise<PermissionsResult> {
    return { platform: this.platform, adapterId: this.id, supported: false, allGranted: false, checks: [] };
  }

  private unsupported(): never {
    throw new ComputerUseError("UNSUPPORTED_PLATFORM", `Computer use is unsupported on ${this.platform}.`, remediation);
  }

  async listApps(): Promise<ListAppsResult> { return this.unsupported(); }
  async listWindows(_target: AppTarget): Promise<ListWindowsResult> { return this.unsupported(); }
  async captureState(_target: AppTarget, _options: ComputerStateCaptureOptions): Promise<AppStateResult> { return this.unsupported(); }
  async resolveWindow(_target: AppTarget, _selector: { windowId?: string; windowIndex?: number }): Promise<ResolvedComputerWindow> { return this.unsupported(); }
  async resolveLocator(_window: ResolvedComputerWindow, _locator: ElementLocator): Promise<ResolvedComputerElement> { return this.unsupported(); }
  async click(_input: ClickInput): Promise<ActionResult> { return this.unsupported(); }
  async "set-value"(_input: SetValueInput): Promise<ActionResult> { return this.unsupported(); }
  async "type-text"(_input: TypeTextInput): Promise<ActionResult> { return this.unsupported(); }
  async "press-key"(_input: PressKeyInput): Promise<ActionResult> { return this.unsupported(); }
  async hotkey(_input: HotkeyInput): Promise<ActionResult> { return this.unsupported(); }
  async scroll(_input: ScrollInput): Promise<ActionResult> { return this.unsupported(); }
  async drag(_input: DragInput): Promise<ActionResult> { return this.unsupported(); }
}
