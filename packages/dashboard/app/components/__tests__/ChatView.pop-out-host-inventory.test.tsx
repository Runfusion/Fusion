import { describe, expect, it } from "vitest";
import { listComponentFiles, readAppFile } from "../../test/cssFixture";

function productionAppSourceFiles(): string[] {
  return [
    "App.tsx",
    ...listComponentFiles()
      .filter((path) => !path.split("/").some((segment) => segment === "__tests__" || segment === "__mocks__"))
      .map((path) => `components/${path}`),
  ].sort();
}

describe("ChatView pop-out host inventory", () => {
  /*
  FNXC:ChatWindows 2026-08-23-03:33:
  FN-169 uses this source census to prevent a new ChatView host from silently omitting the
  pop-out trigger. The menu remains owned by ChatView rather than being duplicated by a host.

  FNXC:MainViewKeepAlive 2026-08-30-19:05:
  Embedded Chat now mounts through the retained main-view registry rather than MainContent's
  exclusive switch, so this inventory protects the new host's pop-out wiring.

  FNXC:DashboardTests 2026-09-01-00:46:
  Static host discovery must use the module-relative dashboard fixture helpers so root-anchored
  test runs inspect the shipped app source instead of an incidental current working directory.
  */
  it("keeps all production ChatView hosts wired to the pop-out trigger", () => {
    const sourceFiles = productionAppSourceFiles();
    const mounts = sourceFiles.filter((file) => readAppFile(file).includes("<ChatView"));
    expect(mounts).toEqual(["App.tsx", "components/PoppedOutChatWindows.tsx", "components/dashboard/MainViewKeepAlive.tsx", "components/overflowViewRegistry.tsx"]);
    for (const file of mounts) expect(readAppFile(file)).toContain("onOpenSessionInNewWindow");

    const popOut = readAppFile("components/PoppedOutChatWindows.tsx");
    expect(popOut).toContain("initialDirectSession={entry.session}");
    expect(popOut).toContain("initialDirectSessionNonce={entry.focusNonce}");
    expect(popOut).toContain("raiseToFrontSignal={entry.focusNonce}");
    expect(popOut).toContain("cascadeOffsetIndex={entry.cascadeSlot + 1}");
    expect(popOut).toContain("hidden={entry.minimized}");
    expect(popOut).toContain("active={!entry.minimized}");
    expect(popOut).toContain("findActive={!entry.minimized}");
    const chatView = readAppFile("components/ChatView.tsx");
    const affordanceFiles = sourceFiles.filter((file) => readAppFile(file).includes("chat-context-open-window"));
    expect(affordanceFiles).toEqual(["components/ChatView.tsx"]);
    const copyConversationIdFiles = sourceFiles.filter((file) => readAppFile(file).includes("chat-context-copy-id"));
    expect(copyConversationIdFiles).toEqual(["components/ChatView.tsx"]);

    /*
    FNXC:ChatWindows 2026-08-27-09:23:
    The empty-state New Chat button cannot coexist with a selected detail pane, so its modifier path is covered structurally here rather than with an impossible duplicate render state.
    */
    for (const testId of ["chat-new-btn", "chat-new-btn-empty"]) {
      const testIdPosition = chatView.indexOf(`data-testid="${testId}"`);
      expect(testIdPosition).toBeGreaterThanOrEqual(0);
      const buttonStart = chatView.lastIndexOf("<button", testIdPosition);
      expect(chatView.slice(buttonStart, testIdPosition)).toContain("onClick={handleNewChat}");
    }
  });
});
