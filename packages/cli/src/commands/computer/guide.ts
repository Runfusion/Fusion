import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMPUTER_COMMAND_SURFACE, COMPUTER_ERROR_CODES, type ComputerCommandSurfaceEntry, type ComputerErrorCode, type ComputerSubcommand } from "./contract.js";

export const COMPUTER_USE_GUIDE_HEADINGS = ["Platform support & permissions", "The snapshot → act → snapshot loop", "App selection precedence", "Element indexes are snapshot-scoped and sparse", "Command reference", "JSON envelope & error codes", "Secrets via stdin", "Permission remediation"] as const;

export function resolveComputerUseGuideVersion(): string {
  try {
    const manifest = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "package.json");
    return (JSON.parse(readFileSync(manifest, "utf8")) as { version?: string }).version ?? "unknown";
  } catch { return "unknown"; }
}

/**
 * FNXC:ComputerUseSkill 2026-08-11-07:19:
 * The binary renders this complete guide in-process from the versioned descriptor, never a committed
 * markdown guide. It emits every command, flag, and error code without caps or elision; descriptor
 * anchors establish drift while guide tests establish this completeness link and version match.
 */
export function renderComputerUseGuide(
  surface: Record<ComputerSubcommand, ComputerCommandSurfaceEntry> = COMPUTER_COMMAND_SURFACE,
  errorCodes: readonly ComputerErrorCode[] = COMPUTER_ERROR_CODES,
  version = resolveComputerUseGuideVersion(),
): string {
  const commands = Object.entries(surface).map(([name, entry]) => {
    const flags = entry.flags.length
      ? entry.flags.map((flag) => `- \`${flag.flag}\`${flag.required ? " (required)" : ""}${flag.choices ? `; choices: ${flag.choices.join(", ")}` : ""}${flag.mutuallyExclusiveWith ? `; mutually exclusive with \`${flag.mutuallyExclusiveWith}\`` : ""} — ${flag.description}`).join("\n")
      : "- No command-specific flags.";
    const requirements = entry.requirements?.length
      ? `\nRules:\n${entry.requirements.map((rule) => `- ${rule}`).join("\n")}`
      : "";
    return `### fn computer ${name}\n${entry.description}\n${flags}${requirements}`;
  }).join("\n\n");
  return `# Fusion computer-use guide (v${version})

## Platform support & permissions
macOS is first-class. Other platforms report \`supported: false\` from capabilities and actions fail with \`UNSUPPORTED_PLATFORM\`; stop rather than retrying.

## The snapshot → act → snapshot loop
Capture state, act on that snapshot, then capture again. A successful action consumes its capture, so the next element action requires a fresh \`fn computer get-app-state\`; re-capture after focus changes, navigation, scrolling, or re-rendering.

## App selection precedence
Targets resolve by exact bundle id, then exact unambiguous app name, then \`pid:<n>\`. Ambiguous names return \`AMBIGUOUS_APP\`.

## Element indexes are snapshot-scoped and sparse
Indexes are valid only for their capture and can be sparse. Read them from \`snapshot.elements[].index\`; never derive one from \`elementCount\`, position, or bounds. \`--snapshot-id\` fences a capture, stale fences return \`SNAPSHOT_STALE\` including \`consumed-by-action\`, and successful action results report \`snapshotConsumed: true\`.

## Command reference
${commands}

## JSON envelope & error codes
Every JSON response has \`schemaVersion: 1\`, \`ok\`, and \`command\`, followed by \`result\` or \`error\` (code, message, optional remediation/details).
${errorCodes.map((code) => `- \`${code}\``).join("\n")}

## Secrets via stdin
Use the stdin secret options for editable values and typed text; never put secrets in argv.

## Permission remediation
When a permission error includes remediation, perform that remediation, re-check permissions, and re-capture state. Prefer semantic actions such as click and set-value over raw keyboard input.
`;
}
