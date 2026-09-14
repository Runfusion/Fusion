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
  FNXC:ChatSurfaceUnification 2026-09-14-11:35:
  The source census prevents a new ChatView host from omitting detached-conversation routing. Only the mobile keep-alive owner, expanded registry renderer, and detached window renderer are valid production mounts.

  FNXC:DashboardTests 2026-09-01-00:46:
  Static host discovery must use the module-relative dashboard fixture helpers so root-anchored
  test runs inspect the shipped app source instead of an incidental current working directory.
  */
  it("keeps all production ChatView hosts wired to the pop-out trigger", () => {
    const sourceFiles = productionAppSourceFiles();
    /* `<ChatViewContent` is ChatView's own internal body, so match the exported element itself. */
    const mounts = sourceFiles.filter((file) => /<ChatView[\s/>]/.test(readAppFile(file)));
    expect(mounts).toEqual(["components/PoppedOutChatWindows.tsx", "components/dashboard/MainViewKeepAlive.tsx", "components/overflowViewRegistry.tsx"]);
    for (const file of mounts) expect(readAppFile(file)).toContain("onOpenSessionInNewWindow");

    const popOut = readAppFile("components/PoppedOutChatWindows.tsx");
    expect(popOut).toContain("initialDirectSession={entry.session}");
    expect(popOut).toContain("initialDirectSessionNonce={entry.focusNonce}");
    expect(popOut).toContain("raiseToFrontSignal={entry.focusNonce}");
    expect(popOut).toContain("cascadeOffsetIndex={entry.cascadeSlot}");
    expect(popOut).toContain('surfaceGroup="chat"');
    expect(popOut).not.toContain("hidden={entry.");
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
      /* Chat's shared header uses the reusable action primitives, so accept any of the button elements it renders. */
      const buttonStart = Math.max(
        ...["<button", "<AlphaButton", "<ViewActionButton"].map((element) => chatView.lastIndexOf(element, testIdPosition)),
      );
      expect(buttonStart).toBeGreaterThanOrEqual(0);
      expect(chatView.slice(buttonStart, testIdPosition)).toContain("onClick={handleNewChat}");
    }
  });
});
