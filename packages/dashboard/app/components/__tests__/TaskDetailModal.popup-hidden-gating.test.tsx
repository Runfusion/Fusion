import { describe, it, expect, vi, afterEach } from "vitest";
import { render, act, waitFor } from "@testing-library/react";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopMove,
  noopOpenDetail,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailContent } from "../TaskDetailModal";
import * as dashboardApi from "../../api";

/*
FNXC:TaskPopupViewGating 2026-07-23-10:30:
FN remount-churn fix follow-up (PR #2420 review): kept-alive hidden popups render TaskDetailContent
with active={false}. While hidden, the detail must not react to document-level image paste (a paste
anywhere in the app used to attach the image to every hidden task) and must not poll the
verification-request endpoint on its 5s interval. Both resume exactly on reveal (active back to
true): paste re-registers, polling refreshes immediately and re-arms the interval.
*/
setupTaskDetailModalHooks();

function renderContent(active: boolean) {
  const props = {
    task: makeTask({ id: "FN-9001" }),
    onMoveTask: noopMove,
    onDeleteTask: noopDelete,
    onMergeTask: noopMerge,
    onOpenDetail: noopOpenDetail,
    addToast: noop,
    initialTab: "definition" as const,
  };
  const view = render(<TaskDetailContent {...props} active={active} />);
  const rerenderWithActive = (nextActive: boolean) =>
    view.rerender(<TaskDetailContent {...props} active={nextActive} />);
  return { ...view, rerenderWithActive };
}

function dispatchImagePaste(file: File) {
  const pasteEvent = new Event("paste", { bubbles: true }) as any;
  pasteEvent.clipboardData = {
    items: [
      {
        type: "image/png",
        getAsFile: () => file,
      },
    ],
  };
  document.dispatchEvent(pasteEvent);
}

describe("TaskDetailContent hidden-popup gating (active=false)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores document image paste while hidden and resumes paste handling on reveal", async () => {
    const mockUpload = vi.mocked(dashboardApi.uploadAttachment);
    mockUpload.mockClear();
    mockUpload.mockResolvedValue({
      filename: "abc123.png",
      originalName: "image.png",
      size: 1024,
      mimeType: "image/png",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const imageFile = new File(["fake-image"], "image.png", { type: "image/png" });

    const { rerenderWithActive } = renderContent(false);

    await act(async () => {
      dispatchImagePaste(imageFile);
    });
    // Hidden popup: the document paste listener must not be registered at all.
    expect(mockUpload).not.toHaveBeenCalled();

    rerenderWithActive(true);
    await act(async () => {
      dispatchImagePaste(imageFile);
    });
    await waitFor(() => {
      expect(mockUpload).toHaveBeenCalledWith("FN-9001", imageFile, undefined);
    });
  });

  it("suspends the 5s verification polling while hidden and resumes it on reveal", async () => {
    vi.useFakeTimers();
    const mockVerification = vi.mocked(dashboardApi.fetchTaskVerificationRequest);
    mockVerification.mockClear();
    mockVerification.mockResolvedValue(null);

    const { rerenderWithActive } = renderContent(false);

    // Hidden popup: neither the initial refresh nor the interval may fire.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_000);
    });
    expect(mockVerification).not.toHaveBeenCalled();

    // Reveal: immediate refresh plus a live 5s interval again.
    rerenderWithActive(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockVerification).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(mockVerification).toHaveBeenCalledTimes(2);

    // Hide again: the interval is torn down.
    rerenderWithActive(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_000);
    });
    expect(mockVerification).toHaveBeenCalledTimes(2);
  });
});
