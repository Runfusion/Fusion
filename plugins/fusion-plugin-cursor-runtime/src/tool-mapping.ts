/*
FNXC:CursorMcpBridge 2026-08-15-21:20:
FN-9098 observed Cursor stream tool names as <serverKey>-<toolName>.
Normalize only that session-owned prefix so Fusion callbacks continue to receive bare fn_* tool names.
*/
export function toCursorToolName(fnName: string, serverKey: string): string { return `${serverKey}-${fnName}`; }
export function fromCursorToolName(observedName: string, serverKey: string): string {
  const exact = `${serverKey}-`;
  if (observedName.startsWith(exact)) return observedName.slice(exact.length);
  return observedName.replace(new RegExp(`^mcp[_-]*${serverKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[_-]*`), "");
}
