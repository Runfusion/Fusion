import html2canvas from "html2canvas";

const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;

export interface CapturedScreenshot {
  blob: Blob;
  previewUrl: string;
}

/**
 * FNXC:ReportPipeline 2026-07-16-10:00:
 * Screenshot capture deliberately snapshots only Fusion's app root, never the
 * display. This avoids collecting other tabs or operating-system windows.
 */
export async function captureAppScreenshot(): Promise<CapturedScreenshot> {
  const root = document.querySelector("#root");
  if (!root) throw new Error("The dashboard view is not available for capture.");
  const canvas = await html2canvas(root as HTMLElement, { scale: 0.75, useCORS: true, logging: false });
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
  if (!blob || blob.size > MAX_SCREENSHOT_BYTES) throw new Error("The screenshot is too large. Try a smaller dashboard view.");
  return { blob, previewUrl: URL.createObjectURL(blob) };
}
