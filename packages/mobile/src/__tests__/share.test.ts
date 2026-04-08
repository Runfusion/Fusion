import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  isNativePlatform: vi.fn(() => false),
  nativeShare: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: mockState.isNativePlatform,
  },
}));

vi.mock("@capacitor/share", () => ({
  Share: {
    share: mockState.nativeShare,
  },
}));

import { ShareManager } from "../plugins/share.js";

describe("ShareManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.isNativePlatform.mockReturnValue(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Native share: Share.share() called with correct title, text (truncated), and deep link URL", async () => {
    mockState.isNativePlatform.mockReturnValue(true);
    mockState.nativeShare.mockResolvedValue({ activityType: "copy" });
    const manager = new ShareManager();
    const longDescription = "x".repeat(250);

    await manager.shareTask({ id: "FN-123", description: longDescription });

    expect(mockState.nativeShare).toHaveBeenCalledWith({
      title: "Task FN-123",
      text: `${"x".repeat(200)}...`,
      url: "fusion://task/FN-123",
    });
  });

  it("Native share: emits share:success and returns true when share completes with activityType", async () => {
    mockState.isNativePlatform.mockReturnValue(true);
    mockState.nativeShare.mockResolvedValue({ activityType: "mail" });
    const manager = new ShareManager();
    const onSuccess = vi.fn();
    manager.on("share:success", onSuccess);

    const result = await manager.shareTask({
      id: "FN-123",
      title: "Test Task",
      description: "Short description",
    });

    expect(result).toBe(true);
    expect(onSuccess).toHaveBeenCalledWith({ taskId: "FN-123" });
  });

  it("Native share: emits share:cancelled and returns false when activityType is undefined", async () => {
    mockState.isNativePlatform.mockReturnValue(true);
    mockState.nativeShare.mockResolvedValue({});
    const manager = new ShareManager();
    const onCancelled = vi.fn();
    manager.on("share:cancelled", onCancelled);

    const result = await manager.shareTask({
      id: "FN-124",
      description: "Short description",
    });

    expect(result).toBe(false);
    expect(onCancelled).toHaveBeenCalledWith({ taskId: "FN-124" });
  });

  it("Native share: emits share:error and returns false when Share.share() throws", async () => {
    mockState.isNativePlatform.mockReturnValue(true);
    mockState.nativeShare.mockRejectedValue(new Error("share failed"));
    const manager = new ShareManager();
    const onError = vi.fn();
    manager.on("share:error", onError);

    const result = await manager.shareTask({
      id: "FN-125",
      description: "Short description",
    });

    expect(result).toBe(false);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "FN-125",
        error: expect.any(Error),
      }),
    );
  });

  it("Native share: uses task.title when provided, falls back to Task {id} when title is undefined", async () => {
    mockState.isNativePlatform.mockReturnValue(true);
    mockState.nativeShare.mockResolvedValue({ activityType: "copy" });
    const manager = new ShareManager();

    await manager.shareTask({ id: "FN-126", title: "Explicit Title", description: "Body" });
    await manager.shareTask({ id: "FN-127", description: "Body" });

    expect(mockState.nativeShare).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ title: "Explicit Title" }),
    );
    expect(mockState.nativeShare).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ title: "Task FN-127" }),
    );
  });

  it("Native share: constructs correct deep link URL fusion://task/{id}", async () => {
    mockState.isNativePlatform.mockReturnValue(true);
    mockState.nativeShare.mockResolvedValue({ activityType: "copy" });
    const manager = new ShareManager();

    await manager.shareTask({ id: "KB-777", description: "Task body" });

    expect(mockState.nativeShare).toHaveBeenCalledWith(
      expect.objectContaining({ url: "fusion://task/KB-777" }),
    );
  });

  it("Native share: respects custom deepLinkBaseUrl option", async () => {
    mockState.isNativePlatform.mockReturnValue(true);
    mockState.nativeShare.mockResolvedValue({ activityType: "copy" });
    const manager = new ShareManager({ deepLinkBaseUrl: "fusion://project/demo/task/" });

    await manager.shareTask({ id: "FN-201", description: "Task body" });

    expect(mockState.nativeShare).toHaveBeenCalledWith(
      expect.objectContaining({ url: "fusion://project/demo/task/FN-201" }),
    );
  });

  it("Native share: truncates description longer than 200 chars and appends ...", async () => {
    mockState.isNativePlatform.mockReturnValue(true);
    mockState.nativeShare.mockResolvedValue({ activityType: "copy" });
    const manager = new ShareManager();

    await manager.shareTask({ id: "FN-202", description: "a".repeat(201) });

    expect(mockState.nativeShare).toHaveBeenCalledWith(
      expect.objectContaining({ text: `${"a".repeat(200)}...` }),
    );
  });

  it("Web fallback: calls navigator.share() when not native but Web Share API is available", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      share,
      clipboard: {
        writeText: vi.fn(),
      },
    });

    const manager = new ShareManager();
    const result = await manager.shareTask({ id: "FN-203", description: "Body" });

    expect(result).toBe(true);
    expect(share).toHaveBeenCalledWith({
      title: "Task FN-203",
      text: "Body",
      url: "fusion://task/FN-203",
    });
  });

  it("Web fallback: emits share:cancelled when navigator.share() rejects with AbortError", async () => {
    const share = vi.fn().mockRejectedValue({ name: "AbortError" });
    vi.stubGlobal("navigator", {
      share,
      clipboard: {
        writeText: vi.fn(),
      },
    });

    const manager = new ShareManager();
    const onCancelled = vi.fn();
    manager.on("share:cancelled", onCancelled);

    const result = await manager.shareTask({ id: "FN-204", description: "Body" });

    expect(result).toBe(false);
    expect(onCancelled).toHaveBeenCalledWith({ taskId: "FN-204" });
  });

  it("Clipboard fallback: copies deep link URL via navigator.clipboard.writeText() when neither native nor Web Share API", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText,
      },
    });

    const manager = new ShareManager();
    const result = await manager.shareTask({ id: "FN-205", description: "Body" });

    expect(result).toBe(true);
    expect(writeText).toHaveBeenCalledWith("fusion://task/FN-205");
  });

  it("Lifecycle: initialize() succeeds and sets initialized state", async () => {
    const manager = new ShareManager();

    await manager.initialize();

    expect((manager as any).initialized).toBe(true);
  });

  it("Lifecycle: initialize() is idempotent (second call is no-op)", async () => {
    const manager = new ShareManager();

    await manager.initialize();
    await expect(manager.initialize()).resolves.toBeUndefined();

    expect((manager as any).initialized).toBe(true);
  });

  it("Lifecycle: getDeepLinkBaseUrl() returns the configured URL", () => {
    const manager = new ShareManager({ deepLinkBaseUrl: "fusion://custom/" });

    expect(manager.getDeepLinkBaseUrl()).toBe("fusion://custom/");
  });

  it("Lifecycle: destroy() removes all listeners and resets initialized state", async () => {
    const manager = new ShareManager();
    const onSuccess = vi.fn();
    manager.on("share:success", onSuccess);

    await manager.initialize();
    await manager.destroy();

    expect((manager as any).initialized).toBe(false);

    manager.emit("share:success", { taskId: "FN-206" });
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
