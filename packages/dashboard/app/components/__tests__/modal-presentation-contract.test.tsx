import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const component = (name: string) => readFileSync(resolve(__dirname, "..", `${name}.tsx`), "utf8");
const projectDoc = (name: string) => readFileSync(resolve(__dirname, "..", "..", "..", "..", "..", "docs", name), "utf8");
const inventory = () => projectDoc("dashboard-modal-inventory.md");
const guide = () => projectDoc("dashboard-guide.md");

/*
FNXC:ModalTouchGeometry 2026-07-26-19:25:
FN-8621 publishes one source-level contract for complex presentations. Keep this intentionally
structural: it protects the shared host and explicit presentation gates without mounting slow,
duplicated modal fixtures for every surface.
*/
describe("complex modal presentation contract", () => {
  it("keeps each floating complex modal on FloatingWindow with persisted geometry", () => {
    const floatingSurfaces = [
      ["CreateRoomModal", "floating-window:create-room"],
      ["AgentDetailView", "floating-window:${floatingWindowKey}"],
      ["GitHubImportModal", "floating-window:github-import"],
      ["TerminalModal", "fusion:terminal-float-geometry-"],
      ["RightDockExpandModal", "fusion:right-dock-expand-modal-geometry"],
    ] as const;

    for (const [surface, geometryKey] of floatingSurfaces) {
      const source = component(surface);
      expect(source, surface).toContain("<FloatingWindow");
      expect(source, surface).toContain("persistGeometryKey");
      expect(source, surface).toContain(geometryKey);
    }
  });

  it("requires explicit outside-dismiss preservation rather than relying on the default", () => {
    expect(component("CreateRoomModal")).toContain("closeOnOutsidePointerDown");
    expect(component("GitHubImportModal")).toContain("closeOnOutsidePointerDown={dismissOnOutsidePointerDown}");
    expect(component("AgentDetailView")).toContain("backdropMouseHandlers");
  });

  it("retains documented embedded, docked, and dock-origin presentation gates", () => {
    const agentDetail = component("AgentDetailView");
    const githubImport = component("GitHubImportModal");
    const terminal = component("TerminalModal");
    const rightDock = component("RightDockExpandModal");

    expect(agentDetail).toContain("if (inline)");
    expect(githubImport).toContain("useEmbeddedPresentation(presentation)");
    expect(githubImport).toContain("if (isEmbedded)");
    expect(githubImport).toContain("resizePersistEnabled");
    expect(terminal).toContain("const terminalPanel = isFloatingMode ? (");
    expect(terminal).toContain("isDockedMode");
    expect(rightDock).toContain("surface: \"expand\"");
  });

  it("keeps the canonical guide and inventory reconciled with complex-modal migration state", () => {
    const currentInventory = inventory();
    const currentGuide = guide();

    for (const surface of ["CreateRoomModal.tsx", "AgentDetailView.tsx", "GitHubImportModal.tsx", "TerminalModal.tsx", "RightDockExpandModal.tsx"]) {
      const row = currentInventory.split("\n").find((line) => line.startsWith(`| \`${surface}\``));
      expect(row, surface).toBeDefined();
      expect(row, surface).toContain("already migrated");
      expect(row, surface).not.toContain("migrate →");
    }

    expect(currentGuide).toContain("Supported presentation exceptions");
    expect(currentGuide).toContain("floating-window:create-room");
    expect(currentGuide).toContain("`closeOnOutsidePointerDown` defaults **off**");
    expect(currentGuide).toContain("TerminalModal");
    expect(currentGuide).toContain("AgentDetailView");
    expect(currentGuide).toContain("GitHubImportModal");
    expect(currentGuide).toContain("RightDockExpandModal");
  });
});
