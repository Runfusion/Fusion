/*
 * FNXC:ComputerUse 2026-08-11-03:34:
 * This is the versioned contract consumed by the follow-up skill. Fields and codes are append-only;
 * schemaVersion changes only for a breaking reshape. Runtime tuples are intentional because erased
 * TypeScript unions cannot protect the downstream conformance test. Locators persist because each
 * CLI invocation is a separate process, and deterministic one-code failures let callers branch safely.
 */

export const COMPUTER_ERROR_CODES = Object.freeze([
  "UNSUPPORTED_PLATFORM", "PERMISSION_DENIED", "PERMISSION_UNVERIFIED", "INVALID_ARGUMENTS",
  "APP_NOT_FOUND", "AMBIGUOUS_APP", "WINDOW_NOT_FOUND", "SNAPSHOT_REQUIRED", "SNAPSHOT_STALE",
  "ELEMENT_INDEX_NOT_FOUND", "ELEMENT_UNRESOLVABLE", "ACTION_UNSUPPORTED", "ACTION_FAILED",
  "SCREENSHOT_FAILED", "TIMEOUT", "INTERNAL",
] as const);
export type ComputerErrorCode = (typeof COMPUTER_ERROR_CODES)[number];
export const COMPUTER_ACTIONS = Object.freeze(["click", "set-value", "type-text", "press-key", "hotkey", "scroll", "drag"] as const);
export type ComputerAction = (typeof COMPUTER_ACTIONS)[number];
export const COMPUTER_SUBCOMMANDS = Object.freeze([
  "capabilities", "permissions", "list-apps", "list-windows", "get-app-state",
  "click", "set-value", "type-text", "press-key", "hotkey", "scroll", "drag",
] as const);
export type ComputerSubcommand = (typeof COMPUTER_SUBCOMMANDS)[number];

export type ComputerFlagValueKind = "string" | "integer" | "boolean";
export interface ComputerCommandFlag {
  flag: `--${string}`;
  valueKind: ComputerFlagValueKind;
  required: boolean;
  mutuallyExclusiveWith?: `--${string}`;
  choices?: readonly string[];
  description: string;
}
export interface ComputerCommandSurfaceEntry {
  description: string;
  flags: readonly ComputerCommandFlag[];
  /** Cross-flag rules enforced by the hand-written validator. */
  requirements?: readonly string[];
}

/**
 * FNXC:ComputerUseSkill 2026-08-11-07:19:
 * This descriptor is the single source for computer help and the in-process skill guide. Guards 1,
 * 2a, 2b, 3, and 6 independently connect it to dispatch, parser literals, emitted error codes, and
 * complete rendering. The shipped parser deliberately neither rejects undeclared flags nor invalid
 * enum choices, and source presence does not prove a flag remains honored. Error codes stay solely
 * in COMPUTER_ERROR_CODES so guide rendering never introduces a tautological duplicate.
 */
export const COMPUTER_COMMAND_SURFACE = Object.freeze({
  capabilities: { description: "Report platform support and available automation capabilities.", flags: [] },
  permissions: { description: "Report accessibility and screen-recording permission state.", flags: [] },
  "list-apps": { description: "List running applications available for selection.", flags: [] },
  "list-windows": { description: "List windows for an application.", flags: [{ flag: "--app", valueKind: "string", required: true, description: "Bundle id, exact app name, or pid target." }] },
  "get-app-state": { description: "Capture an app window and its accessible elements.", flags: [
    { flag: "--app", valueKind: "string", required: true, description: "Application target." },
    { flag: "--window-id", valueKind: "string", required: false, mutuallyExclusiveWith: "--window-index", description: "Window identifier." },
    { flag: "--window-index", valueKind: "integer", required: false, mutuallyExclusiveWith: "--window-id", description: "Window position." },
    { flag: "--no-screenshot", valueKind: "boolean", required: false, description: "Skip screenshot capture." },
    { flag: "--restore-window", valueKind: "boolean", required: false, description: "Restore a minimized window." },
  ] },
  click: { description: "Click a captured element.", flags: [
    { flag: "--app", valueKind: "string", required: true, description: "Application target." }, { flag: "--element-index", valueKind: "integer", required: true, description: "Snapshot element index." },
    { flag: "--snapshot-id", valueKind: "string", required: false, description: "Snapshot fence." }, { flag: "--window-id", valueKind: "string", required: false, mutuallyExclusiveWith: "--window-index", description: "Window identifier." }, { flag: "--window-index", valueKind: "integer", required: false, mutuallyExclusiveWith: "--window-id", description: "Window position." },
  ] },
  "set-value": { description: "Set a captured editable element value.", flags: [
    { flag: "--app", valueKind: "string", required: true, description: "Application target." }, { flag: "--element-index", valueKind: "integer", required: true, description: "Snapshot element index." },
    { flag: "--value", valueKind: "string", required: false, mutuallyExclusiveWith: "--value-stdin", description: "Literal value." }, { flag: "--value-stdin", valueKind: "boolean", required: false, mutuallyExclusiveWith: "--value", description: "Read value from stdin." },
    { flag: "--snapshot-id", valueKind: "string", required: false, description: "Snapshot fence." }, { flag: "--window-id", valueKind: "string", required: false, mutuallyExclusiveWith: "--window-index", description: "Window identifier." }, { flag: "--window-index", valueKind: "integer", required: false, mutuallyExclusiveWith: "--window-id", description: "Window position." },
  ], requirements: ["Supply exactly one of --value or --value-stdin."] },
  "type-text": { description: "Type text into an app or captured element.", flags: [{ flag: "--app", valueKind: "string", required: true, description: "Application target." }, { flag: "--text", valueKind: "string", required: false, mutuallyExclusiveWith: "--text-stdin", description: "Literal text." }, { flag: "--text-stdin", valueKind: "boolean", required: false, mutuallyExclusiveWith: "--text", description: "Read text from stdin." }, { flag: "--element-index", valueKind: "integer", required: false, description: "Optional snapshot element index." }, { flag: "--snapshot-id", valueKind: "string", required: false, description: "Snapshot fence." }, { flag: "--window-id", valueKind: "string", required: false, mutuallyExclusiveWith: "--window-index", description: "Window identifier." }, { flag: "--window-index", valueKind: "integer", required: false, mutuallyExclusiveWith: "--window-id", description: "Window position." }], requirements: ["Supply exactly one of --text or --text-stdin.", "--snapshot-id and window flags require --element-index."] },
  "press-key": { description: "Press a key in an app or captured element.", flags: [{ flag: "--app", valueKind: "string", required: true, description: "Application target." }, { flag: "--key", valueKind: "string", required: true, description: "Key to press." }, { flag: "--element-index", valueKind: "integer", required: false, description: "Optional snapshot element index." }, { flag: "--snapshot-id", valueKind: "string", required: false, description: "Snapshot fence." }, { flag: "--window-id", valueKind: "string", required: false, mutuallyExclusiveWith: "--window-index", description: "Window identifier." }, { flag: "--window-index", valueKind: "integer", required: false, mutuallyExclusiveWith: "--window-id", description: "Window position." }], requirements: ["--snapshot-id and window flags require --element-index."] },
  hotkey: { description: "Send a key chord to an app.", flags: [{ flag: "--app", valueKind: "string", required: true, description: "Application target." }, { flag: "--keys", valueKind: "string", required: true, description: "Plus-separated key chord." }], requirements: ["This command takes no snapshot or window flags."] },
  scroll: { description: "Scroll an app or captured element.", flags: [{ flag: "--app", valueKind: "string", required: true, description: "Application target." }, { flag: "--direction", valueKind: "string", required: true, choices: ["up", "down", "left", "right"], description: "Scroll direction." }, { flag: "--amount", valueKind: "integer", required: false, description: "Scroll amount." }, { flag: "--element-index", valueKind: "integer", required: false, description: "Optional snapshot element index." }, { flag: "--snapshot-id", valueKind: "string", required: false, description: "Snapshot fence." }, { flag: "--window-id", valueKind: "string", required: false, mutuallyExclusiveWith: "--window-index", description: "Window identifier." }, { flag: "--window-index", valueKind: "integer", required: false, mutuallyExclusiveWith: "--window-id", description: "Window position." }], requirements: ["--snapshot-id and window flags require --element-index."] },
  drag: { description: "Drag between coordinates or two captured elements.", flags: [{ flag: "--app", valueKind: "string", required: true, description: "Application target." }, { flag: "--from-x", valueKind: "integer", required: false, description: "Starting x coordinate." }, { flag: "--from-y", valueKind: "integer", required: false, description: "Starting y coordinate." }, { flag: "--to-x", valueKind: "integer", required: false, description: "Ending x coordinate." }, { flag: "--to-y", valueKind: "integer", required: false, description: "Ending y coordinate." }, { flag: "--from-element-index", valueKind: "integer", required: false, description: "Starting element index." }, { flag: "--to-element-index", valueKind: "integer", required: false, description: "Ending element index." }, { flag: "--snapshot-id", valueKind: "string", required: false, description: "Snapshot fence for element drag." }, { flag: "--window-id", valueKind: "string", required: false, mutuallyExclusiveWith: "--window-index", description: "Window identifier." }, { flag: "--window-index", valueKind: "integer", required: false, mutuallyExclusiveWith: "--window-id", description: "Window position." }], requirements: ["Choose exactly one form: all four coordinate flags, or both element-index flags.", "Coordinate drag takes no --snapshot-id or window flags."] },
} as const satisfies Record<ComputerSubcommand, ComputerCommandSurfaceEntry>);
export type CommandName = `computer.${ComputerSubcommand}` | "computer";
/*
 * FNXC:ComputerUse 2026-08-13-22:02:
 * A successful action can re-render or refocus the window, so the capture that supplied sparse
 * element indexes is no longer authoritative. Keep this append-only reason so stale replays fail
 * closed and callers must capture again rather than risk acting on a different element.
 */
export const SNAPSHOT_STALE_REASONS = Object.freeze(["not-found", "superseded", "expired", "pid-changed", "window-mismatch", "window-gone", "consumed-by-action"] as const);
export type SnapshotStaleReason = (typeof SNAPSHOT_STALE_REASONS)[number];
export const COMPUTER_TIMEOUTS = Object.freeze({ permissionProbe: 5_000, discovery: 10_000, stateCapture: 20_000, screenshotCapture: 15_000, locatorReplay: 10_000, action: 10_000 });

export type FlatDetails = Record<string, string | number | boolean>;
export interface ComputerError { code: ComputerErrorCode; message: string; remediation?: string; details?: FlatDetails; }
export type ComputerEnvelope<T = unknown> =
  | { schemaVersion: 1; ok: true; command: CommandName; result: T }
  | { schemaVersion: 1; ok: false; command: CommandName; error: ComputerError };
const REMEDIATION_REQUIRED = new Set<ComputerErrorCode>(["UNSUPPORTED_PLATFORM", "PERMISSION_DENIED", "PERMISSION_UNVERIFIED", "SNAPSHOT_REQUIRED", "SNAPSHOT_STALE", "ELEMENT_INDEX_NOT_FOUND", "ELEMENT_UNRESOLVABLE", "AMBIGUOUS_APP", "ACTION_UNSUPPORTED"]);
export class ComputerUseError extends Error {
  constructor(public readonly code: ComputerErrorCode, message: string, public readonly remediation?: string, public readonly details?: FlatDetails) { super(message); }
}
export const successEnvelope = <T>(command: CommandName, result: T): ComputerEnvelope<T> => ({ schemaVersion: 1, ok: true, command, result });
export function failureEnvelope(command: CommandName, error: ComputerError | ComputerUseError): ComputerEnvelope<never> {
  const value: ComputerError = error instanceof ComputerUseError ? { code: error.code, message: error.message, remediation: error.remediation, details: error.details } : error;
  if (REMEDIATION_REQUIRED.has(value.code) && !value.remediation) throw new Error(`Remediation required for ${value.code}`);
  if (value.details && !isFlatDetails(value.details)) throw new Error("Computer error details must be flat");
  return { schemaVersion: 1, ok: false, command, error: value };
}
export function isFlatDetails(value: unknown): value is FlatDetails { return !!value && typeof value === "object" && Object.values(value as object).every((entry) => ["string", "number", "boolean"].includes(typeof entry)); }

export interface Bounds { x: number; y: number; width: number; height: number; }
export interface AppTarget { kind: "bundleId" | "name" | "pid"; raw: string; value: string; }
export interface AppRef { bundleId: string | null; name: string; pid: number; }
export interface WindowRef { windowId: string; windowIndex: number; title: string; bounds: Bounds | null; minimized: boolean; }
export interface ElementLocator { kind: "ax-path"; path: string; role: string; subrole: string | null; identifier: string | null; title: string | null; }
export interface Element { index: number; role: string; title: string | null; value: string | null; label: string | null; enabled: boolean; focused: boolean; bounds: Bounds | null; actions: string[]; locator: ElementLocator; }
export type PermissionCheckStatus = "granted" | "denied" | "unknown";
export interface PermissionCheck { id: "accessibility" | "screen-recording"; status: PermissionCheckStatus; granted: boolean; probed: boolean; probe: string; detail: string | null; remediation: string | null; }
export interface CapabilitiesResult { platform: string; adapterId: string; supported: boolean; actions: string[]; unsupportedActions: string[]; features: { screenshot: boolean; restoreWindow: boolean; stdinSecrets: boolean; crossInvocationSnapshots: boolean }; }
export interface PermissionsResult { platform: string; adapterId: string; supported: boolean; allGranted: boolean; checks: PermissionCheck[]; }
export interface ListAppsResult { apps: AppRef[]; }
export interface ListWindowsResult { app: AppRef; windows: WindowRef[]; }
export interface Screenshot { path: string; width: number | null; height: number | null; verifiedPermission: boolean; }
export interface AppStateResult { app: AppRef; window: WindowRef; snapshot: { snapshotId: string; targetKey: string; windowKey: string; capturedAt: string; expiresAt: string; treeText: string; elementCount: number; truncated: boolean; elements: Element[] }; screenshot: Screenshot | null; screenshotError?: { code: "SCREENSHOT_FAILED" | "PERMISSION_DENIED" | "PERMISSION_UNVERIFIED" | "TIMEOUT"; message: string }; }
/*
 * FNXC:ComputerUse 2026-08-13-22:02:
 * Successful actions burn the app-scoped snapshot fence because they may change the accessible
 * tree. Publishing this field lets callers confirm they must capture again before replaying indexes.
 */
export interface ActionResult { action: string; app: AppRef; snapshotId: string | null; elementIndex: number | null; fromElementIndex: number | null; toElementIndex: number | null; performed: true; snapshotConsumed: boolean; }
export interface SnapshotRecord { snapshotId: string; targetKey: string; windowKey: string; capturedAt: string; expiresAt: string; app: AppRef; window: WindowRef; elementCount: number; elements: Record<string, Element>; }
export const SNAPSHOT_ID_PATTERN = /^cs_[A-Za-z0-9]{10,40}$/;
export const isValidSnapshotId = (value: string | undefined): value is string => typeof value === "string" && SNAPSHOT_ID_PATTERN.test(value);
export const targetKeyForApp = (app: AppRef): string => app.bundleId ? `bundle:${app.bundleId}` : `pid:${app.pid}`;
export const windowKeyFor = (targetKey: string, windowId: string): string => `${targetKey}#${windowId}`;
export const targetKeySlug = (targetKey: string): string => targetKey.replace(/[^A-Za-z0-9._-]/g, "_");

/**
 * FNXC:ComputerUse 2026-08-11-04:19:
 * A dotted display name is valid, so punctuation cannot choose the target kind. Resolution always
 * tries an exact bundle id before an exact unambiguous name, preserving the published precedence.
 */
export function parseAppTarget(raw: string): AppTarget { return raw.startsWith("pid:") ? { kind: "pid", raw, value: raw.slice(4) } : { kind: "name", raw, value: raw }; }
function validLocator(value: unknown): value is ElementLocator { const x = value as ElementLocator; return !!x && x.kind === "ax-path" && typeof x.path === "string" && !!x.path && typeof x.role === "string" && typeof x.subrole !== "undefined" && typeof x.identifier !== "undefined" && typeof x.title !== "undefined"; }
export function isCapabilitiesResult(value: unknown): value is CapabilitiesResult { const x = value as CapabilitiesResult; return !!x && typeof x.platform === "string" && Array.isArray(x.actions) && Array.isArray(x.unsupportedActions) && !!x.features; }
export function isPermissionsResult(value: unknown): value is PermissionsResult { const x = value as PermissionsResult; return !!x && Array.isArray(x.checks) && typeof x.allGranted === "boolean" && x.checks.every((c) => c.granted === (c.status === "granted") && (!c.granted || c.probed)) && (!x.allGranted || x.checks.length > 0 && x.checks.every((c) => c.status === "granted")); }
export function isAppStateResult(value: unknown, screenshotSkipped = false): value is AppStateResult { const x = value as AppStateResult; return !!x && !!x.snapshot && Array.isArray(x.snapshot.elements) && x.snapshot.elements.every((e) => Number.isInteger(e.index) && validLocator(e.locator)) && !(x.screenshot && x.screenshotError) && !(!x.screenshot && !x.screenshotError && !screenshotSkipped); }
export function isActionResult(value: unknown): value is ActionResult { const x = value as ActionResult; if (!x || x.performed !== true || typeof x.snapshotConsumed !== "boolean") return false; if (x.action === "drag") return x.elementIndex === null && ((x.fromElementIndex === null && x.toElementIndex === null) || (typeof x.fromElementIndex === "number" && typeof x.toElementIndex === "number")); if (x.action === "hotkey") return x.snapshotId === null && x.elementIndex === null && x.fromElementIndex === null && x.toElementIndex === null; return x.fromElementIndex === null && x.toElementIndex === null; }
export function validateResult(subcommand: ComputerSubcommand, value: unknown, screenshotSkipped = false): boolean { if (subcommand === "capabilities") return isCapabilitiesResult(value); if (subcommand === "permissions") return isPermissionsResult(value); if (subcommand === "get-app-state") return isAppStateResult(value, screenshotSkipped); if (COMPUTER_ACTIONS.includes(subcommand as ComputerAction)) return isActionResult(value); return !!value && typeof value === "object"; }
export const SECRET_VALUE: unique symbol = Symbol("computer-secret");
export type SecretValue = { readonly [SECRET_VALUE]: true; readonly value: string };
export const secretValue = (value: string): SecretValue => ({ [SECRET_VALUE]: true, value });
export function redact(value: unknown): string { if (typeof value === "object" && value && SECRET_VALUE in value) return "[REDACTED]"; const text = value instanceof Error ? value.message : String(value); return text.replace(/[^\s]{8,}/g, "[REDACTED]"); }
