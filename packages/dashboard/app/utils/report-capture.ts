export interface ReportScreenshot {
  dataUrl: string;
  capturedAt: string;
}

const MAX_ACTIVITY = 20;
const activity: string[] = [];

/**
 * FNXC:ReportPipeline 2026-07-18-12:30:
 * Capture requires a browser-owned display permission prompt and produces one
 * user-reviewed frame. Unsupported or denied capture is an optional capability,
 * so callers receive undefined and may still submit their text report.
 */
export async function captureScreenshot(): Promise<ReportScreenshot | undefined> {
  if (!navigator.mediaDevices?.getDisplayMedia) return undefined;
  let stream: MediaStream | undefined;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const video = document.createElement("video");
    video.srcObject = stream;
    await video.play();
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    return { dataUrl: canvas.toDataURL("image/png"), capturedAt: new Date().toISOString() };
  } catch {
    return undefined;
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
  }
}

/** Record only built-in view labels, never URLs, task ids, or page content. */
export function recordActivity(label: string): void {
  activity.push(label.slice(0, 80));
  while (activity.length > MAX_ACTIVITY) activity.shift();
}

export function getRecentActivity(): string[] {
  return [...activity];
}

export function clearReportActivityForTests(): void {
  activity.length = 0;
}
