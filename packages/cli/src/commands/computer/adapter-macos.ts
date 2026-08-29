import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ClickInput, ComputerAdapter, ComputerStateCaptureOptions, DragInput, HotkeyInput, PressKeyInput, ResolvedComputerElement, ResolvedComputerWindow, ScrollInput, SetValueInput, TypeTextInput } from "./adapter.js";
import type { ComputerClock } from "./adapter-registry.js";
import type { ComputerExecSeam } from "./exec-seam.js";
import { COMPUTER_ACTIONS, COMPUTER_TIMEOUTS, ComputerUseError, type ActionResult, type AppRef, type AppStateResult, type AppTarget, type CapabilitiesResult, type Element, type ElementLocator, type ListAppsResult, type ListWindowsResult, type PermissionCheck, type PermissionsResult, type WindowRef } from "./contract.js";
import { MACOS_AUTOMATION, MACOS_PERMISSION_PREFLIGHT } from "./scripts/macos-jxa.js";

const REMEDIATION_ACCESSIBILITY = "Grant the host terminal or app in System Settings → Privacy & Security → Accessibility, then re-run fn computer permissions.";
const REMEDIATION_SCREEN = "Grant the host terminal or app in System Settings → Privacy & Security → Screen Recording, then re-run fn computer permissions.";
const MISSING_OSASCRIPT_DETAIL = "The macOS osascript built-in is unavailable.";

/**
 * FNXC:ComputerUse 2026-08-11-03:54:
 * Permission reporting uses only non-mutating TCC preflight. A denied screencapture can still save
 * wallpaper pixels, so capture success is not proof of Screen Recording permission. Denied access
 * refuses before automation while unknown attempts the operation and classifies an authorization failure.
 */
export class MacosComputerAdapter implements ComputerAdapter {
  readonly platform = "darwin";
  readonly id = "macos-osascript-system-events";
  readonly supported = true;
  constructor(private readonly context: { seam: ComputerExecSeam; clock: ComputerClock; projectRoot: string }) {}

  async capabilities(): Promise<CapabilitiesResult> {
    return { platform: this.platform, adapterId: this.id, supported: true, actions: [...COMPUTER_ACTIONS], unsupportedActions: [], features: { screenshot: true, restoreWindow: true, stdinSecrets: true, crossInvocationSnapshots: true } };
  }

  async permissions(): Promise<PermissionsResult> {
    return (await this.probePermissions()).result;
  }

  async listApps(): Promise<ListAppsResult> {
    await this.assertAccessibility();
    const value = await this.callJson(["list-apps"], COMPUTER_TIMEOUTS.discovery);
    const apps = Array.isArray(value.apps) ? value.apps.filter(isAppRef) : [];
    return { apps: apps.sort((a, b) => a.name.localeCompare(b.name)) };
  }

  async listWindows(target: AppTarget): Promise<ListWindowsResult> {
    await this.assertAccessibility();
    const app = await this.resolveApp(target);
    const value = await this.callJson(["list-windows", target.raw], COMPUTER_TIMEOUTS.discovery);
    return { app, windows: Array.isArray(value.windows) ? value.windows.filter(isWindowRef) : [] };
  }

  async captureState(target: AppTarget, options: ComputerStateCaptureOptions): Promise<AppStateResult> {
    await this.assertAccessibility();
    const app = await this.resolveApp(target);
    const resolved = await this.resolveWindow(target, { windowId: options.windowId, windowIndex: options.windowIndex });
    if (options.restoreWindow) await this.callJson(["restore-window", target.raw, resolved.window.windowId, String(resolved.window.windowIndex)], COMPUTER_TIMEOUTS.stateCapture);
    const value = await this.callJson(["state", target.raw, resolved.window.windowId, String(resolved.window.windowIndex)], COMPUTER_TIMEOUTS.stateCapture);
    const elements = Array.isArray(value.elements) ? value.elements.filter(isElement) : [];
    const snapshot = { snapshotId: "", targetKey: "", windowKey: "", capturedAt: this.context.clock.now().toISOString(), expiresAt: "", treeText: typeof value.treeText === "string" ? value.treeText : "", elementCount: elements.length, truncated: value.truncated === true, elements };
    let screenshot: AppStateResult["screenshot"] = null;
    let screenshotError: AppStateResult["screenshotError"];
    if (options.screenshot) {
      const screen = (await this.permissions()).checks.find((item) => item.id === "screen-recording");
      if (screen?.status === "denied") screenshotError = { code: "PERMISSION_DENIED", message: REMEDIATION_SCREEN };
      else {
        const directory = join(this.context.projectRoot, ".fusion", "computer-use", "screenshots");
        const file = join(directory, `computer-${this.context.clock.now().getTime()}.png`);
        // FNXC:ComputerUse 2026-08-11-04:42: Screenshot I/O is optional state decoration. A
        // filesystem or screencapture spawn failure must preserve the captured accessibility tree
        // so the command can persist its snapshot and report the failure only as screenshotError.
        try {
          await mkdir(directory, { recursive: true });
          // FNXC:ComputerUse 2026-08-11-04:12: screencapture -l accepts only a verified Quartz
          // CGWindowID, never an AX id or a System Events index. Without the identity-mapped ID this
          // optional capture degrades rather than selecting an unrelated window on a numeric collision.
          const captureWindowId = (resolved.handle as { captureWindowId?: unknown }).captureWindowId;
          if (typeof captureWindowId !== "number" || !Number.isSafeInteger(captureWindowId) || captureWindowId < 0) {
            screenshotError = { code: "SCREENSHOT_FAILED", message: "The selected window cannot be captured by screencapture." };
          } else {
            const output = await this.context.seam.run("screencapture", ["-x", "-l", String(captureWindowId), file], { timeoutMs: COMPUTER_TIMEOUTS.screenshotCapture });
            if (output.timedOut) screenshotError = { code: "TIMEOUT", message: "Screenshot capture timed out." };
            else if (output.exitCode !== 0) screenshotError = { code: screen?.status === "unknown" ? "PERMISSION_UNVERIFIED" : "SCREENSHOT_FAILED", message: "Screenshot capture failed." };
            else screenshot = { path: file, width: null, height: null, verifiedPermission: screen?.status === "granted" };
          }
        } catch (error) {
          screenshotError = {
            code: isMissingBinary(error, "screencapture") ? "SCREENSHOT_FAILED" : screen?.status === "unknown" ? "PERMISSION_UNVERIFIED" : "SCREENSHOT_FAILED",
            message: "Screenshot capture failed.",
          };
        }
      }
    }
    return { app, window: resolved.window, snapshot, screenshot, ...(screenshotError ? { screenshotError } : {}) };
  }

  async resolveWindow(target: AppTarget, selector: { windowId?: string; windowIndex?: number }): Promise<ResolvedComputerWindow> {
    const listed = await this.listWindows(target);
    const window = selector.windowId ? listed.windows.find((item) => item.windowId === selector.windowId) : selector.windowIndex !== undefined ? listed.windows.find((item) => item.windowIndex === selector.windowIndex) : listed.windows[0];
    if (!window) throw new ComputerUseError("WINDOW_NOT_FOUND", "The requested window was not found.");
    const captureWindowId = (window as WindowRef & { captureWindowId?: unknown }).captureWindowId;
    return { window, handle: { appTarget: target.raw, windowId: window.windowId, windowIndex: window.windowIndex, ...(typeof captureWindowId === "number" ? { captureWindowId } : {}) } };
  }

  /** FNXC:ComputerUse 2026-08-11-03:54: A fresh CLI process must replay and identity-check the locator. It reports window-gone separately and never falls back to stale bounds or a replacement path occupant. */
  async resolveLocator(window: ResolvedComputerWindow, locator: ElementLocator): Promise<ResolvedComputerElement> {
    await this.assertAccessibility();
    const windowHandle = window.handle as { appTarget?: string; windowId?: string; windowIndex?: number };
    let result: Record<string, unknown>;
    try {
      result = await this.callJson(["resolve-locator", windowHandle.appTarget ?? "", windowHandle.windowId ?? window.window.windowId, String(windowHandle.windowIndex ?? window.window.windowIndex), locator.path], COMPUTER_TIMEOUTS.locatorReplay);
    } catch (error) {
      /*
       * FNXC:ComputerUse 2026-08-11-04:29:
       * Locator replay is the cross-process identity fence. Preserve transport and permission
       * outcomes, but report a vanished AX path as ELEMENT_UNRESOLVABLE rather than ACTION_FAILED.
       */
      if (error instanceof ComputerUseError && error.code === "ACTION_FAILED") {
        throw new ComputerUseError("ELEMENT_UNRESOLVABLE", "The captured element can no longer be resolved; re-run fn computer get-app-state.", "Re-run fn computer get-app-state.");
      }
      throw error;
    }
    const element = result.element;
    if (!isLiveElement(element) || element.role !== locator.role || (locator.subrole !== null && element.locator.subrole !== locator.subrole) || (locator.identifier !== null && element.locator.identifier !== locator.identifier)) {
      throw new ComputerUseError("ELEMENT_UNRESOLVABLE", "The captured element no longer matches; re-run fn computer get-app-state.", "Re-run fn computer get-app-state.");
    }
    return { element: { ...element, index: 0 } as Element, handle: locator.path };
  }

  async click(input: ClickInput): Promise<ActionResult> { await this.perform("click", input.app, input.window, input.element); return singleAction("click", input.app, input.snapshotId, input.element.element.index); }
  async "set-value"(input: SetValueInput): Promise<ActionResult> { await this.perform("set-value", input.app, input.window, input.element, undefined, input.value); return singleAction("set-value", input.app, input.snapshotId, input.element.element.index); }
  async "type-text"(input: TypeTextInput): Promise<ActionResult> { await this.perform("type-text", input.app, input.window, input.element, undefined, input.text); return singleAction("type-text", input.app, input.snapshotId ?? null, input.element?.element.index ?? null); }
  async "press-key"(input: PressKeyInput): Promise<ActionResult> { await this.perform("press-key", input.app, input.window, input.element, input.key); return singleAction("press-key", input.app, input.snapshotId ?? null, input.element?.element.index ?? null); }
  async hotkey(input: HotkeyInput): Promise<ActionResult> { await this.assertAccessibility(); await this.callJson(["hotkey", input.app.name, input.keys[input.keys.length - 1] ?? "", ...input.keys.slice(0, -1)], COMPUTER_TIMEOUTS.action); return singleAction("hotkey", input.app, null, null); }
  async scroll(input: ScrollInput): Promise<ActionResult> { await this.perform("scroll", input.app, input.window, input.element, `${input.direction}:${input.amount}`); return singleAction("scroll", input.app, input.snapshotId ?? null, input.element?.element.index ?? null); }
  async drag(input: DragInput): Promise<ActionResult> {
    await this.assertAccessibility();
    if (input.from && input.to) {
      const from = center(input.from.element.bounds), to = center(input.to.element.bounds);
      if (!from || !to) throw new ComputerUseError("ACTION_FAILED", "Resolved drag elements have no current bounds.");
      // Bounds come from locator replay in this invocation, never the persisted snapshot fallback.
      await this.callJson(["drag-coordinates", input.app.name, String(from.x), String(from.y), String(to.x), String(to.y)], COMPUTER_TIMEOUTS.action);
    } else if (input.fromX !== undefined && input.fromY !== undefined && input.toX !== undefined && input.toY !== undefined) { await this.callJson(["drag-coordinates", input.app.name, String(input.fromX), String(input.fromY), String(input.toX), String(input.toY)], COMPUTER_TIMEOUTS.action); }
    else throw new ComputerUseError("ACTION_FAILED", "Drag requires coordinates or resolved elements.");
    return { action: "drag", app: input.app, snapshotId: input.snapshotId, elementIndex: null, fromElementIndex: input.from?.element.index ?? null, toElementIndex: input.to?.element.index ?? null, performed: true, snapshotConsumed: false };
  }

  private async assertAccessibility(): Promise<void> {
    const probe = await this.probePermissions();
    const access = probe.result.checks.find((check) => check.id === "accessibility");
    if (probe.missingBinary) {
      throw new ComputerUseError("PERMISSION_DENIED", "macOS osascript is unavailable.", "macOS with the osascript built-in is required for fn computer.", { missingBinary: "osascript" });
    }
    if (access?.status === "denied") throw new ComputerUseError("PERMISSION_DENIED", "Accessibility permission is denied.", REMEDIATION_ACCESSIBILITY, { permission: "accessibility" });
  }

  private async probePermissions(): Promise<{ result: PermissionsResult; missingBinary?: "osascript" }> {
    const fallback = (detail: string): PermissionsResult => ({ platform: this.platform, adapterId: this.id, supported: true, allGranted: false, checks: [check("accessibility", "unknown", false, detail, REMEDIATION_ACCESSIBILITY), check("screen-recording", "unknown", false, detail, REMEDIATION_SCREEN)] });
    let run;
    try {
      run = await this.context.seam.run("osascript", ["-l", "JavaScript", "-e", MACOS_PERMISSION_PREFLIGHT], { timeoutMs: COMPUTER_TIMEOUTS.permissionProbe });
    } catch (error) {
      /*
       * FNXC:ComputerUse 2026-08-13-23:35:
       * A missing osascript cannot prove either TCC grant, so the public probe remains unknown.
       * Preserve a structural marker for C7.4 because automation must refuse before acting without
       * coupling that safety decision to the versioned human-readable permission detail.
       */
      return isMissingBinary(error, "osascript")
        ? { result: fallback(MISSING_OSASCRIPT_DETAIL), missingBinary: "osascript" }
        : { result: fallback("Permission preflight could not run.") };
    }
    if (run.timedOut) return { result: fallback("Permission preflight timed out.") };
    if (run.exitCode !== 0) return { result: fallback("Permission preflight could not run.") };
    try {
      const values = JSON.parse(run.stdout) as { accessibility: boolean; screenRecording: boolean };
      if (typeof values.accessibility !== "boolean" || typeof values.screenRecording !== "boolean") return { result: fallback("Permission preflight returned invalid output.") };
      const checks = [check("accessibility", values.accessibility ? "granted" : "denied", true, null, REMEDIATION_ACCESSIBILITY), check("screen-recording", values.screenRecording ? "granted" : "denied", true, null, REMEDIATION_SCREEN)];
      return { result: { platform: this.platform, adapterId: this.id, supported: true, allGranted: checks.every((item) => item.granted), checks } };
    } catch { return { result: fallback("Permission preflight returned invalid output.") }; }
  }

  private async resolveApp(target: AppTarget): Promise<AppRef> {
    const apps = (await this.listApps()).apps;
    const matches = target.kind === "pid"
      ? apps.filter((app) => String(app.pid) === target.value)
      : (() => { const byBundle = apps.filter((app) => app.bundleId === target.value); return byBundle.length ? byBundle : apps.filter((app) => app.name === target.value); })();
    if (!matches.length) throw new ComputerUseError("APP_NOT_FOUND", `No running app matches ${target.raw}.`);
    if (matches.length > 1) throw new ComputerUseError("AMBIGUOUS_APP", `More than one app matches ${target.raw}.`, "Use a bundle identifier or pid target.", { candidateCount: matches.length });
    return matches[0];
  }

  private async perform(operation: string, app: AppRef, window?: ResolvedComputerWindow, element?: ResolvedComputerElement, argument?: string, stdin?: string): Promise<void> {
    await this.assertAccessibility();
    // Element paths and names are argv values, never JXA source interpolation.
    const args = [operation, app.name, window?.window.windowId ?? "", String(window?.window.windowIndex ?? ""), element ? String(element.handle) : "", argument ?? ""];
    await this.callJson(args, COMPUTER_TIMEOUTS.action, stdin);
  }

  private async callJson(args: string[], timeoutMs: number, stdin?: string): Promise<Record<string, unknown>> {
    let output;
    try {
      output = await this.context.seam.run("osascript", ["-l", "JavaScript", "-e", MACOS_AUTOMATION, ...args], { timeoutMs, stdin });
    } catch (error) {
      if (isMissingBinary(error, "osascript")) throw new ComputerUseError("PERMISSION_DENIED", "macOS osascript is unavailable.", "macOS with the osascript built-in is required for fn computer.", { missingBinary: "osascript" });
      throw error;
    }
    if (output.timedOut) throw new ComputerUseError("TIMEOUT", "OS automation timed out.");
    if (output.exitCode !== 0) throw new ComputerUseError(permissionShaped(output.stderr) ? "PERMISSION_UNVERIFIED" : "ACTION_FAILED", "OS automation failed.", permissionShaped(output.stderr) ? REMEDIATION_ACCESSIBILITY : undefined);
    try { const parsed: unknown = JSON.parse(output.stdout); return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {}; } catch { throw new ComputerUseError("ACTION_FAILED", "OS automation returned invalid output."); }
  }
}

function check(id: PermissionCheck["id"], status: PermissionCheck["status"], probed: boolean, detail: string | null, remediation: string): PermissionCheck { return { id, status, granted: status === "granted", probed, probe: id === "accessibility" ? "AXIsProcessTrusted" : "CGPreflightScreenCaptureAccess", detail, remediation }; }
export function permissionShaped(stderr: string): boolean { return /-1719|-25211|not allowed assistive access|not authorized|accessibility/i.test(stderr); }
function isMissingBinary(error: unknown, binary: string): boolean {
  const candidate = error as NodeJS.ErrnoException | undefined;
  return candidate?.code === "ENOENT" || new RegExp(`\\b${binary}\\b.*\\bnot found\\b|\\bENOENT\\b`, "i").test(candidate?.message ?? "");
}
function isAppRef(value: unknown): value is AppRef { const app = value as AppRef; return !!app && typeof app.name === "string" && typeof app.pid === "number" && (typeof app.bundleId === "string" || app.bundleId === null); }
function isWindowRef(value: unknown): value is ResolvedComputerWindow["window"] { const window = value as ResolvedComputerWindow["window"]; return !!window && typeof window.windowId === "string" && typeof window.windowIndex === "number" && typeof window.title === "string"; }
function isElement(value: unknown): value is Element { const element = value as Element; return isLiveElement(value) && typeof element.index === "number"; }
function isLiveElement(value: unknown): value is Omit<Element, "index"> { const element = value as Element; return !!element && typeof element.role === "string" && !!element.locator && typeof element.locator.path === "string"; }
function center(bounds: Element["bounds"]): { x: number; y: number } | undefined { return bounds ? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 } : undefined; }
function singleAction(action: string, app: AppRef, snapshotId: string | null, elementIndex: number | null): ActionResult { return { action, app, snapshotId: action === "hotkey" ? null : snapshotId, elementIndex, fromElementIndex: null, toElementIndex: null, performed: true, snapshotConsumed: false }; }
