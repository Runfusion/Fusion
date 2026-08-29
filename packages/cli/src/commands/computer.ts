import { result } from "../output.js";
import { MacosComputerAdapter } from "./computer/adapter-macos.js";
import { resolveComputerAdapter, type ComputerClock } from "./computer/adapter-registry.js";
import type { ComputerAdapter, ResolvedComputerElement, ResolvedComputerWindow } from "./computer/adapter.js";
import { createComputerSnapshotStore, type ComputerSnapshotStore } from "./computer/snapshot-store.js";
import { resolveComputerStateRoot } from "./computer/state-root.js";
import { COMPUTER_COMMAND_SURFACE, COMPUTER_SUBCOMMANDS, ComputerUseError, failureEnvelope, isValidSnapshotId, parseAppTarget, successEnvelope, validateResult, type ActionResult, type AppRef, type CommandName, type ComputerSubcommand } from "./computer/contract.js";

export interface ComputerCommandOptions { platform?: string; projectRoot?: string; adapter?: ComputerAdapter; store?: ComputerSnapshotStore; clock?: ComputerClock; stdout?: (text: string) => void; stderr?: (text: string) => void; stdin?: () => Promise<string>; }
export type ComputerHandler = (args: string[], options: ComputerCommandOptions) => Promise<unknown>;
const command = (subcommand: ComputerSubcommand): CommandName => `computer.${subcommand}`;
const emit = (value: unknown, json: boolean, options: ComputerCommandOptions): void => { const write = options.stdout ?? result; if (json) write(`${JSON.stringify(value)}\n`); else write(`${JSON.stringify(value, null, 2)}\n`); };
const fail = (name: CommandName, error: unknown, json: boolean, options: ComputerCommandOptions): number => { const e = error instanceof ComputerUseError ? error : new ComputerUseError("INTERNAL", "Computer command failed unexpectedly."); const envelope = failureEnvelope(name, e); if (json) emit(envelope, true, options); else (options.stderr ?? console.error)(`error: ${e.code}: ${e.message}${e.remediation ? `\n${e.remediation}` : ""}`); return 1; };
function value(args: string[], flag: string): string | undefined { const i = args.indexOf(flag); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined; }
function number(args: string[], flag: string): number | undefined { const raw = value(args, flag); if (raw === undefined) return undefined; const parsed = Number(raw); if (!Number.isInteger(parsed) || parsed < 0) throw new ComputerUseError("INVALID_ARGUMENTS", `Invalid ${flag}.`); return parsed; }
function adapterFor(options: ComputerCommandOptions): ComputerAdapter { if (options.adapter) return options.adapter; return resolveComputerAdapter({ platform: options.platform, projectRoot: options.projectRoot!, clock: options.clock, macosAdapterFactory: ({ seam, clock, projectRoot }) => new MacosComputerAdapter({ seam, clock, projectRoot }) }); }
function storeFor(options: ComputerCommandOptions): ComputerSnapshotStore { return options.store ?? createComputerSnapshotStore({ projectRoot: options.projectRoot!, now: options.clock ? () => options.clock!.now() : undefined }); }
async function appFor(adapter: ComputerAdapter, raw: string): Promise<AppRef> { const target = parseAppTarget(raw); const apps = (await adapter.listApps()).apps; const matches = target.kind === "pid" ? apps.filter((x) => String(x.pid) === target.value) : (() => { const byBundle = apps.filter((x) => x.bundleId === target.value); return byBundle.length ? byBundle : apps.filter((x) => x.name === target.value); })(); if (!matches.length) throw new ComputerUseError("APP_NOT_FOUND", `No running app matches ${raw}.`); if (matches.length > 1) throw new ComputerUseError("AMBIGUOUS_APP", `More than one app matches ${raw}.`, "Use a bundle id or pid target.", { candidateCount: matches.length }); return matches[0]; }
async function requireElements(args: string[], indexes: readonly number[], adapter: ComputerAdapter, store: ComputerSnapshotStore, app: AppRef): Promise<{ record: Awaited<ReturnType<ComputerSnapshotStore["resolve"]>>; window: ResolvedComputerWindow; elements: ResolvedComputerElement[] }> {
  if (!indexes.length) throw new ComputerUseError("INVALID_ARGUMENTS", "At least one --element-index is required.");
  const id = value(args, "--snapshot-id");
  if (id !== undefined && !isValidSnapshotId(id)) throw new ComputerUseError("INVALID_ARGUMENTS", "Invalid --snapshot-id.", undefined, { reason: "snapshot-id-format" });
  const windowId = value(args, "--window-id");
  const windowIndex = number(args, "--window-index");
  if (windowId && windowIndex !== undefined) throw new ComputerUseError("INVALID_ARGUMENTS", "Window flags are mutually exclusive.");
  // A supplied window index is resolved before snapshot lookup, then asserted against its recorded window.
  const target = parseAppTarget(app.bundleId ?? `pid:${app.pid}`);
  const assertedWindowId = windowId ?? (windowIndex !== undefined ? (await adapter.resolveWindow(target, { windowIndex })).window.windowId : undefined);
  // Resolve the optimistic snapshot fence once. Pair actions must never mix endpoints from concurrent latest-pointer updates.
  const record = await store.resolve({ app, snapshotId: id, assertedWindowId });
  const rawElements = indexes.map((index) => store.getElement(record, index));
  let window: ResolvedComputerWindow;
  try { window = await adapter.resolveWindow(target, { windowId: record.window.windowId }); }
  catch (error) { if (error instanceof ComputerUseError && error.code === "WINDOW_NOT_FOUND") throw new ComputerUseError("SNAPSHOT_STALE", "Snapshot window no longer exists; re-run fn computer get-app-state.", "Re-run fn computer get-app-state.", { reason: "window-gone", snapshotId: record.snapshotId }); throw error; }
  const elements = await Promise.all(rawElements.map(async (raw) => {
    try {
      const replayed = await adapter.resolveLocator(window, raw.locator);
      // Preserve sparse snapshot identity while using bounds observed during this replay.
      return { ...replayed, element: { ...raw, ...replayed.element, index: raw.index, locator: raw.locator } };
    } catch (error) {
      if (error instanceof ComputerUseError && error.code === "ELEMENT_UNRESOLVABLE") {
        throw new ComputerUseError(error.code, error.message, error.remediation, { snapshotId: record.snapshotId, elementIndex: raw.index });
      }
      throw error;
    }
  }));
  return { record, window, elements };
}
async function requireElement(args: string[], adapter: ComputerAdapter, store: ComputerSnapshotStore, app: AppRef): Promise<{ record: Awaited<ReturnType<ComputerSnapshotStore["resolve"]>>; window: ResolvedComputerWindow; element: ResolvedComputerElement }> {
  const index = number(args, "--element-index");
  if (index === undefined) throw new ComputerUseError("INVALID_ARGUMENTS", "--element-index is required.");
  const resolved = await requireElements(args, [index], adapter, store, app);
  return { record: resolved.record, window: resolved.window, element: resolved.elements[0]! };
}
async function optionalElement(args: string[], adapter: ComputerAdapter, store: ComputerSnapshotStore, app: AppRef) { return value(args, "--element-index") === undefined ? undefined : requireElement(args, adapter, store, app); }

/**
 * FNXC:ComputerUse 2026-08-13-22:02:
 * This is the sole action completion seam: only a successful adapter call may burn the app fence.
 * Requiring a new capture prevents a second sparse index from silently targeting a different element
 * after the first action changed focus, navigation, scrolling, or the rendered accessibility tree.
 */
async function finishAction(result: ActionResult, store: ComputerSnapshotStore, app: AppRef): Promise<ActionResult> {
  const snapshotConsumed = await store.consume(app, result.snapshotId ?? undefined, true);
  return { ...result, snapshotConsumed };
}

/**
 * FNXC:ComputerUse 2026-08-14-00:35:
 * Resolution, locator replay, OS action, and consumption must remain under one app-scoped fence.
 */
async function fencedAction<T extends ActionResult>(store: ComputerSnapshotStore, app: AppRef, operation: () => Promise<T>): Promise<ActionResult> {
  return store.withAppFence(app, async () => finishAction(await operation(), store, app));
}

export const COMPUTER_HANDLERS: Record<ComputerSubcommand, ComputerHandler> = {
  capabilities: async (_args, o) => adapterFor(o).capabilities(), permissions: async (_args, o) => adapterFor(o).permissions(),
  "list-apps": async (_args, o) => adapterFor(o).listApps(),
  "list-windows": async (args, o) => { const raw = value(args, "--app"); if (!raw) throw new ComputerUseError("INVALID_ARGUMENTS", "--app is required."); const adapter = adapterFor(o); return adapter.listWindows(parseAppTarget(raw)); },
  "get-app-state": async (args, o) => { const raw = value(args, "--app"); if (!raw) throw new ComputerUseError("INVALID_ARGUMENTS", "--app is required."); if (value(args, "--window-id") && value(args, "--window-index")) throw new ComputerUseError("INVALID_ARGUMENTS", "Window flags are mutually exclusive."); const adapter = adapterFor(o), app = await appFor(adapter, raw), store = storeFor(o); return store.withAppFence(app, async () => { const state = await adapter.captureState(parseAppTarget(raw), { windowId: value(args, "--window-id"), windowIndex: number(args, "--window-index"), screenshot: !args.includes("--no-screenshot"), restoreWindow: args.includes("--restore-window") }); const record = await store.persist({ app: state.app, window: state.window, elementCount: state.snapshot.elementCount, elements: state.snapshot.elements, capturedAt: state.snapshot.capturedAt }, true); state.snapshot.snapshotId = record.snapshotId; state.snapshot.targetKey = record.targetKey; state.snapshot.windowKey = record.windowKey; state.snapshot.capturedAt = record.capturedAt; state.snapshot.expiresAt = record.expiresAt; return state; }); },
  click: async (args, o) => { const raw = value(args, "--app"); if (!raw) throw new ComputerUseError("INVALID_ARGUMENTS", "--app is required."); const adapter = adapterFor(o), app = await appFor(adapter, raw), store = storeFor(o); return fencedAction(store, app, async () => { const item = await requireElement(args, adapter, store, app); return adapter.click({ app, window: item.window, element: item.element, snapshotId: item.record.snapshotId }); }); },
  "set-value": async (args, o) => { const raw = value(args, "--app"), text = value(args, "--value"); if (!raw || (!text && !args.includes("--value-stdin")) || (text && args.includes("--value-stdin"))) throw new ComputerUseError("INVALID_ARGUMENTS", "--app and exactly one value source are required."); const secret = args.includes("--value-stdin") ? await (o.stdin ?? (async () => ""))() : text!; const adapter = adapterFor(o), app = await appFor(adapter, raw), store = storeFor(o); return fencedAction(store, app, async () => { const item = await requireElement(args, adapter, store, app); return adapter["set-value"]({ app, window: item.window, element: item.element, snapshotId: item.record.snapshotId, value: secret }); }); },
  "type-text": async (args, o) => targetedOrUntargeted("type-text", args, o), "press-key": async (args, o) => targetedOrUntargeted("press-key", args, o), scroll: async (args, o) => targetedOrUntargeted("scroll", args, o),
  hotkey: async (args, o) => { const raw = value(args, "--app"), keys = value(args, "--keys"); if (!raw || !keys) throw new ComputerUseError("INVALID_ARGUMENTS", "--app and --keys are required."); const adapter = adapterFor(o), app = await appFor(adapter, raw), store = storeFor(o); return fencedAction(store, app, () => adapter.hotkey({ app, keys: keys.split("+") })); },
  drag: async (args, o) => {
    const raw = value(args, "--app"); if (!raw) throw new ComputerUseError("INVALID_ARGUMENTS", "--app is required.");
    const coordinateFlags = ["--from-x", "--from-y", "--to-x", "--to-y"];
    const hasCoordinates = coordinateFlags.some((flag) => value(args, flag) !== undefined);
    const from = number(args, "--from-element-index"), to = number(args, "--to-element-index");
    const hasElements = from !== undefined || to !== undefined;
    if (hasCoordinates && hasElements) throw new ComputerUseError("INVALID_ARGUMENTS", "Coordinate and element drag forms are mutually exclusive.");
    const adapter = adapterFor(o), app = await appFor(adapter, raw);
    if (hasCoordinates) {
      const coordinates = coordinateFlags.map((flag) => number(args, flag));
      if (coordinates.some((item) => item === undefined) || value(args, "--snapshot-id") || value(args, "--window-id") || value(args, "--window-index")) throw new ComputerUseError("INVALID_ARGUMENTS", "Coordinate drag requires all coordinates and takes no snapshot or window flags.");
      const store = storeFor(o);
      return fencedAction(store, app, () => adapter.drag({ app, snapshotId: null, fromX: coordinates[0]!, fromY: coordinates[1]!, toX: coordinates[2]!, toY: coordinates[3]! }));
    }
    if (from === undefined || to === undefined) throw new ComputerUseError("INVALID_ARGUMENTS", "Drag requires either all coordinates or both element indexes.");
    // Both endpoints share one resolved record and one replayed window, even if another capture updates latest mid-action.
    const store = storeFor(o);
    return fencedAction(store, app, async () => { const resolved = await requireElements(args, [from, to], adapter, store, app); return adapter.drag({ app, snapshotId: resolved.record.snapshotId, window: resolved.window, from: resolved.elements[0]!, to: resolved.elements[1]! }); });
  },
};
function validateFlags(name: ComputerSubcommand, args: string[]): void {
  const present = (flag: string) => args.includes(flag);
  const supplied = (flag: string) => {
    if (!present(flag)) return undefined;
    const parsed = value(args, flag);
    if (parsed === undefined) throw new ComputerUseError("INVALID_ARGUMENTS", `${flag} requires a value.`);
    return parsed;
  };
  const requiredApp = () => { if (!supplied("--app")) throw new ComputerUseError("INVALID_ARGUMENTS", "--app is required."); };
  const validateWindow = () => {
    supplied("--window-id");
    if (present("--window-index")) number(args, "--window-index");
    if (present("--window-id") && present("--window-index")) throw new ComputerUseError("INVALID_ARGUMENTS", "Window flags are mutually exclusive.");
  };
  const validateSnapshot = () => { if (present("--snapshot-id") && !isValidSnapshotId(supplied("--snapshot-id"))) throw new ComputerUseError("INVALID_ARGUMENTS", "Invalid --snapshot-id.", undefined, { reason: "snapshot-id-format" }); };
  const validateElement = (flag = "--element-index") => { if (!present(flag)) throw new ComputerUseError("INVALID_ARGUMENTS", `${flag} is required.`); number(args, flag); };
  if (name === "capabilities" || name === "permissions" || name === "list-apps") return;
  requiredApp();
  if (name === "list-windows") return;
  if (name === "get-app-state") { validateWindow(); return; }
  if (name === "click") { validateElement(); validateWindow(); validateSnapshot(); return; }
  if (name === "set-value") {
    validateElement(); validateWindow(); validateSnapshot();
    if (present("--value")) supplied("--value");
    if (present("--value") === present("--value-stdin")) throw new ComputerUseError("INVALID_ARGUMENTS", "Exactly one value source is required.");
    return;
  }
  if (name === "type-text" || name === "press-key" || name === "scroll") {
    const hasElement = present("--element-index");
    if (hasElement) number(args, "--element-index");
    validateWindow(); validateSnapshot();
    if (!hasElement && (present("--snapshot-id") || present("--window-id") || present("--window-index"))) throw new ComputerUseError("INVALID_ARGUMENTS", "Snapshot and window flags require --element-index.");
    if (name === "type-text") {
      if (present("--text")) supplied("--text");
      if (present("--text") === present("--text-stdin")) throw new ComputerUseError("INVALID_ARGUMENTS", "Exactly one text source is required.");
    } else if (name === "press-key") { if (!supplied("--key")) throw new ComputerUseError("INVALID_ARGUMENTS", "--key is required."); }
    else {
      const direction = supplied("--direction");
      if (!direction || !["up", "down", "left", "right"].includes(direction)) throw new ComputerUseError("INVALID_ARGUMENTS", "A valid --direction is required.");
      if (present("--amount")) number(args, "--amount");
    }
    return;
  }
  if (name === "hotkey") {
    if (!supplied("--keys")) throw new ComputerUseError("INVALID_ARGUMENTS", "--keys is required.");
    if (present("--snapshot-id") || present("--window-id") || present("--window-index")) throw new ComputerUseError("INVALID_ARGUMENTS", "Hotkey takes no snapshot or window flags.");
    return;
  }
  // Drag's mutually exclusive forms must be validated before resolving the app.
  const coordinateFlags = ["--from-x", "--from-y", "--to-x", "--to-y"];
  const anyCoordinates = coordinateFlags.some(present);
  const anyElements = present("--from-element-index") || present("--to-element-index");
  if (anyCoordinates && anyElements) throw new ComputerUseError("INVALID_ARGUMENTS", "Coordinate and element drag forms are mutually exclusive.");
  if (anyCoordinates) {
    if (!coordinateFlags.every(present)) throw new ComputerUseError("INVALID_ARGUMENTS", "Coordinate drag requires all coordinates.");
    coordinateFlags.forEach((flag) => number(args, flag));
    if (present("--snapshot-id") || present("--window-id") || present("--window-index")) throw new ComputerUseError("INVALID_ARGUMENTS", "Coordinate drag takes no snapshot or window flags.");
  } else {
    if (!present("--from-element-index") || !present("--to-element-index")) throw new ComputerUseError("INVALID_ARGUMENTS", "Drag requires either all coordinates or both element indexes.");
    number(args, "--from-element-index"); number(args, "--to-element-index"); validateWindow(); validateSnapshot();
  }
}

async function targetedOrUntargeted(kind: "type-text" | "press-key" | "scroll", args: string[], o: ComputerCommandOptions): Promise<ActionResult> {
  const raw = value(args, "--app"); if (!raw) throw new ComputerUseError("INVALID_ARGUMENTS", "--app is required.");
  const adapter = adapterFor(o), app = await appFor(adapter, raw), store = storeFor(o);
  return fencedAction(store, app, async () => {
  const item = await optionalElement(args, adapter, store, app);
  if (!item && (value(args, "--snapshot-id") || value(args, "--window-id") || value(args, "--window-index"))) throw new ComputerUseError("INVALID_ARGUMENTS", "Snapshot and window flags require --element-index.");
  if (kind === "type-text") {
    const direct = value(args, "--text"), fromStdin = args.includes("--text-stdin");
    if ((direct === undefined && !fromStdin) || (direct !== undefined && fromStdin)) throw new ComputerUseError("INVALID_ARGUMENTS", "Exactly one text source is required.");
    const text = fromStdin ? await (o.stdin ?? (async () => ""))() : direct!;
    return adapter["type-text"]({ app, text, ...(item ? { window: item.window, element: item.element, snapshotId: item.record.snapshotId } : {}) });
  }
  if (kind === "press-key") { const key = value(args, "--key"); if (!key) throw new ComputerUseError("INVALID_ARGUMENTS", "--key is required."); return adapter["press-key"]({ app, key, ...(item ? { window: item.window, element: item.element, snapshotId: item.record.snapshotId } : {}) }); }
  const direction = value(args, "--direction"); if (!direction || !["up", "down", "left", "right"].includes(direction)) throw new ComputerUseError("INVALID_ARGUMENTS", "A valid --direction is required.");
  return adapter.scroll({ app, direction: direction as "up" | "down" | "left" | "right", amount: number(args, "--amount") ?? 3, ...(item ? { window: item.window, element: item.element, snapshotId: item.record.snapshotId } : {}) });
  });
}
export async function runComputer(args: string[], options: ComputerCommandOptions = {}): Promise<number> {
  const json = args.includes("--json");
  const subIndex = args.findIndex((item) => item !== "--json");
  const sub = subIndex < 0 ? undefined : args[subIndex];
  if (args.includes("--help") || args.includes("-h")) {
    emit(`fn computer <${Object.keys(COMPUTER_COMMAND_SURFACE).join("|")}>\nUse snapshot → act → snapshot; --snapshot-id fences the latest capture.`, false, options);
    return 0;
  }
  if (!sub) return json
    ? fail("computer", new ComputerUseError("INVALID_ARGUMENTS", "A computer subcommand is required."), true, options)
    : (emit(`fn computer <${Object.keys(COMPUTER_COMMAND_SURFACE).join("|")}>\nUse snapshot → act → snapshot; --snapshot-id fences the latest capture.`, false, options), 0);
  if (!(COMPUTER_SUBCOMMANDS as readonly string[]).includes(sub)) return fail("computer", new ComputerUseError("INVALID_ARGUMENTS", `Unknown computer subcommand: ${sub}.`), json, options);
  const name = sub as ComputerSubcommand;
  const handlerArgs = args.filter((_item, index) => index !== subIndex && _item !== "--json");
  try {
    // C10 stage 2 is deliberately complete and precedes adapter construction, filesystem, and OS discovery.
    validateFlags(name, handlerArgs);
    const projectRoot = resolveComputerStateRoot(options.projectRoot ?? process.cwd());
    const resolvedOptions = { ...options, projectRoot };
    const payload = await COMPUTER_HANDLERS[name](handlerArgs, resolvedOptions);
    if (!validateResult(name, payload, handlerArgs.includes("--no-screenshot"))) throw new ComputerUseError("INTERNAL", "Computer command produced an invalid contract result.");
    emit(successEnvelope(command(name), payload), json, options);
    return 0;
  } catch (error) { return fail(command(name), error, json, options); }
}
